import {
  Adjustments,
  BackgroundSettings,
  BgRefinementSettings,
  DEFAULT_ADJUSTMENTS,
  EditState,
  HistogramData,
  HslColorKey,
  LocalAdjustments,
  MaskLayer,
  RetouchOperation,
  TransformState,
} from '../types/editor';
import { decontaminateForegroundColors } from './backgroundSegmentation';
import {
  evaluateMaskLayerBaseAlpha,
  getCachedBaseSourceRgba,
  getMaskRasterDimensions,
  getMaskSourceCacheKey,
  hasNonZeroLocalAdjustments,
  projectMaskToTransformedSpaceWithBounds,
} from './maskEngine';
import { createNativeRetouchedCanvas } from './retouchEngine';
import { buildCurveLUT, hasActiveToneCurve } from './toneCurve';

const MAX_REUSABLE_SCRATCH_PIXELS = 2_500_000;
let scratchFloatA: Float32Array | null = null;
let scratchFloatB: Float32Array | null = null;
let scratchUint8: Uint8ClampedArray | null = null;

function getScratchFloatPair(len: number): [Float32Array, Float32Array] {
  const needed = len * 3;
  if (len <= MAX_REUSABLE_SCRATCH_PIXELS) {
    if (!scratchFloatA || scratchFloatA.length < needed) {
      scratchFloatA = new Float32Array(needed);
    }
    if (!scratchFloatB || scratchFloatB.length < needed) {
      scratchFloatB = new Float32Array(needed);
    }
    return [scratchFloatA, scratchFloatB];
  }
  return [new Float32Array(needed), new Float32Array(needed)];
}

function getScratchRgbaCopy(src: Uint8ClampedArray): Uint8ClampedArray {
  const pixelCount = src.length >> 2;
  if (pixelCount <= MAX_REUSABLE_SCRATCH_PIXELS) {
    if (!scratchUint8 || scratchUint8.length < src.length) {
      scratchUint8 = new Uint8ClampedArray(src.length);
    }
    scratchUint8.set(src);
    return scratchUint8;
  }
  return new Uint8ClampedArray(src);
}

export function releaseProcessorScratchBuffers(): void {
  scratchFloatA = null;
  scratchFloatB = null;
  scratchUint8 = null;
  releaseOversizedSharedMaskWorkCanvas();
}

function clamp(v: number, min = 0, max = 1): number {
  return v < min ? min : v > max ? max : v;
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / Math.max(1e-5, edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Returns dimensions after 90-degree step rotations.
 */
export function getRotatedDimensions(
  srcWidth: number,
  srcHeight: number,
  rotate90: 0 | 1 | 2 | 3
): { width: number; height: number } {
  if (rotate90 % 2 === 1) {
    return { width: srcHeight, height: srcWidth };
  }
  return { width: srcWidth, height: srcHeight };
}

/**
 * Computes final output pixel dimensions for a given source image and transform.
 */
export function getOutputDimensions(
  srcWidth: number,
  srcHeight: number,
  transform: TransformState
): { width: number; height: number } {
  const { width: rotW, height: rotH } = getRotatedDimensions(srcWidth, srcHeight, transform.rotate90);
  const w = Math.max(1, Math.round(rotW * transform.crop.width));
  const h = Math.max(1, Math.round(rotH * transform.crop.height));
  return { width: w, height: h };
}

/**
 * Applies optical & perspective geometry warping (Lens Distortion, Perspective V/H keystone,
 * and Radial Chromatic Aberration removal) via inverse bilinear sampling on workCanvas.
 */
function applyOpticsWarpToCanvas(
  canvas: HTMLCanvasElement,
  transform: TransformState
): void {
  const ld = transform.lensDistortion ?? 0;
  const ca = transform.chromaticAberration ?? 0;
  const pv = transform.perspectiveV ?? 0;
  const ph = transform.perspectiveH ?? 0;
  if (ld === 0 && ca === 0 && pv === 0 && ph === 0) return;

  const w = canvas.width;
  const h = canvas.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return;

  const srcImg = ctx.getImageData(0, 0, w, h);
  const src = srcImg.data;
  const outImg = ctx.createImageData(w, h);
  const dst = outImg.data;

  const halfW = (w - 1) * 0.5;
  const halfH = (h - 1) * 0.5;
  const invHalfW = 1 / Math.max(1, halfW);
  const invHalfH = 1 / Math.max(1, halfH);

  // Positive lensDistortion corrects barrel distortion (pulls corners inward), negative corrects pincushion
  const k = (-ld / 100) * 0.28;
  // Auto zoom slightly when pinching/trapezoiding to avoid black border wedges
  const perspScale =
    1 + Math.abs(pv / 100) * 0.22 + Math.abs(ph / 100) * 0.22 + (ld < 0 ? Math.abs(ld / 100) * 0.16 : 0);
  const perspV = (pv / 100) * 0.32;
  const perspH = (ph / 100) * 0.32;
  const caShift = (ca / 100) * 0.0085;

  const sampleChannel = (fx: number, fy: number, ch: number): number => {
    const cx = clamp(fx, 0, w - 1);
    const cy = clamp(fy, 0, h - 1);
    const x0 = Math.floor(cx);
    const y0 = Math.floor(cy);
    const x1 = x0 < w - 1 ? x0 + 1 : x0;
    const y1 = y0 < h - 1 ? y0 + 1 : y0;
    const tx = cx - x0;
    const ty = cy - y0;

    const i00 = (y0 * w + x0) * 4 + ch;
    const i10 = (y0 * w + x1) * 4 + ch;
    const i01 = (y1 * w + x0) * 4 + ch;
    const i11 = (y1 * w + x1) * 4 + ch;

    const top = src[i00] * (1 - tx) + src[i10] * tx;
    const bot = src[i01] * (1 - tx) + src[i11] * tx;
    return top * (1 - ty) + bot * ty;
  };

  for (let y = 0; y < h; y++) {
    const ny = (y - halfH) * invHalfH;
    for (let x = 0; x < w; x++) {
      const nx = (x - halfW) * invHalfW;

      // 1. Perspective / keystone inverse homography
      const sxBase = nx / perspScale;
      const syBase = ny / perspScale;
      const denom = Math.max(0.28, 1 + perspV * syBase + perspH * sxBase);
      let ux = sxBase / denom;
      let uy = syBase / denom;

      // 2. Radial lens distortion
      const r2 = ux * ux + uy * uy;
      if (k !== 0) {
        const radScale = 1 + k * r2;
        ux *= radScale;
        uy *= radScale;
      }

      const gx = ux * halfW + halfW;
      const gy = uy * halfH + halfH;
      const outIdx = (y * w + x) * 4;

      if (caShift > 0) {
        // Align Red and Blue channels radially toward Green to reduce lateral CA
        const dr = 1 - caShift * r2;
        const db = 1 + caShift * r2;
        const rVal = sampleChannel(ux * dr * halfW + halfW, uy * dr * halfH + halfH, 0);
        const gVal = sampleChannel(gx, gy, 1);
        const bVal = sampleChannel(ux * db * halfW + halfW, uy * db * halfH + halfH, 2);

        // Gentle purple/green color-fringe clamping near high-contrast edges
        const rbAvg = (rVal + bVal) * 0.5;
        const caFrac = clamp(ca / 100, 0, 1) * 0.35;
        const fringing = Math.abs(gVal - rbAvg);
        if (fringing > 28) {
          dst[outIdx] = clamp255(rVal * (1 - caFrac) + gVal * caFrac);
          dst[outIdx + 1] = clamp255(gVal);
          dst[outIdx + 2] = clamp255(bVal * (1 - caFrac) + gVal * caFrac);
        } else {
          dst[outIdx] = clamp255(rVal);
          dst[outIdx + 1] = clamp255(gVal);
          dst[outIdx + 2] = clamp255(bVal);
        }
        dst[outIdx + 3] = clamp255(sampleChannel(gx, gy, 3));
      } else {
        dst[outIdx] = clamp255(sampleChannel(gx, gy, 0));
        dst[outIdx + 1] = clamp255(sampleChannel(gx, gy, 1));
        dst[outIdx + 2] = clamp255(sampleChannel(gx, gy, 2));
        dst[outIdx + 3] = clamp255(sampleChannel(gx, gy, 3));
      }
    }
  }

  ctx.putImageData(outImg, 0, 0);
}

/**
 * Renders geometric transforms (rotate90, straighten with auto-constrain scale,
 * screen-space flipH/flipV, optics/perspective, and optional crop) onto a returned HTMLCanvasElement.
 */
export function renderGeometryCanvas(
  source: HTMLImageElement | HTMLCanvasElement,
  transform: TransformState,
  maxDimension: number | null = 1400,
  applyCrop = true,
  reuseCanvas?: HTMLCanvasElement
): HTMLCanvasElement {
  const srcW = source instanceof HTMLImageElement ? source.naturalWidth : source.width;
  const srcH = source instanceof HTMLImageElement ? source.naturalHeight : source.height;

  const { width: rotW, height: rotH } = getRotatedDimensions(srcW, srcH, transform.rotate90);

  let scale = 1;
  if (maxDimension !== null) {
    const targetRefW = applyCrop ? rotW * transform.crop.width : rotW;
    const targetRefH = applyCrop ? rotH * transform.crop.height : rotH;
    const longest = Math.max(targetRefW, targetRefH);
    if (longest > maxDimension) {
      scale = maxDimension / longest;
    }
  }

  const workW = Math.max(1, Math.round(rotW * scale));
  const workH = Math.max(1, Math.round(rotH * scale));

  const canReuseInPlace =
    reuseCanvas &&
    applyCrop &&
    transform.crop.x <= 0.0005 &&
    transform.crop.y <= 0.0005 &&
    transform.crop.width >= 0.999 &&
    transform.crop.height >= 0.999;

  const workCanvas = canReuseInPlace ? reuseCanvas : document.createElement('canvas');
  if (workCanvas.width !== workW) workCanvas.width = workW;
  if (workCanvas.height !== workH) workCanvas.height = workH;
  const wCtx = workCanvas.getContext('2d', { willReadFrequently: true });
  if (!wCtx) return workCanvas;
  if (canReuseInPlace) {
    wCtx.clearRect(0, 0, workW, workH);
  }

  wCtx.imageSmoothingEnabled = true;
  wCtx.imageSmoothingQuality = 'high';

  wCtx.save();
  wCtx.translate(workW / 2, workH / 2);

  if (transform.straighten !== 0) {
    const rad = (transform.straighten * Math.PI) / 180;
    const cos = Math.abs(Math.cos(rad));
    const sin = Math.abs(Math.sin(rad));
    const autoScale = Math.max(
      (workW * cos + workH * sin) / workW,
      (workW * sin + workH * cos) / workH
    );
    wCtx.scale(autoScale, autoScale);
    wCtx.rotate(rad);
  }

  if (transform.flipH || transform.flipV) {
    wCtx.scale(transform.flipH ? -1 : 1, transform.flipV ? -1 : 1);
  }

  if (transform.rotate90 !== 0) {
    wCtx.rotate((transform.rotate90 * Math.PI) / 2);
  }

  const preRotW = transform.rotate90 % 2 === 1 ? workH : workW;
  const preRotH = transform.rotate90 % 2 === 1 ? workW : workH;
  wCtx.drawImage(source, -preRotW / 2, -preRotH / 2, preRotW, preRotH);
  wCtx.restore();

  // Apply Lens Distortion, Chromatic Aberration, and Perspective Corrections
  applyOpticsWarpToCanvas(workCanvas, transform);

  if (!applyCrop) {
    return workCanvas;
  }

  const isFullCrop =
    transform.crop.x <= 0.0005 &&
    transform.crop.y <= 0.0005 &&
    transform.crop.width >= 0.999 &&
    transform.crop.height >= 0.999;

  if (isFullCrop) {
    return workCanvas;
  }

  const cx = Math.max(0, Math.round(transform.crop.x * workW));
  const cy = Math.max(0, Math.round(transform.crop.y * workH));
  const cw = Math.max(1, Math.min(workW - cx, Math.round(transform.crop.width * workW)));
  const ch = Math.max(1, Math.min(workH - cy, Math.round(transform.crop.height * workH)));

  const cropCanvas = reuseCanvas ?? document.createElement('canvas');
  if (cropCanvas.width !== cw) cropCanvas.width = cw;
  if (cropCanvas.height !== ch) cropCanvas.height = ch;
  const cCtx = cropCanvas.getContext('2d', { willReadFrequently: true });
  if (!cCtx) return workCanvas;

  if (reuseCanvas) {
    cCtx.clearRect(0, 0, cw, ch);
  }
  cCtx.drawImage(workCanvas, cx, cy, cw, ch, 0, 0, cw, ch);
  workCanvas.width = 0;
  workCanvas.height = 0;
  return cropCanvas;
}

/**
 * Fast separable horizontal + vertical box blur on RGB uint8 arrays using bounded scratch pools.
 */
function boxBlurRGB(src: Uint8ClampedArray, width: number, height: number, radius: number): Float32Array {
  const len = width * height;
  const [tmp, dst] = getScratchFloatPair(len);
  const r = Math.max(1, radius);
  const windowSize = r * 2 + 1;

  for (let y = 0; y < height; y++) {
    const rowOff = y * width;
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;

    for (let kx = -r; kx <= r; kx++) {
      const sx = kx < 0 ? 0 : kx >= width ? width - 1 : kx;
      const idx = (rowOff + sx) * 4;
      sumR += src[idx];
      sumG += src[idx + 1];
      sumB += src[idx + 2];
    }

    for (let x = 0; x < width; x++) {
      const outIdx = (rowOff + x) * 3;
      tmp[outIdx] = sumR / windowSize;
      tmp[outIdx + 1] = sumG / windowSize;
      tmp[outIdx + 2] = sumB / windowSize;

      const leftX = x - r < 0 ? 0 : x - r;
      const rightX = x + r + 1 >= width ? width - 1 : x + r + 1;
      const lIdx = (rowOff + leftX) * 4;
      const rIdx = (rowOff + rightX) * 4;

      sumR += src[rIdx] - src[lIdx];
      sumG += src[rIdx + 1] - src[lIdx + 1];
      sumB += src[rIdx + 2] - src[lIdx + 2];
    }
  }

  for (let x = 0; x < width; x++) {
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;

    for (let ky = -r; ky <= r; ky++) {
      const sy = ky < 0 ? 0 : ky >= height ? height - 1 : ky;
      const idx = (sy * width + x) * 3;
      sumR += tmp[idx];
      sumG += tmp[idx + 1];
      sumB += tmp[idx + 2];
    }

    for (let y = 0; y < height; y++) {
      const outIdx = (y * width + x) * 3;
      dst[outIdx] = sumR / windowSize;
      dst[outIdx + 1] = sumG / windowSize;
      dst[outIdx + 2] = sumB / windowSize;

      const topY = y - r < 0 ? 0 : y - r;
      const botY = y + r + 1 >= height ? height - 1 : y + r + 1;
      const tIdx = (topY * width + x) * 3;
      const bIdx = (botY * width + x) * 3;

      sumR += tmp[bIdx] - tmp[tIdx];
      sumG += tmp[bIdx + 1] - tmp[tIdx + 1];
      sumB += tmp[bIdx + 2] - tmp[tIdx + 2];
    }
  }

  return dst;
}

function spatialNoise(x: number, y: number): number {
  let n = (x * 374761393 + y * 668265263) ^ 0x5bf03635;
  n = (n ^ (n >> 13)) * 1274126177;
  n = n ^ (n >> 16);
  return ((n & 0xffff) / 32767.5) - 1.0;
}

const HSL_ORDER: { key: HslColorKey; centerDeg: number; halfWidth: number }[] = [
  { key: 'red', centerDeg: 0, halfWidth: 32 },
  { key: 'orange', centerDeg: 30, halfWidth: 28 },
  { key: 'yellow', centerDeg: 60, halfWidth: 32 },
  { key: 'green', centerDeg: 120, halfWidth: 48 },
  { key: 'aqua', centerDeg: 180, halfWidth: 42 },
  { key: 'blue', centerDeg: 240, halfWidth: 42 },
  { key: 'purple', centerDeg: 280, halfWidth: 32 },
  { key: 'magenta', centerDeg: 320, halfWidth: 36 },
];

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const max = r > g ? (r > b ? r : b) : g > b ? g : b;
  const min = r < g ? (r < b ? r : b) : g < b ? g : b;
  const l = (max + min) * 0.5;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}

function hue2rgb(p: number, q: number, t: number): number {
  let tt = t;
  if (tt < 0) tt += 1;
  if (tt > 1) tt -= 1;
  if (tt < 1 / 6) return p + (q - p) * 6 * tt;
  if (tt < 1 / 2) return q;
  if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
  return p;
}

function hslToRgb(hDeg: number, s: number, l: number): [number, number, number] {
  const h = (((hDeg % 360) + 360) % 360) / 360;
  if (s <= 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue2rgb(p, q, h + 1 / 3), hue2rgb(p, q, h), hue2rgb(p, q, h - 1 / 3)];
}

export function hasNonZeroHsl(adj: Adjustments): boolean {
  if (!adj.hsl) return false;
  return HSL_ORDER.some((b) => {
    const band = adj.hsl[b.key];
    return band && (band.h !== 0 || band.s !== 0 || band.l !== 0);
  });
}

export function hasNonZeroColorGrading(adj: Adjustments): boolean {
  const cg = adj.colorGrading;
  if (!cg) return false;
  return (
    cg.shadows.sat > 0 ||
    cg.shadows.lum !== 0 ||
    cg.midtones.sat > 0 ||
    cg.midtones.lum !== 0 ||
    cg.highlights.sat > 0 ||
    cg.highlights.lum !== 0
  );
}

export function hasNonZeroAdjustments(adj: Adjustments): boolean {
  return (
    adj.exposure !== 0 ||
    adj.brightness !== 0 ||
    adj.contrast !== 0 ||
    adj.highlights !== 0 ||
    adj.shadows !== 0 ||
    (adj.whites ?? 0) !== 0 ||
    (adj.blacks ?? 0) !== 0 ||
    hasActiveToneCurve(adj.toneCurve) ||
    adj.temperature !== 0 ||
    adj.tint !== 0 ||
    adj.saturation !== 0 ||
    adj.vibrance !== 0 ||
    hasNonZeroHsl(adj) ||
    hasNonZeroColorGrading(adj) ||
    (adj.texture ?? 0) !== 0 ||
    adj.clarity !== 0 ||
    (adj.dehaze ?? 0) !== 0 ||
    adj.sharpness !== 0 ||
    (adj.luminanceNR ?? 0) !== 0 ||
    (adj.colorNR ?? 0) !== 0 ||
    adj.vignette !== 0 ||
    adj.grain !== 0 ||
    adj.fade !== 0 ||
    adj.splitTone !== 'none' ||
    Boolean(adj.lut && adj.lutIntensity > 0)
  );
}

const LARGE_ADJUSTMENT_PIXELS = 4_000_000;
const ADJUSTMENT_STRIP_HEIGHT = 512;
const ADJUSTMENT_STRIP_PAD = 24;

function adjustmentsNeedSpatialPadding(adj: Adjustments): boolean {
  return (
    (adj.colorNR ?? 0) > 0 ||
    (adj.luminanceNR ?? 0) > 0 ||
    (adj.texture ?? 0) !== 0 ||
    adj.clarity !== 0 ||
    adj.sharpness > 0
  );
}

export function hasHeavySpatialAdjustments(adj: Adjustments): boolean {
  return (
    (adj.colorNR ?? 0) > 0 ||
    (adj.luminanceNR ?? 0) > 0 ||
    (adj.texture ?? 0) !== 0 ||
    adj.clarity !== 0 ||
    adj.sharpness > 0 ||
    hasNonZeroHsl(adj) ||
    Boolean(adj.lut && adj.lutIntensity > 0)
  );
}

/**
 * Applies full RAW-style color, tone, curves, HSL mixer, 3-way color grading,
 * texture, clarity, dehaze, noise reduction, sharpening, vignette, and grain pipeline
 * onto a raw RGBA pixel buffer (supports strip-based execution with global coordinates).
 */
function applyAdjustmentsToBuffer(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  adj: Adjustments,
  globalOffsetY = 0,
  globalWidth = width,
  globalHeight = height
): void {
  const len = width * height;

  // Pass 0a: Color Noise Reduction (YCbCr chroma smoothing before color/tonal boost)
  const cnr = adj.colorNR ?? 0;
  if (cnr > 0 && width >= 4 && height >= 4) {
    const blurRad = cnr > 55 ? 2 : 1;
    const chromaBlur = boxBlurRGB(data, width, height, blurRad);
    const cnrBlend = clamp(cnr / 100, 0, 1) * 0.9;
    for (let i = 0; i < len; i++) {
      const idx = i * 4;
      const bIdx = i * 3;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      const origL = 0.299 * r + 0.587 * g + 0.114 * b;

      const br = chromaBlur[bIdx];
      const bg = chromaBlur[bIdx + 1];
      const bb = chromaBlur[bIdx + 2];
      const blurL = 0.299 * br + 0.587 * bg + 0.114 * bb;
      const dL = origL - blurL;

      data[idx] = clamp255(r * (1 - cnrBlend) + (br + dL) * cnrBlend);
      data[idx + 1] = clamp255(g * (1 - cnrBlend) + (bg + dL) * cnrBlend);
      data[idx + 2] = clamp255(b * (1 - cnrBlend) + (bb + dL) * cnrBlend);
    }
  }

  // Pass 0b: Luminance Noise Reduction (edge-preserving 3x3 bilateral smooth)
  const lnr = adj.luminanceNR ?? 0;
  if (lnr > 0 && width >= 3 && height >= 3) {
    const copy = getScratchRgbaCopy(data);
    const blendAmt = clamp(lnr / 100, 0, 1) * 0.85;
    const rangeSigma = 12 + lnr * 0.55;
    const invTwoSig2 = 1 / (2 * rangeSigma * rangeSigma);

    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const cIdx = (y * width + x) * 4;
        const cLum = 0.299 * copy[cIdx] + 0.587 * copy[cIdx + 1] + 0.114 * copy[cIdx + 2];
        let sumR = 0;
        let sumG = 0;
        let sumB = 0;
        let wSum = 0;

        for (let oy = -1; oy <= 1; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            const sIdx = ((y + oy) * width + (x + ox)) * 4;
            const sLum = 0.299 * copy[sIdx] + 0.587 * copy[sIdx + 1] + 0.114 * copy[sIdx + 2];
            const dL = cLum - sLum;
            const w = Math.exp(-(dL * dL) * invTwoSig2);
            sumR += copy[sIdx] * w;
            sumG += copy[sIdx + 1] * w;
            sumB += copy[sIdx + 2] * w;
            wSum += w;
          }
        }
        const fR = sumR / wSum;
        const fG = sumG / wSum;
        const fB = sumB / wSum;
        data[cIdx] = clamp255(copy[cIdx] * (1 - blendAmt) + fR * blendAmt);
        data[cIdx + 1] = clamp255(copy[cIdx + 1] * (1 - blendAmt) + fG * blendAmt);
        data[cIdx + 2] = clamp255(copy[cIdx + 2] * (1 - blendAmt) + fB * blendAmt);
      }
    }
  }

  // Pass 1: Per-pixel tonal & color grading
  const temp = adj.temperature / 100;
  const tint = adj.tint / 100;
  const wbR = 1 + temp * 0.22 + tint * 0.08;
  const wbG = 1 - tint * 0.14 + temp * 0.015;
  const wbB = 1 - temp * 0.22 + tint * 0.08;

  const expMult = Math.pow(2, adj.exposure / 55);
  const brightShift = (adj.brightness / 100) * 0.26;
  const highAmt = (adj.highlights / 100) * 0.48;
  const shadAmt = (adj.shadows / 100) * 0.48;
  const whitesAmt = ((adj.whites ?? 0) / 100) * 0.36;
  const blacksAmt = ((adj.blacks ?? 0) / 100) * 0.32;

  const cNorm = adj.contrast / 100;
  const contrastFactor = cNorm >= 0 ? 1 + cNorm * 0.9 : 1 + cNorm * 0.65;
  const fadeAmt = (adj.fade / 100) * 0.16;

  const satNorm = adj.saturation / 100;
  const vibNorm = adj.vibrance / 100;

  const useToneCurve = hasActiveToneCurve(adj.toneCurve);
  const rgbLut = useToneCurve ? buildCurveLUT(adj.toneCurve.rgb) : null;
  const rLut = useToneCurve ? buildCurveLUT(adj.toneCurve.red) : null;
  const gLut = useToneCurve ? buildCurveLUT(adj.toneCurve.green) : null;
  const bLut = useToneCurve ? buildCurveLUT(adj.toneCurve.blue) : null;

  const useHsl = hasNonZeroHsl(adj);
  const useColorGrading = hasNonZeroColorGrading(adj);
  const cg = adj.colorGrading;
  let cgShRgb: [number, number, number] = [0, 0, 0];
  let cgMidRgb: [number, number, number] = [0, 0, 0];
  let cgHiRgb: [number, number, number] = [0, 0, 0];
  if (useColorGrading && cg) {
    cgShRgb = hslToRgb(cg.shadows.hue, clamp(cg.shadows.sat / 100, 0, 1), 0.5);
    cgMidRgb = hslToRgb(cg.midtones.hue, clamp(cg.midtones.sat / 100, 0, 1), 0.5);
    cgHiRgb = hslToRgb(cg.highlights.hue, clamp(cg.highlights.sat / 100, 0, 1), 0.5);
  }

  const dehazeAmt = (adj.dehaze ?? 0) / 100;

  const splitMode = adj.splitTone;
  const activeLut = adj.lut && adj.lutIntensity > 0 ? adj.lut : null;
  const lutMix = activeLut ? clamp(adj.lutIntensity / 100, 0, 1) : 0;
  const lutSize = activeLut ? activeLut.size : 0;
  const lutMaxIdx = lutSize - 1;
  const lutTable = activeLut ? activeLut.table : null;
  const lutDMinR = activeLut ? activeLut.domainMin[0] : 0;
  const lutDMinG = activeLut ? activeLut.domainMin[1] : 0;
  const lutDMinB = activeLut ? activeLut.domainMin[2] : 0;
  const lutSpanR = activeLut ? Math.max(1e-5, activeLut.domainMax[0] - lutDMinR) : 1;
  const lutSpanG = activeLut ? Math.max(1e-5, activeLut.domainMax[1] - lutDMinG) : 1;
  const lutSpanB = activeLut ? Math.max(1e-5, activeLut.domainMax[2] - lutDMinB) : 1;

  for (let i = 0; i < len; i++) {
    const idx = i * 4;
    let r = data[idx] / 255;
    let g = data[idx + 1] / 255;
    let b = data[idx + 2] / 255;

    // 1. White balance
    if (temp !== 0 || tint !== 0) {
      r *= wbR;
      g *= wbG;
      b *= wbB;
    }

    // 2. Exposure with gentle highlight shoulder
    if (adj.exposure !== 0) {
      r *= expMult;
      g *= expMult;
      b *= expMult;
      if (expMult > 1) {
        if (r > 0.84) r = 0.84 + 0.16 * Math.tanh((r - 0.84) / 0.35);
        if (g > 0.84) g = 0.84 + 0.16 * Math.tanh((g - 0.84) / 0.35);
        if (b > 0.84) b = 0.84 + 0.16 * Math.tanh((b - 0.84) / 0.35);
      }
    }

    // 3. Brightness
    if (brightShift !== 0) {
      r += brightShift * (1 - clamp(r) * 0.28);
      g += brightShift * (1 - clamp(g) * 0.28);
      b += brightShift * (1 - clamp(b) * 0.28);
    }

    r = clamp(r);
    g = clamp(g);
    b = clamp(b);

    // 4. Highlights, Shadows, Whites, Blacks
    if (highAmt !== 0 || shadAmt !== 0 || whitesAmt !== 0 || blacksAmt !== 0) {
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const hw = smoothstep(0.42, 1.0, lum);
      const sw = 1 - smoothstep(0.0, 0.58, lum);
      const ww = smoothstep(0.65, 1.0, lum);
      const bw = 1 - smoothstep(0.0, 0.32, lum);
      const delta = highAmt * hw + shadAmt * sw + whitesAmt * ww + blacksAmt * bw;
      if (delta !== 0) {
        if (delta > 0) {
          r += delta * (1 - r) * 0.85;
          g += delta * (1 - g) * 0.85;
          b += delta * (1 - b) * 0.85;
        } else {
          r += delta * (0.18 + 0.82 * r);
          g += delta * (0.18 + 0.82 * g);
          b += delta * (0.18 + 0.82 * b);
        }
      }
      r = clamp(r);
      g = clamp(g);
      b = clamp(b);
    }

    // 4b. Atmospheric Dehaze (dark-channel haze removal/addition)
    if (dehazeAmt !== 0) {
      const dark = Math.min(r, g, b);
      if (dehazeAmt > 0) {
        const strength = dehazeAmt * 0.72;
        const airlight = 0.94;
        const t = Math.max(0.24, 1 - strength * (dark / airlight));
        r = clamp((r - airlight) / t + airlight);
        g = clamp((g - airlight) / t + airlight);
        b = clamp((b - airlight) / t + airlight);
        // Restore subtle midtone punch
        r = clamp(0.5 + (r - 0.5) * (1 + dehazeAmt * 0.22));
        g = clamp(0.5 + (g - 0.5) * (1 + dehazeAmt * 0.22));
        b = clamp(0.5 + (b - 0.5) * (1 + dehazeAmt * 0.22));
      } else {
        const haze = -dehazeAmt * 0.55;
        r = clamp(r * (1 - haze) + 0.92 * haze);
        g = clamp(g * (1 - haze) + 0.93 * haze);
        b = clamp(b * (1 - haze) + 0.96 * haze);
      }
    }

    // 5. Contrast
    if (adj.contrast !== 0) {
      r = 0.5 + (r - 0.5) * contrastFactor;
      g = 0.5 + (g - 0.5) * contrastFactor;
      b = 0.5 + (b - 0.5) * contrastFactor;
    }

    // 6. Film fade
    if (fadeAmt > 0) {
      r = fadeAmt + r * (1 - fadeAmt);
      g = fadeAmt + g * (1 - fadeAmt);
      b = fadeAmt + b * (1 - fadeAmt);
    }

    r = clamp(r);
    g = clamp(g);
    b = clamp(b);

    // 6b. Tone Curve (RGB Master + Individual Red/Green/Blue channels)
    if (useToneCurve && rgbLut && rLut && gLut && bLut) {
      r = rgbLut[Math.round(r * 255)];
      g = rgbLut[Math.round(g * 255)];
      b = rgbLut[Math.round(b * 255)];
      r = rLut[Math.round(r * 255)];
      g = gLut[Math.round(g * 255)];
      b = bLut[Math.round(b * 255)];
    }

    // 7. Split toning & 3-Way Color Grading
    if (splitMode !== 'none') {
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const sw = (1 - lum) * (1 - lum);
      const hw = lum * lum;
      if (splitMode === 'cinematic') {
        r += -0.045 * sw + 0.055 * hw;
        g += 0.015 * sw + 0.02 * hw;
        b += 0.055 * sw - 0.045 * hw;
      } else if (splitMode === 'moody') {
        r += -0.03 * sw + 0.03 * hw;
        g += 0.005 * sw + 0.01 * hw;
        b += 0.055 * sw - 0.02 * hw;
      } else if (splitMode === 'vintage') {
        r += -0.01 * sw + 0.065 * hw;
        g += 0.025 * sw + 0.03 * hw;
        b += 0.025 * sw - 0.055 * hw;
      } else if (splitMode === 'golden') {
        const mw = Math.sin(lum * Math.PI);
        r += 0.075 * hw + 0.03 * mw;
        g += 0.035 * hw + 0.015 * mw;
        b += -0.055 * hw - 0.025 * mw;
      }
      r = clamp(r);
      g = clamp(g);
      b = clamp(b);
    }

    if (useColorGrading && cg) {
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const balShift = clamp(0.5 - (cg.balance / 100) * 0.32, 0.15, 0.85);
      const overlap = 0.18 + (cg.blending / 100) * 0.34;
      const shW = 1 - smoothstep(balShift - overlap, balShift + overlap * 0.4, lum);
      const hiW = smoothstep(balShift - overlap * 0.4, balShift + overlap, lum);
      const midW = clamp(1 - Math.abs(lum - balShift) / Math.max(0.22, overlap * 1.3), 0, 1);

      if (cg.shadows.sat > 0 || cg.shadows.lum !== 0) {
        const amt = (cg.shadows.sat / 100) * 0.28 * shW;
        const lOff = (cg.shadows.lum / 100) * 0.16 * shW;
        r += (cgShRgb[0] - 0.5) * amt + lOff;
        g += (cgShRgb[1] - 0.5) * amt + lOff;
        b += (cgShRgb[2] - 0.5) * amt + lOff;
      }
      if (cg.midtones.sat > 0 || cg.midtones.lum !== 0) {
        const amt = (cg.midtones.sat / 100) * 0.24 * midW;
        const lOff = (cg.midtones.lum / 100) * 0.15 * midW;
        r += (cgMidRgb[0] - 0.5) * amt + lOff;
        g += (cgMidRgb[1] - 0.5) * amt + lOff;
        b += (cgMidRgb[2] - 0.5) * amt + lOff;
      }
      if (cg.highlights.sat > 0 || cg.highlights.lum !== 0) {
        const amt = (cg.highlights.sat / 100) * 0.28 * hiW;
        const lOff = (cg.highlights.lum / 100) * 0.16 * hiW;
        r += (cgHiRgb[0] - 0.5) * amt + lOff;
        g += (cgHiRgb[1] - 0.5) * amt + lOff;
        b += (cgHiRgb[2] - 0.5) * amt + lOff;
      }
      r = clamp(r);
      g = clamp(g);
      b = clamp(b);
    }

    // 7b. 3D LUT color grading
    if (lutTable && lutMix > 0) {
      const fr = clamp((r - lutDMinR) / lutSpanR, 0, 1) * lutMaxIdx;
      const fg = clamp((g - lutDMinG) / lutSpanG, 0, 1) * lutMaxIdx;
      const fb = clamp((b - lutDMinB) / lutSpanB, 0, 1) * lutMaxIdx;

      const r0 = Math.floor(fr);
      const g0 = Math.floor(fg);
      const b0 = Math.floor(fb);
      const r1 = r0 < lutMaxIdx ? r0 + 1 : lutMaxIdx;
      const g1 = g0 < lutMaxIdx ? g0 + 1 : lutMaxIdx;
      const b1 = b0 < lutMaxIdx ? b0 + 1 : lutMaxIdx;

      const dr = fr - r0;
      const dg = fg - g0;
      const db = fb - b0;

      const s1 = lutSize;
      const s2 = lutSize * lutSize;
      const i000 = (b0 * s2 + g0 * s1 + r0) * 3;
      const i100 = (b0 * s2 + g0 * s1 + r1) * 3;
      const i010 = (b0 * s2 + g1 * s1 + r0) * 3;
      const i110 = (b0 * s2 + g1 * s1 + r1) * 3;
      const i001 = (b1 * s2 + g0 * s1 + r0) * 3;
      const i101 = (b1 * s2 + g0 * s1 + r1) * 3;
      const i011 = (b1 * s2 + g1 * s1 + r0) * 3;
      const i111 = (b1 * s2 + g1 * s1 + r1) * 3;

      const invR = 1 - dr;
      const invG = 1 - dg;
      const invB = 1 - db;

      const lr =
        (lutTable[i000] * invR + lutTable[i100] * dr) * invG * invB +
        (lutTable[i010] * invR + lutTable[i110] * dr) * dg * invB +
        (lutTable[i001] * invR + lutTable[i101] * dr) * invG * db +
        (lutTable[i011] * invR + lutTable[i111] * dr) * dg * db;

      const lg =
        (lutTable[i000 + 1] * invR + lutTable[i100 + 1] * dr) * invG * invB +
        (lutTable[i010 + 1] * invR + lutTable[i110 + 1] * dr) * dg * invB +
        (lutTable[i001 + 1] * invR + lutTable[i101 + 1] * dr) * invG * db +
        (lutTable[i011 + 1] * invR + lutTable[i111 + 1] * dr) * dg * db;

      const lb =
        (lutTable[i000 + 2] * invR + lutTable[i100 + 2] * dr) * invG * invB +
        (lutTable[i010 + 2] * invR + lutTable[i110 + 2] * dr) * dg * invB +
        (lutTable[i001 + 2] * invR + lutTable[i101 + 2] * dr) * invG * db +
        (lutTable[i011 + 2] * invR + lutTable[i111 + 2] * dr) * dg * db;

      r = r + (lr - r) * lutMix;
      g = g + (lg - g) * lutMix;
      b = b + (lb - b) * lutMix;
    }

    // 7c. 8-Band HSL Mixer
    if (useHsl) {
      const [hDeg, sHsl, lHsl] = rgbToHsl(r, g, b);
      if (sHsl > 0.025) {
        let dH = 0;
        let dS = 0;
        let dL = 0;
        for (let bi = 0; bi < HSL_ORDER.length; bi++) {
          const band = HSL_ORDER[bi];
          const val = adj.hsl[band.key];
          if (val.h === 0 && val.s === 0 && val.l === 0) continue;
          let diff = Math.abs(hDeg - band.centerDeg);
          if (diff > 180) diff = 360 - diff;
          if (diff < band.halfWidth) {
            const w = Math.cos((diff / band.halfWidth) * (Math.PI * 0.5));
            const w2 = w * w;
            dH += (val.h / 100) * 32 * w2;
            dS += (val.s / 100) * w2;
            dL += (val.l / 100) * 0.35 * w2;
          }
        }
        if (dH !== 0 || dS !== 0 || dL !== 0) {
          const nextH = hDeg + dH;
          const nextS = clamp(dS >= 0 ? sHsl + (1 - sHsl) * dS : sHsl * (1 + dS), 0, 1);
          const nextL = clamp(
            dL >= 0 ? lHsl + (1 - lHsl) * dL * 0.75 : lHsl * (1 + dL),
            0,
            1
          );
          const [nr, ng, nb] = hslToRgb(nextH, nextS, nextL);
          const satFade = smoothstep(0.025, 0.14, sHsl);
          r = r + (nr - r) * satFade;
          g = g + (ng - g) * satFade;
          b = b + (nb - b) * satFade;
        }
      }
    }

    // 8. Vibrance & Saturation
    if (satNorm !== 0 || vibNorm !== 0) {
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const maxC = r > g ? (r > b ? r : b) : g > b ? g : b;
      const minC = r < g ? (r < b ? r : b) : g < b ? g : b;
      const curSat = maxC - minC;

      let vibGain = 0;
      if (vibNorm !== 0) {
        const skinProtect = r > g && g > b ? 0.65 : 1.0;
        vibGain = vibNorm * (1 - curSat) * skinProtect;
      }

      const satMult = Math.max(0, (1 + satNorm) * (1 + vibGain));
      r = luma + (r - luma) * satMult;
      g = luma + (g - luma) * satMult;
      b = luma + (b - luma) * satMult;
    }

    data[idx] = clamp255(r * 255);
    data[idx + 1] = clamp255(g * 255);
    data[idx + 2] = clamp255(b * 255);
  }

  // Pass 2a: Spatial Texture (medium-fine surface bandpass detail)
  const texAmt = adj.texture ?? 0;
  if (texAmt !== 0 && width >= 4 && height >= 4) {
    const texRadius = Math.max(1, Math.min(4, Math.round(Math.min(globalWidth, globalHeight) * 0.0035)));
    const blurredTex = boxBlurRGB(data, width, height, texRadius);
    const texStr = (texAmt / 100) * 0.72;
    for (let i = 0; i < len; i++) {
      const idx = i * 4;
      const bIdx = i * 3;
      const dr = data[idx] - blurredTex[bIdx];
      const dg = data[idx + 1] - blurredTex[bIdx + 1];
      const db = data[idx + 2] - blurredTex[bIdx + 2];
      // Prevent harsh clipping on extreme contrast edges
      const edgeDamp = Math.abs(dr) + Math.abs(dg) + Math.abs(db) > 120 ? 0.45 : 1.0;
      const k = texStr * edgeDamp;
      data[idx] = clamp255(data[idx] + k * dr);
      data[idx + 1] = clamp255(data[idx + 1] + k * dg);
      data[idx + 2] = clamp255(data[idx + 2] + k * db);
    }
  }

  // Pass 2b: Spatial Clarity (wide local midtone contrast)
  if (adj.clarity !== 0 && width >= 4 && height >= 4) {
    const clarityRadius = Math.max(3, Math.min(14, Math.round(Math.min(globalWidth, globalHeight) * 0.012)));
    const blurred = boxBlurRGB(data, width, height, clarityRadius);
    const clarityStrength = (adj.clarity / 100) * 0.8;

    for (let i = 0; i < len; i++) {
      const idx = i * 4;
      const bIdx = i * 3;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      const midMask = 4 * lum * (1 - lum);
      const amt = clarityStrength * midMask;

      data[idx] = clamp255(r + amt * (r - blurred[bIdx]));
      data[idx + 1] = clamp255(g + amt * (g - blurred[bIdx + 1]));
      data[idx + 2] = clamp255(b + amt * (b - blurred[bIdx + 2]));
    }
  }

  // Pass 3: Spatial Sharpness (3x3 unsharp mask)
  if (adj.sharpness > 0 && width >= 3 && height >= 3) {
    const sharpAmount = (adj.sharpness / 100) * 0.95;
    const copy = getScratchRgbaCopy(data);
    const rowStride = width * 4;

    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const idx = (y * width + x) * 4;
        const top = idx - rowStride;
        const bot = idx + rowStride;
        const left = idx - 4;
        const right = idx + 4;

        for (let c = 0; c < 3; c++) {
          const center = copy[idx + c];
          const avg = (copy[top + c] + copy[bot + c] + copy[left + c] + copy[right + c]) * 0.25;
          data[idx + c] = clamp255(center + sharpAmount * (center - avg));
        }
      }
    }
  }

  // Pass 4: Vignette & Film Grain (using global coordinates for exact strip/tile consistency)
  if (adj.vignette !== 0 || adj.grain > 0) {
    const vigNorm = adj.vignette / 100;
    const grainStrength = (adj.grain / 100) * 34;
    const invHalfW = 2 / globalWidth;
    const invHalfH = 2 / globalHeight;

    for (let y = 0; y < height; y++) {
      const gy = globalOffsetY + y;
      const dy = gy * invHalfH - 1;
      const dy2 = dy * dy;

      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 4;
        let r = data[idx];
        let g = data[idx + 1];
        let b = data[idx + 2];

        if (vigNorm !== 0) {
          const dx = x * invHalfW - 1;
          const dist = Math.sqrt(dx * dx + dy2) * 0.70710678;
          const mask = smoothstep(0.32, 1.05, dist);
          if (vigNorm < 0) {
            const mult = 1 + vigNorm * 0.85 * mask;
            r *= mult;
            g *= mult;
            b *= mult;
          } else {
            const lift = vigNorm * 110 * mask;
            r += lift;
            g += lift;
            b += lift;
          }
        }

        if (grainStrength > 0) {
          const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
          const midWeight = 0.4 + 0.6 * (4 * lum * (1 - lum));
          const n = spatialNoise(x, gy) * grainStrength * midWeight;
          r += n;
          g += n;
          b += n;
        }

        data[idx] = clamp255(r);
        data[idx + 1] = clamp255(g);
        data[idx + 2] = clamp255(b);
      }
    }
  }
}

/**
 * Applies full RAW-style color, tone, curves, HSL mixer, 3-way color grading,
 * texture, clarity, dehaze, noise reduction, sharpening, vignette, and grain pipeline
 * in-place on the provided Canvas 2D context. Uses bounded strip/tile processing when
 * pixel count exceeds 4MP to keep RAM usage safe on full-resolution mobile/desktop exports.
 */
export function applyAdjustmentsToCanvas(
  canvas: HTMLCanvasElement,
  adj: Adjustments,
  returnImageData = true
): ImageData {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    throw new Error('Could not obtain 2D context');
  }
  const width = canvas.width;
  const height = canvas.height;

  if (!hasNonZeroAdjustments(adj)) {
    return returnImageData ? ctx.getImageData(0, 0, width, height) : new ImageData(1, 1);
  }

  if (width * height <= LARGE_ADJUSTMENT_PIXELS) {
    const imageData = ctx.getImageData(0, 0, width, height);
    applyAdjustmentsToBuffer(imageData.data, width, height, adj, 0, width, height);
    ctx.putImageData(imageData, 0, 0);
    return imageData;
  }

  // Strip/tile processing for high-resolution exports (> 4MP) with unedited top-border pad preservation
  const pad = adjustmentsNeedSpatialPadding(adj) ? ADJUSTMENT_STRIP_PAD : 0;
  const rowStride = width * 4;
  let prevTopPad: Uint8ClampedArray | null = null;
  let prevTopPadRows = 0;

  for (let y0 = 0; y0 < height; y0 += ADJUSTMENT_STRIP_HEIGHT) {
    const innerH = Math.min(ADJUSTMENT_STRIP_HEIGHT, height - y0);
    const padTop = prevTopPad ? Math.min(pad, prevTopPadRows) : 0;
    const padBot = pad > 0 ? Math.min(pad, height - (y0 + innerH)) : 0;
    const readH = innerH + padBot;
    const stripH = padTop + readH;

    const uneditedRead = ctx.getImageData(0, y0, width, readH).data;
    const stripData = new Uint8ClampedArray(rowStride * stripH);

    if (padTop > 0 && prevTopPad) {
      const topSrcOffset = (prevTopPadRows - padTop) * rowStride;
      stripData.set(prevTopPad.subarray(topSrcOffset, topSrcOffset + padTop * rowStride), 0);
    }
    stripData.set(uneditedRead, padTop * rowStride);

    // Preserve bottom `pad` unmodified rows of this inner strip for the next strip's top padding
    let nextTopPad: Uint8ClampedArray | null = null;
    let nextTopPadRows = 0;
    if (pad > 0 && y0 + innerH < height) {
      nextTopPadRows = Math.min(pad, innerH);
      const startRow = innerH - nextTopPadRows;
      nextTopPad = new Uint8ClampedArray(
        uneditedRead.subarray(startRow * rowStride, innerH * rowStride)
      );
    }

    applyAdjustmentsToBuffer(stripData, width, stripH, adj, y0 - padTop, width, height);

    const innerBytes = new Uint8ClampedArray(
      stripData.subarray(padTop * rowStride, (padTop + innerH) * rowStride)
    );
    ctx.putImageData(new ImageData(innerBytes, width, innerH), 0, y0);

    prevTopPad = nextTopPad;
    prevTopPadRows = nextTopPadRows;
  }

  return returnImageData ? ctx.getImageData(0, 0, width, height) : new ImageData(1, 1);
}

function localToGlobalAdjustments(local: LocalAdjustments): Adjustments {
  return {
    ...DEFAULT_ADJUSTMENTS,
    exposure: local.exposure,
    brightness: local.brightness,
    contrast: local.contrast,
    highlights: local.highlights,
    shadows: local.shadows,
    whites: local.whites,
    blacks: local.blacks,
    temperature: local.temperature,
    tint: local.tint,
    saturation: local.saturation,
    texture: local.texture,
    clarity: local.clarity,
    dehaze: local.dehaze,
    sharpness: local.sharpness,
    luminanceNR: local.noiseReduction,
    colorNR: Math.round(local.noiseReduction * 0.5),
  };
}

let sharedMaskWorkCanvas: HTMLCanvasElement | null = null;
function getSharedMaskWorkCanvas(w: number, h: number): HTMLCanvasElement {
  if (!sharedMaskWorkCanvas) {
    sharedMaskWorkCanvas = document.createElement('canvas');
  }
  if (sharedMaskWorkCanvas.width !== w) sharedMaskWorkCanvas.width = w;
  if (sharedMaskWorkCanvas.height !== h) sharedMaskWorkCanvas.height = h;
  return sharedMaskWorkCanvas;
}

function releaseOversizedSharedMaskWorkCanvas(): void {
  if (sharedMaskWorkCanvas && sharedMaskWorkCanvas.width * sharedMaskWorkCanvas.height > 2_500_000) {
    sharedMaskWorkCanvas.width = 1;
    sharedMaskWorkCanvas.height = 1;
  }
}

/**
 * Applies all enabled non-destructive MaskLayers sequentially to `canvas`.
 * Uses memoized mask alpha evaluation & transformed projection, and processes ONLY
 * the padded non-zero bounding box ROI so dragging local adjustment sliders stays fast.
 */
export function applyMaskLayersToCanvas(
  canvas: HTMLCanvasElement,
  maskLayers: MaskLayer[],
  baseSourceForMasks: HTMLImageElement | HTMLCanvasElement,
  transform: TransformState
): void {
  const activeLayers = maskLayers.filter(
    (m) => m.enabled && m.components.length > 0 && hasNonZeroLocalAdjustments(m.adjustments)
  );
  if (activeLayers.length === 0) return;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return;

  const srcW =
    baseSourceForMasks instanceof HTMLImageElement
      ? baseSourceForMasks.naturalWidth
      : baseSourceForMasks.width;
  const srcH =
    baseSourceForMasks instanceof HTMLImageElement
      ? baseSourceForMasks.naturalHeight
      : baseSourceForMasks.height;

  const { width: baseW, height: baseH } = getMaskRasterDimensions(srcW, srcH);
  const baseRgbaProvider = {
    key: getMaskSourceCacheKey(baseSourceForMasks),
    getRgba: () => getCachedBaseSourceRgba(baseSourceForMasks, baseW, baseH),
  };

  const outW = canvas.width;
  const outH = canvas.height;

  for (const layer of activeLayers) {
    const baseAlpha = evaluateMaskLayerBaseAlpha(layer, baseW, baseH, baseRgbaProvider);
    const {
      alpha: outAlpha,
      minX,
      minY,
      maxX,
      maxY,
    } = projectMaskToTransformedSpaceWithBounds(baseAlpha, baseW, baseH, outW, outH, transform);

    if (maxX < minX || maxY < minY) continue;

    // Pad ROI when spatial convolution kernels (Texture, Clarity, Sharpness, NR) are active
    const needsSpatialPad =
      layer.adjustments.clarity !== 0 ||
      layer.adjustments.texture !== 0 ||
      layer.adjustments.sharpness > 0 ||
      layer.adjustments.noiseReduction > 0;
    const pad = needsSpatialPad ? 16 : 0;

    const rx0 = Math.max(0, minX - pad);
    const ry0 = Math.max(0, minY - pad);
    const rx1 = Math.min(outW - 1, maxX + pad);
    const ry1 = Math.min(outH - 1, maxY + pad);
    const roiW = rx1 - rx0 + 1;
    const roiH = ry1 - ry0 + 1;
    if (roiW <= 0 || roiH <= 0) continue;

    const workCanvas = getSharedMaskWorkCanvas(roiW, roiH);
    const wCtx = workCanvas.getContext('2d', { willReadFrequently: true });
    if (!wCtx) continue;

    wCtx.clearRect(0, 0, roiW, roiH);
    wCtx.drawImage(canvas, rx0, ry0, roiW, roiH, 0, 0, roiW, roiH);

    const localAdj = localToGlobalAdjustments(layer.adjustments);
    const adjustedImg = applyAdjustmentsToCanvas(workCanvas, localAdj);
    const baseImg = ctx.getImageData(rx0, ry0, roiW, roiH);
    const bd = baseImg.data;
    const ad = adjustedImg.data;

    for (let ry = 0; ry < roiH; ry++) {
      const alphaRow = (ry0 + ry) * outW + rx0;
      const roiRow = ry * roiW;
      for (let rx = 0; rx < roiW; rx++) {
        const a = outAlpha[alphaRow + rx];
        if (a <= 0.002) continue;
        const idx = (roiRow + rx) * 4;
        if (a >= 0.998) {
          bd[idx] = ad[idx];
          bd[idx + 1] = ad[idx + 1];
          bd[idx + 2] = ad[idx + 2];
        } else {
          const inv = 1 - a;
          bd[idx] = clamp255(bd[idx] * inv + ad[idx] * a);
          bd[idx + 1] = clamp255(bd[idx + 1] * inv + ad[idx + 1] * a);
          bd[idx + 2] = clamp255(bd[idx + 2] * inv + ad[idx + 2] * a);
        }
      }
    }
    ctx.putImageData(baseImg, rx0, ry0);
  }
}

/**
 * Computes a 64-bin normalized RGB + Luminance histogram from ImageData.
 */
export function computeHistogram(imageData: ImageData, bins = 64): HistogramData {
  const r = new Array<number>(bins).fill(0);
  const g = new Array<number>(bins).fill(0);
  const b = new Array<number>(bins).fill(0);
  const l = new Array<number>(bins).fill(0);

  const data = imageData.data;
  const totalPixels = imageData.width * imageData.height;
  const step = Math.max(1, Math.floor(totalPixels / 18000));
  const scale = (bins - 1) / 255;

  let maxVal = 1;
  for (let i = 0; i < totalPixels; i += step) {
    const idx = i * 4;
    const rv = data[idx];
    const gv = data[idx + 1];
    const bv = data[idx + 2];
    const lv = Math.round(0.2126 * rv + 0.7152 * gv + 0.0722 * bv);

    const rBin = Math.min(bins - 1, Math.floor(rv * scale));
    const gBin = Math.min(bins - 1, Math.floor(gv * scale));
    const bBin = Math.min(bins - 1, Math.floor(bv * scale));
    const lBin = Math.min(bins - 1, Math.floor(lv * scale));

    r[rBin]++;
    g[gBin]++;
    b[bBin]++;
    l[lBin]++;
  }

  for (let i = 1; i < bins - 1; i++) {
    if (r[i] > maxVal) maxVal = r[i];
    if (g[i] > maxVal) maxVal = g[i];
    if (b[i] > maxVal) maxVal = b[i];
    if (l[i] > maxVal) maxVal = l[i];
  }
  const edgeCap = Math.max(maxVal, Math.max(l[0], l[bins - 1]) * 0.45);

  for (let i = 0; i < bins; i++) {
    r[i] = Math.min(1, r[i] / edgeCap);
    g[i] = Math.min(1, g[i] / edgeCap);
    b[i] = Math.min(1, b[i] / edgeCap);
    l[i] = Math.min(1, l[i] / edgeCap);
  }

  return { r, g, b, l };
}

/**
 * Checks whether an alpha mask canvas contains any non-opaque (< 252) pixels.
 */
export function alphaMaskHasTransparency(alphaCanvas: HTMLCanvasElement): boolean {
  const ctx = alphaCanvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return false;
  const { data } = ctx.getImageData(0, 0, alphaCanvas.width, alphaCanvas.height);
  for (let i = 0; i < data.length; i += 16) {
    if (data[i] < 252) return true;
  }
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] < 252) return true;
  }
  return false;
}

function getSourceWidth(src: HTMLImageElement | HTMLCanvasElement): number {
  return src instanceof HTMLImageElement ? src.naturalWidth : src.width;
}

function getSourceHeight(src: HTMLImageElement | HTMLCanvasElement): number {
  return src instanceof HTMLImageElement ? src.naturalHeight : src.height;
}

/**
 * Composites retouchCanvas/nativeRgbSource + alphaCanvas + optional replacement background
 * onto an output HTMLCanvasElement at target dimensions. Uses horizontal strip processing
 * when compositing high-resolution (> 4MP) transparent cutouts to minimize RAM consumption.
 */
export function composeRetouchLayer(
  retouchCanvas: HTMLCanvasElement,
  alphaCanvas: HTMLCanvasElement,
  bgSettings: BackgroundSettings,
  bgImage: HTMLImageElement | null,
  targetW = retouchCanvas.width,
  targetH = retouchCanvas.height,
  bgRefinement?: Pick<BgRefinementSettings, 'decontaminateColors' | 'removeColorHalo'>,
  nativeRgbSource?: HTMLImageElement | HTMLCanvasElement | null
): HTMLCanvasElement {
  const hasTrans = alphaMaskHasTransparency(alphaCanvas);

  if (!hasTrans && targetW === retouchCanvas.width && targetH === retouchCanvas.height && !nativeRgbSource) {
    return retouchCanvas;
  }

  if (
    !hasTrans &&
    nativeRgbSource instanceof HTMLCanvasElement &&
    nativeRgbSource.width === targetW &&
    nativeRgbSource.height === targetH
  ) {
    return nativeRgbSource;
  }

  const outCanvas = document.createElement('canvas');
  outCanvas.width = targetW;
  outCanvas.height = targetH;
  const outCtx = outCanvas.getContext('2d', { willReadFrequently: true });
  if (!outCtx) return retouchCanvas;

  outCtx.imageSmoothingEnabled = true;
  outCtx.imageSmoothingQuality = 'high';

  if (hasTrans) {
    if (bgSettings.mode === 'solid') {
      outCtx.fillStyle = bgSettings.color || '#09090b';
      outCtx.fillRect(0, 0, targetW, targetH);
    } else if (bgSettings.mode === 'image' && bgImage && bgImage.naturalWidth > 0) {
      const srcAspect = bgImage.naturalWidth / bgImage.naturalHeight;
      const dstAspect = targetW / targetH;
      let drawW = targetW;
      let drawH = targetH;
      let dx = 0;
      let dy = 0;
      if (srcAspect > dstAspect) {
        drawH = targetH;
        drawW = targetH * srcAspect;
        dx = (targetW - drawW) / 2;
      } else {
        drawW = targetW;
        drawH = targetW / srcAspect;
        dy = (targetH - drawH) / 2;
      }
      outCtx.drawImage(bgImage, dx, dy, drawW, drawH);
    }
  }

  if (!hasTrans) {
    outCtx.drawImage(nativeRgbSource ?? retouchCanvas, 0, 0, targetW, targetH);
    return outCanvas;
  }

  // Use native full-res RGB when provided (both untouched source and native-replayed retouch canvas)
  const nativeW = nativeRgbSource ? getSourceWidth(nativeRgbSource) : 0;
  const nativeH = nativeRgbSource ? getSourceHeight(nativeRgbSource) : 0;
  const useNative = Boolean(
    nativeRgbSource &&
      nativeW >= retouchCanvas.width &&
      nativeH >= retouchCanvas.height &&
      (nativeW > retouchCanvas.width ||
        nativeH > retouchCanvas.height ||
        targetW !== retouchCanvas.width ||
        targetH !== retouchCanvas.height ||
        nativeRgbSource !== retouchCanvas)
  );
  const compW = useNative ? targetW : retouchCanvas.width;
  const compH = useNative ? targetH : retouchCanvas.height;
  const fgSource: HTMLImageElement | HTMLCanvasElement =
    useNative && nativeRgbSource ? nativeRgbSource : retouchCanvas;

  const decontam = bgRefinement?.decontaminateColors ?? 0;
  const halo = bgRefinement?.removeColorHalo ?? 0;

  // Tiled strip path for high-res (> 4MP) transparent compositing + decontamination
  if (compW * compH > LARGE_ADJUSTMENT_PIXELS) {
    const aCtx = alphaCanvas.getContext('2d', { willReadFrequently: true });
    const aW = alphaCanvas.width;
    const aH = alphaCanvas.height;
    const aSrcData = aCtx ? aCtx.getImageData(0, 0, aW, aH).data : null;

    const STRIP_H = 512;
    const PAD = decontam > 1 || halo > 1 ? 12 : 0;
    const fgSrcW = getSourceWidth(fgSource);
    const fgSrcH = getSourceHeight(fgSource);

    const stripFgCanvas = document.createElement('canvas');
    const stripDrawCanvas = document.createElement('canvas');

    for (let y0 = 0; y0 < compH; y0 += STRIP_H) {
      const innerH = Math.min(STRIP_H, compH - y0);
      const sy0 = Math.max(0, y0 - PAD);
      const sy1 = Math.min(compH - 1, y0 + innerH - 1 + PAD);
      const stripH = sy1 - sy0 + 1;

      stripFgCanvas.width = compW;
      stripFgCanvas.height = stripH;
      const sCtx = stripFgCanvas.getContext('2d', { willReadFrequently: true });
      if (!sCtx) continue;
      sCtx.imageSmoothingEnabled = true;
      sCtx.imageSmoothingQuality = 'high';

      const srcCropY = (sy0 / compH) * fgSrcH;
      const srcCropH = (stripH / compH) * fgSrcH;
      sCtx.drawImage(fgSource, 0, srcCropY, fgSrcW, srcCropH, 0, 0, compW, stripH);

      const fgData = sCtx.getImageData(0, 0, compW, stripH);

      if (aSrcData) {
        const stripAlpha = new Uint8ClampedArray(compW * stripH);
        if (compW === aW && compH === aH) {
          for (let py = 0; py < stripH; py++) {
            const rowOff = (sy0 + py) * aW;
            for (let px = 0; px < compW; px++) {
              stripAlpha[py * compW + px] = aSrcData[(rowOff + px) * 4];
            }
          }
        } else {
          for (let py = 0; py < stripH; py++) {
            const gy = sy0 + py;
            const ayF = clamp((gy + 0.5) * (aH / compH) - 0.5, 0, aH - 1);
            const ay0 = Math.floor(ayF);
            const ay1 = Math.min(aH - 1, ay0 + 1);
            const ty = ayF - ay0;
            const rowOut = py * compW;

            for (let px = 0; px < compW; px++) {
              const axF = clamp((px + 0.5) * (aW / compW) - 0.5, 0, aW - 1);
              const ax0 = Math.floor(axF);
              const ax1 = Math.min(aW - 1, ax0 + 1);
              const tx = axF - ax0;

              const v00 = aSrcData[(ay0 * aW + ax0) * 4];
              const v10 = aSrcData[(ay0 * aW + ax1) * 4];
              const v01 = aSrcData[(ay1 * aW + ax0) * 4];
              const v11 = aSrcData[(ay1 * aW + ax1) * 4];
              stripAlpha[rowOut + px] = Math.round(
                (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty
              );
            }
          }
        }

        const rgbSource =
          PAD > 0
            ? decontaminateForegroundColors(fgData.data, stripAlpha, compW, stripH, decontam, halo)
            : fgData.data;

        const padTopRows = y0 - sy0;
        const innerBytes = new Uint8ClampedArray(compW * innerH * 4);
        for (let py = 0; py < innerH; py++) {
          const srcRow = (padTopRows + py) * compW;
          const dstRow = py * compW;
          for (let px = 0; px < compW; px++) {
            const sIdx = (srcRow + px) * 4;
            const dIdx = (dstRow + px) * 4;
            innerBytes[dIdx] = rgbSource[sIdx];
            innerBytes[dIdx + 1] = rgbSource[sIdx + 1];
            innerBytes[dIdx + 2] = rgbSource[sIdx + 2];
            innerBytes[dIdx + 3] = stripAlpha[srcRow + px];
          }
        }

        stripDrawCanvas.width = compW;
        stripDrawCanvas.height = innerH;
        const sdCtx = stripDrawCanvas.getContext('2d');
        if (sdCtx) {
          sdCtx.putImageData(new ImageData(innerBytes, compW, innerH), 0, 0);
          outCtx.drawImage(
            stripDrawCanvas,
            0,
            0,
            compW,
            innerH,
            0,
            (y0 / compH) * targetH,
            targetW,
            (innerH / compH) * targetH
          );
        }
      }
    }

    stripFgCanvas.width = 0;
    stripFgCanvas.height = 0;
    stripDrawCanvas.width = 0;
    stripDrawCanvas.height = 0;
    return outCanvas;
  }

  const fgCanvas = document.createElement('canvas');
  fgCanvas.width = compW;
  fgCanvas.height = compH;
  const fgCtx = fgCanvas.getContext('2d', { willReadFrequently: true });
  if (!fgCtx) return outCanvas;

  fgCtx.imageSmoothingEnabled = true;
  fgCtx.imageSmoothingQuality = 'high';
  fgCtx.drawImage(fgSource, 0, 0, compW, compH);
  const fgData = fgCtx.getImageData(0, 0, compW, compH);

  // Sample alpha channel at compW x compH
  let alphaBytes: Uint8ClampedArray | null = null;
  if (compW === alphaCanvas.width && compH === alphaCanvas.height) {
    const aCtx = alphaCanvas.getContext('2d', { willReadFrequently: true });
    if (aCtx) {
      const aData = aCtx.getImageData(0, 0, compW, compH).data;
      alphaBytes = new Uint8ClampedArray(compW * compH);
      for (let i = 0; i < alphaBytes.length; i++) {
        alphaBytes[i] = aData[i * 4];
      }
    }
  } else {
    const tmpAlpha = document.createElement('canvas');
    tmpAlpha.width = compW;
    tmpAlpha.height = compH;
    const taCtx = tmpAlpha.getContext('2d', { willReadFrequently: true });
    if (taCtx) {
      taCtx.imageSmoothingEnabled = true;
      taCtx.imageSmoothingQuality = 'high';
      taCtx.drawImage(alphaCanvas, 0, 0, compW, compH);
      const aData = taCtx.getImageData(0, 0, compW, compH).data;
      alphaBytes = new Uint8ClampedArray(compW * compH);
      for (let i = 0; i < alphaBytes.length; i++) {
        alphaBytes[i] = aData[i * 4];
      }
    }
    tmpAlpha.width = 0;
    tmpAlpha.height = 0;
  }

  if (alphaBytes) {
    const rgbSource =
      decontam > 1 || halo > 1
        ? decontaminateForegroundColors(fgData.data, alphaBytes, compW, compH, decontam, halo)
        : fgData.data;

    const len = compW * compH;
    for (let i = 0; i < len; i++) {
      const i4 = i * 4;
      fgData.data[i4] = rgbSource[i4];
      fgData.data[i4 + 1] = rgbSource[i4 + 1];
      fgData.data[i4 + 2] = rgbSource[i4 + 2];
      fgData.data[i4 + 3] = alphaBytes[i];
    }
    fgCtx.putImageData(fgData, 0, 0);
  }

  outCtx.drawImage(fgCanvas, 0, 0, targetW, targetH);
  fgCanvas.width = 0;
  fgCanvas.height = 0;
  return outCanvas;
}

/**
 * Renders full-resolution edited image (including native-res retouching replay,
 * alpha mask & background, optics, global adjustments, and non-destructive masks)
 * and exports as JPEG or PNG Blob at full native resolution without downscaling
 * through the 2048px preview buffer.
 */
export async function exportEditedImage(
  source: HTMLImageElement,
  editState: EditState,
  format: 'jpeg' | 'png',
  quality: number,
  retouchOptions?: {
    retouchCanvas: HTMLCanvasElement | null;
    alphaCanvas: HTMLCanvasElement | null;
    bgSettings: BackgroundSettings;
    bgImage: HTMLImageElement | null;
    bgRefinement?: Pick<BgRefinementSettings, 'decontaminateColors' | 'removeColorHalo'>;
    hasRetouchEdits: boolean;
    retouchOps?: RetouchOperation[];
    maskLayers?: MaskLayer[];
  }
): Promise<{ blob: Blob; width: number; height: number }> {
  let renderSource: HTMLImageElement | HTMLCanvasElement = source;
  let nativeRetouchedCanvas: HTMLCanvasElement | null = null;
  const hasAlpha = Boolean(
    retouchOptions?.alphaCanvas && alphaMaskHasTransparency(retouchOptions.alphaCanvas)
  );
  const ops = retouchOptions?.retouchOps ?? [];

  if (ops.length > 0) {
    // Replay Healing Brush, Clone Stamp, and Object Remover at full native source resolution
    nativeRetouchedCanvas = await createNativeRetouchedCanvas(source, ops);
    if (hasAlpha && retouchOptions?.alphaCanvas) {
      renderSource = composeRetouchLayer(
        retouchOptions.retouchCanvas ?? nativeRetouchedCanvas,
        retouchOptions.alphaCanvas,
        retouchOptions.bgSettings,
        retouchOptions.bgImage,
        source.naturalWidth,
        source.naturalHeight,
        retouchOptions.bgRefinement,
        nativeRetouchedCanvas
      );
      nativeRetouchedCanvas.width = 0;
      nativeRetouchedCanvas.height = 0;
      nativeRetouchedCanvas = null;
    } else {
      renderSource = nativeRetouchedCanvas;
    }
  } else if (
    retouchOptions &&
    retouchOptions.retouchCanvas &&
    retouchOptions.alphaCanvas &&
    hasAlpha
  ) {
    renderSource = composeRetouchLayer(
      retouchOptions.retouchCanvas,
      retouchOptions.alphaCanvas,
      retouchOptions.bgSettings,
      retouchOptions.bgImage,
      source.naturalWidth,
      source.naturalHeight,
      retouchOptions.bgRefinement,
      source
    );
  }

  const canvas = renderGeometryCanvas(renderSource, editState.transform, null, true);
  applyAdjustmentsToCanvas(canvas, editState.adjustments, false);

  if (retouchOptions?.maskLayers && retouchOptions.maskLayers.length > 0) {
    applyMaskLayersToCanvas(canvas, retouchOptions.maskLayers, renderSource, editState.transform);
    releaseOversizedSharedMaskWorkCanvas();
  }

  if (renderSource !== source && renderSource instanceof HTMLCanvasElement) {
    renderSource.width = 0;
    renderSource.height = 0;
  }

  if (format === 'jpeg' && hasAlpha) {
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.save();
      ctx.globalCompositeOperation = 'destination-over';
      ctx.fillStyle = '#09090b';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.restore();
    }
  }

  const mime = format === 'png' ? 'image/png' : 'image/jpeg';
  const q = format === 'png' ? undefined : clamp(quality / 100, 0.1, 1);

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => {
        if (b) resolve(b);
        else reject(new Error('Failed to encode exported image'));
      },
      mime,
      q
    );
  });

  const outWidth = canvas.width;
  const outHeight = canvas.height;
  canvas.width = 0;
  canvas.height = 0;
  releaseProcessorScratchBuffers();

  return {
    blob,
    width: outWidth,
    height: outHeight,
  };
}
