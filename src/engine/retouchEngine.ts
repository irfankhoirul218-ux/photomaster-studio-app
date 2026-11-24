import {
  BgRefinementSettings,
  BgSegmentationProgress,
  DirtyRect,
  RetouchNormPoint,
  RetouchOperation,
  TransformState,
} from '../types/editor';
import {
  localGeodesicFallbackSegmentation,
  propagateManualSelectionMask,
  refineBackgroundAlphaMask,
  segmentImageRgba,
} from './backgroundSegmentation';
import { getRotatedDimensions } from './imageProcessor';
import { getDevicePerformanceProfile } from './performanceProfile';

export const MAX_RETOUCH_DIMENSION = 2048;

let healRingCapacity = 0;
let healRingRx = new Float32Array(0);
let healRingRy = new Float32Array(0);
let healRingR = new Uint8Array(0);
let healRingG = new Uint8Array(0);
let healRingB = new Uint8Array(0);

function ensureHealRingCapacity(needed: number): void {
  if (needed <= healRingCapacity) return;
  const nextCap = Math.max(needed, Math.max(1024, healRingCapacity * 2));
  const nextRx = new Float32Array(nextCap);
  const nextRy = new Float32Array(nextCap);
  const nextR = new Uint8Array(nextCap);
  const nextG = new Uint8Array(nextCap);
  const nextB = new Uint8Array(nextCap);
  if (healRingCapacity > 0) {
    nextRx.set(healRingRx);
    nextRy.set(healRingRy);
    nextR.set(healRingR);
    nextG.set(healRingG);
    nextB.set(healRingB);
  }
  healRingRx = nextRx;
  healRingRy = nextRy;
  healRingR = nextR;
  healRingG = nextG;
  healRingB = nextB;
  healRingCapacity = nextCap;
}

export function extractAlphaRect(
  alphaCanvas: HTMLCanvasElement,
  rect: DirtyRect
): Uint8ClampedArray {
  const ctx = alphaCanvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return new Uint8ClampedArray(0);
  const data = ctx.getImageData(rect.x, rect.y, rect.width, rect.height).data;
  const out = new Uint8ClampedArray(rect.width * rect.height);
  for (let i = 0; i < out.length; i++) {
    out[i] = data[i * 4];
  }
  return out;
}

export function putAlphaRect(
  alphaCanvas: HTMLCanvasElement,
  rect: DirtyRect,
  alphaBytes: Uint8ClampedArray
): void {
  const ctx = alphaCanvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return;
  const imgData = ctx.createImageData(rect.width, rect.height);
  const d = imgData.data;
  for (let i = 0; i < alphaBytes.length; i++) {
    const v = alphaBytes[i];
    const i4 = i * 4;
    d[i4] = v;
    d[i4 + 1] = v;
    d[i4 + 2] = v;
    d[i4 + 3] = 255;
  }
  ctx.putImageData(imgData, rect.x, rect.y);
}

export interface RetouchBuffers {
  width: number;
  height: number;
  retouchCanvas: HTMLCanvasElement;
  alphaCanvas: HTMLCanvasElement;
  objectMaskCanvas: HTMLCanvasElement;
  /** Raw neural segmentation matte [0..255] before non-destructive refinement sliders. */
  rawAutoAlpha: Uint8ClampedArray | null;
  /** Refined matte before manual brush delta overrides. */
  refinedBaseAlpha: Uint8ClampedArray | null;
  /** Per-pixel manual restore/erase brush overrides preserved across refinement tweaks. */
  manualAlphaDelta: Int16Array | null;
}

export interface DirtyPatchResult {
  rect: DirtyRect;
  before: ImageData;
  after: ImageData;
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Allocates memory-bounded working buffers (max 2048px longest side)
 * without ever mutating the original HTMLImageElement.
 */
export function createRetouchBuffers(sourceImage: HTMLImageElement): RetouchBuffers {
  const natW = sourceImage.naturalWidth;
  const natH = sourceImage.naturalHeight;
  const longest = Math.max(natW, natH);
  const maxDim = getDevicePerformanceProfile().retouchMaxDim;
  const scale = longest > maxDim ? maxDim / longest : 1;

  const width = Math.max(1, Math.round(natW * scale));
  const height = Math.max(1, Math.round(natH * scale));

  const retouchCanvas = document.createElement('canvas');
  retouchCanvas.width = width;
  retouchCanvas.height = height;
  const rCtx = retouchCanvas.getContext('2d', { willReadFrequently: true });
  if (rCtx) {
    rCtx.imageSmoothingEnabled = true;
    rCtx.imageSmoothingQuality = 'high';
    rCtx.drawImage(sourceImage, 0, 0, width, height);
  }

  const alphaCanvas = document.createElement('canvas');
  alphaCanvas.width = width;
  alphaCanvas.height = height;
  const aCtx = alphaCanvas.getContext('2d', { willReadFrequently: true });
  if (aCtx) {
    aCtx.fillStyle = '#ffffff';
    aCtx.fillRect(0, 0, width, height);
  }

  const objectMaskCanvas = document.createElement('canvas');
  objectMaskCanvas.width = width;
  objectMaskCanvas.height = height;

  return {
    width,
    height,
    retouchCanvas,
    alphaCanvas,
    objectMaskCanvas,
    rawAutoAlpha: null,
    refinedBaseAlpha: null,
    manualAlphaDelta: null,
  };
}

/**
 * Maps screen client coordinates on the displayed canvas element back to exact
 * pixel coordinates in the retouch buffer, accounting for zoom, crop, straighten,
 * horizontal/vertical flips, and 90-degree rotations.
 */
export function screenToRetouchCoords(
  clientX: number,
  clientY: number,
  canvasRect: DOMRect,
  transform: TransformState,
  retouchW: number,
  retouchH: number,
  isCroppedView: boolean
): { x: number; y: number; scaleDisplayToRetouch: number } {
  const nx = clamp((clientX - canvasRect.left) / Math.max(1, canvasRect.width), 0, 1);
  const ny = clamp((clientY - canvasRect.top) / Math.max(1, canvasRect.height), 0, 1);

  const { width: rotW, height: rotH } = getRotatedDimensions(retouchW, retouchH, transform.rotate90);

  // Convert normalized display coords to rotated/cropped coordinates
  const wx = isCroppedView ? transform.crop.x + nx * transform.crop.width : nx;
  const wy = isCroppedView ? transform.crop.y + ny * transform.crop.height : ny;

  let px = (wx - 0.5) * rotW;
  let py = (wy - 0.5) * rotH;

  // Invert straighten + auto-constrain scale
  if (transform.straighten !== 0) {
    const rad = (transform.straighten * Math.PI) / 180;
    const cosA = Math.abs(Math.cos(rad));
    const sinA = Math.abs(Math.sin(rad));
    const autoScale = Math.max(
      (rotW * cosA + rotH * sinA) / rotW,
      (rotW * sinA + rotH * cosA) / rotH
    );
    px /= autoScale;
    py /= autoScale;
    const cosNeg = Math.cos(-rad);
    const sinNeg = Math.sin(-rad);
    const rx = px * cosNeg - py * sinNeg;
    const ry = px * sinNeg + py * cosNeg;
    px = rx;
    py = ry;
  }

  // Invert screen-space flip
  if (transform.flipH) px = -px;
  if (transform.flipV) py = -py;

  // Invert rotate90
  let sx = px;
  let sy = py;
  if (transform.rotate90 === 1) {
    sx = py;
    sy = -px;
  } else if (transform.rotate90 === 2) {
    sx = -px;
    sy = -py;
  } else if (transform.rotate90 === 3) {
    sx = -py;
    sy = px;
  }

  const finalX = clamp(sx + retouchW / 2, 0, retouchW - 1);
  const finalY = clamp(sy + retouchH / 2, 0, retouchH - 1);

  const shownW = isCroppedView ? rotW * transform.crop.width : rotW;
  const scaleDisplayToRetouch = shownW / Math.max(1, canvasRect.width);

  return { x: finalX, y: finalY, scaleDisplayToRetouch };
}

/**
 * Inverse mapping: converts retouch buffer coordinates to normalized display [0..1]
 * coordinates for rendering overlays (like Clone Stamp source crosshair).
 */
export function retouchToDisplayNormalized(
  rx: number,
  ry: number,
  transform: TransformState,
  retouchW: number,
  retouchH: number,
  isCroppedView: boolean
): { nx: number; ny: number } {
  const sx = rx - retouchW / 2;
  const sy = ry - retouchH / 2;

  let px = sx;
  let py = sy;
  if (transform.rotate90 === 1) {
    px = -sy;
    py = sx;
  } else if (transform.rotate90 === 2) {
    px = -sx;
    py = -sy;
  } else if (transform.rotate90 === 3) {
    px = sy;
    py = -sx;
  }

  if (transform.flipH) px = -px;
  if (transform.flipV) py = -py;

  const { width: rotW, height: rotH } = getRotatedDimensions(retouchW, retouchH, transform.rotate90);

  if (transform.straighten !== 0) {
    const rad = (transform.straighten * Math.PI) / 180;
    const cosA = Math.abs(Math.cos(rad));
    const sinA = Math.abs(Math.sin(rad));
    const autoScale = Math.max(
      (rotW * cosA + rotH * sinA) / rotW,
      (rotW * sinA + rotH * cosA) / rotH
    );
    const cosR = Math.cos(rad);
    const sinR = Math.sin(rad);
    const tx = (px * cosR - py * sinR) * autoScale;
    const ty = (px * sinR + py * cosR) * autoScale;
    px = tx;
    py = ty;
  }

  const wx = px / rotW + 0.5;
  const wy = py / rotH + 0.5;

  if (!isCroppedView) {
    return { nx: wx, ny: wy };
  }
  return {
    nx: (wx - transform.crop.x) / Math.max(0.001, transform.crop.width),
    ny: (wy - transform.crop.y) / Math.max(0.001, transform.crop.height),
  };
}

/**
 * Paints a smooth dab onto the Object Remover selection mask.
 */
export function paintObjectMaskDab(
  maskCanvas: HTMLCanvasElement,
  x: number,
  y: number,
  radius: number
): void {
  const ctx = maskCanvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return;
  ctx.save();
  ctx.fillStyle = 'rgba(239, 68, 68, 1)';
  ctx.beginPath();
  ctx.arc(x, y, Math.max(2, radius), 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/**
 * Checks whether the Object Remover selection mask contains any painted pixels.
 */
export function hasObjectMaskPixels(maskCanvas: HTMLCanvasElement): boolean {
  const ctx = maskCanvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return false;
  const { data } = ctx.getImageData(0, 0, maskCanvas.width, maskCanvas.height);
  for (let i = 3; i < data.length; i += 16) {
    if (data[i] > 20) return true;
  }
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] > 20) return true;
  }
  return false;
}

/**
 * Paints a soft/hard dab onto the non-destructive Alpha Mask canvas
 * (255 = opaque subject, 0 = erased transparent).
 */
export function paintAlphaMaskDab(
  alphaCanvas: HTMLCanvasElement,
  x: number,
  y: number,
  radius: number,
  hardnessPct: number,
  opacityPct: number,
  mode: 'erase' | 'restore',
  strokeTargetAlpha?: Uint8ClampedArray,
  featherPct = 0
): DirtyRect | null {
  const ctx = alphaCanvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;

  const w = alphaCanvas.width;
  const h = alphaCanvas.height;
  const r = Math.max(2, Math.ceil(radius));
  const x0 = Math.max(0, Math.floor(x - r));
  const y0 = Math.max(0, Math.floor(y - r));
  const x1 = Math.min(w - 1, Math.ceil(x + r));
  const y1 = Math.min(h - 1, Math.ceil(y + r));
  const bw = x1 - x0 + 1;
  const bh = y1 - y0 + 1;
  if (bw <= 0 || bh <= 0) return null;

  const imgData = ctx.getImageData(x0, y0, bw, bh);
  const data = imgData.data;

  const feather = clamp(featherPct / 100, 0, 1);
  const rawHardness = clamp(hardnessPct / 100, 0, 0.99);
  const effectiveHardness = clamp(rawHardness * (1 - feather * 0.72), 0, 0.98);
  const featherPower = 1 + feather * 1.15;
  const opacity = clamp(opacityPct / 100, 0.02, 1);
  const rSq = radius * radius;

  for (let py = y0; py <= y1; py++) {
    const dy = py - y;
    const dy2 = dy * dy;
    for (let px = x0; px <= x1; px++) {
      const dx = px - x;
      const dist2 = dx * dx + dy2;
      if (dist2 > rSq) continue;

      const distNorm = Math.sqrt(dist2) / radius;
      const baseFalloff =
        distNorm <= effectiveHardness
          ? 1
          : 1 - smoothstep(effectiveHardness, 1.0, distNorm);
      const falloff =
        featherPower > 1.02 && baseFalloff < 1
          ? Math.pow(baseFalloff, featherPower)
          : baseFalloff;
      const strength = falloff * opacity;
      if (strength <= 0.001) continue;

      const idx = ((py - y0) * bw + (px - x0)) * 4;
      const fullIdx = py * w + px;
      const baseVal = strokeTargetAlpha ? strokeTargetAlpha[fullIdx] : data[idx];

      let nextVal: number;
      if (mode === 'erase') {
        const target = Math.round(baseVal * (1 - strength));
        nextVal = Math.min(data[idx], target);
      } else {
        const target = Math.round(baseVal + (255 - baseVal) * strength);
        nextVal = Math.max(data[idx], target);
      }

      data[idx] = nextVal;
      data[idx + 1] = nextVal;
      data[idx + 2] = nextVal;
      data[idx + 3] = 255;
    }
  }

  ctx.putImageData(imgData, x0, y0);
  return { x: x0, y: y0, width: bw, height: bh };
}

/**
 * Healing Brush: samples surrounding ring texture and blends high-frequency detail
 * seamlessly with local boundary tone to erase blemishes, spots, and dust.
 */
export function paintHealingDab(
  retouchCanvas: HTMLCanvasElement,
  strokeSnapshot: HTMLCanvasElement,
  x: number,
  y: number,
  radius: number,
  softnessPct: number
): DirtyRect | null {
  const ctx = retouchCanvas.getContext('2d', { willReadFrequently: true });
  const srcCtx = strokeSnapshot.getContext('2d', { willReadFrequently: true });
  if (!ctx || !srcCtx) return null;

  const w = retouchCanvas.width;
  const h = retouchCanvas.height;
  const r = Math.max(3, radius);
  const outerR = Math.min(r * 1.9, r + Math.max(26, r * 0.45));

  const x0 = Math.max(0, Math.floor(x - outerR));
  const y0 = Math.max(0, Math.floor(y - outerR));
  const x1 = Math.min(w - 1, Math.ceil(x + outerR));
  const y1 = Math.min(h - 1, Math.ceil(y + outerR));
  const bw = x1 - x0 + 1;
  const bh = y1 - y0 + 1;
  if (bw <= 2 || bh <= 2) return null;

  const dstData = ctx.getImageData(x0, y0, bw, bh);
  const srcData = srcCtx.getImageData(x0, y0, bw, bh);
  const d = dstData.data;
  const s = srcData.data;

  // Collect clean sample pixels from the surrounding outer ring (1.06r .. outerR) into pooled typed arrays
  let ringCount = 0;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;

  const innerRing2 = (r * 1.06) * (r * 1.06);
  const outerRing2 = outerR * outerR;

  for (let py = y0; py <= y1; py++) {
    const dy = py - y;
    const dy2 = dy * dy;
    for (let px = x0; px <= x1; px++) {
      const dx = px - x;
      const d2 = dx * dx + dy2;
      if (d2 >= innerRing2 && d2 <= outerRing2) {
        const idx = ((py - y0) * bw + (px - x0)) * 4;
        const pr = s[idx];
        const pg = s[idx + 1];
        const pb = s[idx + 2];
        if (ringCount >= healRingCapacity) {
          ensureHealRingCapacity(ringCount + 256);
        }
        healRingRx[ringCount] = dx;
        healRingRy[ringCount] = dy;
        healRingR[ringCount] = pr;
        healRingG[ringCount] = pg;
        healRingB[ringCount] = pb;
        ringCount++;
        sumR += pr;
        sumG += pg;
        sumB += pb;
      }
    }
  }

  if (ringCount < 4) return null;

  const meanR = sumR / ringCount;
  const meanG = sumG / ringCount;
  const meanB = sumB / ringCount;

  const featherStart = clamp(1 - softnessPct / 100, 0.05, 0.85) * 0.7;
  const r2 = r * r;
  const sampleStride = Math.max(1, Math.floor(ringCount / 28));
  const rDiagPad = r * 0.6;

  // Paint repaired pixels inside circle using directional ring interpolation + micro-texture
  for (let py = y0; py <= y1; py++) {
    const dy = py - y;
    const dy2 = dy * dy;
    for (let px = x0; px <= x1; px++) {
      const dx = px - x;
      const dist2 = dx * dx + dy2;
      if (dist2 > r2) continue;

      const dist = Math.sqrt(dist2);
      const distNorm = dist / r;
      const blend = 1 - smoothstep(featherStart, 1.0, distNorm);
      if (blend <= 0.005) continue;

      // Directional inverse-distance weighted tone from ring + reflected clean sample texture
      let wSum = 0;
      let estR = 0;
      let estG = 0;
      let estB = 0;
      for (let k = 0; k < ringCount; k += sampleStride) {
        const sdx = healRingRx[k] - dx;
        const sdy = healRingRy[k] - dy;
        const wgt = 1 / (sdx * sdx + sdy * sdy + rDiagPad);
        estR += healRingR[k] * wgt;
        estG += healRingG[k] * wgt;
        estB += healRingB[k] * wgt;
        wSum += wgt;
      }

      const baseR = wSum > 0 ? estR / wSum : meanR;
      const baseG = wSum > 0 ? estG / wSum : meanG;
      const baseB = wSum > 0 ? estB / wSum : meanB;

      // Sample natural grain/texture from opposite side of outer ring
      const texIdx =
        Math.abs(Math.round(dx * 1.4 + dy * 3.1 + ringCount)) % ringCount;
      const texR = (healRingR[texIdx] - meanR) * 0.55;
      const texG = (healRingG[texIdx] - meanG) * 0.55;
      const texB = (healRingB[texIdx] - meanB) * 0.55;

      const idx = ((py - y0) * bw + (px - x0)) * 4;
      const targetR = clamp255(baseR + texR);
      const targetG = clamp255(baseG + texG);
      const targetB = clamp255(baseB + texB);

      d[idx] = clamp255(d[idx] * (1 - blend) + targetR * blend);
      d[idx + 1] = clamp255(d[idx + 1] * (1 - blend) + targetG * blend);
      d[idx + 2] = clamp255(d[idx + 2] * (1 - blend) + targetB * blend);
    }
  }

  ctx.putImageData(dstData, x0, y0);
  return { x: x0, y: y0, width: bw, height: bh };
}

/**
 * Clone Stamp: copies pixels from (srcX, srcY) in strokeSnapshot onto (dstX, dstY)
 * in retouchCanvas with radial hardness falloff and opacity.
 */
export function paintCloneDab(
  retouchCanvas: HTMLCanvasElement,
  strokeSnapshot: HTMLCanvasElement,
  dstX: number,
  dstY: number,
  srcX: number,
  srcY: number,
  radius: number,
  hardnessPct: number,
  opacityPct: number
): DirtyRect | null {
  const ctx = retouchCanvas.getContext('2d', { willReadFrequently: true });
  const srcCtx = strokeSnapshot.getContext('2d', { willReadFrequently: true });
  if (!ctx || !srcCtx) return null;

  const w = retouchCanvas.width;
  const h = retouchCanvas.height;
  const swMax = strokeSnapshot.width;
  const shMax = strokeSnapshot.height;
  const r = Math.max(2, Math.ceil(radius));

  const x0 = Math.max(0, Math.floor(dstX - r));
  const y0 = Math.max(0, Math.floor(dstY - r));
  const x1 = Math.min(w - 1, Math.ceil(dstX + r));
  const y1 = Math.min(h - 1, Math.ceil(dstY + r));
  const bw = x1 - x0 + 1;
  const bh = y1 - y0 + 1;
  if (bw <= 0 || bh <= 0) return null;

  const dstData = ctx.getImageData(x0, y0, bw, bh);
  const d = dstData.data;

  // Determine source bounding box clamped cleanly against strokeSnapshot dimensions
  const offsetX = srcX - dstX;
  const offsetY = srcY - dstY;
  const sx0 = clamp(Math.floor(x0 + offsetX), 0, swMax - 1);
  const sy0 = clamp(Math.floor(y0 + offsetY), 0, shMax - 1);
  const sx1 = clamp(Math.ceil(x1 + offsetX), 0, swMax - 1);
  const sy1 = clamp(Math.ceil(y1 + offsetY), 0, shMax - 1);
  const sbw = Math.max(1, sx1 - sx0 + 1);
  const sbh = Math.max(1, sy1 - sy0 + 1);
  const srcData = srcCtx.getImageData(sx0, sy0, sbw, sbh).data;

  const hardness = clamp(hardnessPct / 100, 0, 0.99);
  const opacity = clamp(opacityPct / 100, 0.02, 1);
  const rSq = radius * radius;

  for (let py = y0; py <= y1; py++) {
    const dy = py - dstY;
    const dy2 = dy * dy;
    const sampleY = clamp(Math.round(py + offsetY), sy0, sy1) - sy0;

    for (let px = x0; px <= x1; px++) {
      const dx = px - dstX;
      const dist2 = dx * dx + dy2;
      if (dist2 > rSq) continue;

      const distNorm = Math.sqrt(dist2) / radius;
      const falloff =
        distNorm <= hardness ? 1 : 1 - smoothstep(hardness, 1.0, distNorm);
      const alpha = falloff * opacity;
      if (alpha <= 0.002) continue;

      const sampleX = clamp(Math.round(px + offsetX), sx0, sx1) - sx0;
      const sIdx = (sampleY * sbw + sampleX) * 4;
      const dIdx = ((py - y0) * bw + (px - x0)) * 4;

      d[dIdx] = clamp255(d[dIdx] * (1 - alpha) + srcData[sIdx] * alpha);
      d[dIdx + 1] = clamp255(d[dIdx + 1] * (1 - alpha) + srcData[sIdx + 1] * alpha);
      d[dIdx + 2] = clamp255(d[dIdx + 2] * (1 - alpha) + srcData[sIdx + 2] * alpha);
    }
  }

  ctx.putImageData(dstData, x0, y0);
  return { x: x0, y: y0, width: bw, height: bh };
}

export interface ObjectMaskPatch {
  normRect: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  maskWidth: number;
  maskHeight: number;
  maskBytes: Uint8Array;
}

/**
 * Extracts a compact, resolution-independent tight bounding box of painted
 * object-removal mask pixels so full-resolution export can replay inpainting
 * at native dimensions without upscaling a 2048px preview image.
 */
export function extractObjectMaskPatch(maskCanvas: HTMLCanvasElement): ObjectMaskPatch | null {
  const mCtx = maskCanvas.getContext('2d', { willReadFrequently: true });
  if (!mCtx) return null;

  const w = maskCanvas.width;
  const h = maskCanvas.height;
  const fullMask = mCtx.getImageData(0, 0, w, h).data;

  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    const rowOff = y * w;
    for (let x = 0; x < w; x++) {
      if (fullMask[(rowOff + x) * 4 + 3] > 20) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < minX || maxY < minY) return null;

  const maskWidth = maxX - minX + 1;
  const maskHeight = maxY - minY + 1;
  const maskBytes = new Uint8Array(maskWidth * maskHeight);
  for (let y = 0; y < maskHeight; y++) {
    const srcRow = (minY + y) * w + minX;
    const dstRow = y * maskWidth;
    for (let x = 0; x < maskWidth; x++) {
      maskBytes[dstRow + x] = fullMask[(srcRow + x) * 4 + 3];
    }
  }

  return {
    normRect: {
      x: minX / Math.max(1, w),
      y: minY / Math.max(1, h),
      width: maskWidth / Math.max(1, w),
      height: maskHeight / Math.max(1, h),
    },
    maskWidth,
    maskHeight,
    maskBytes,
  };
}

function dilateBinaryMask(rawMask: Uint8Array, rw: number, rh: number, radius: number): Uint8Array {
  const r = Math.max(1, Math.round(radius));
  const horiz = new Uint8Array(rw * rh);
  for (let y = 0; y < rh; y++) {
    const row = y * rw;
    let count = 0;
    for (let kx = 0; kx <= Math.min(r, rw - 1); kx++) {
      if (rawMask[row + kx]) count++;
    }
    for (let x = 0; x < rw; x++) {
      horiz[row + x] = count > 0 ? 1 : 0;
      const outX = x - r;
      if (outX >= 0 && rawMask[row + outX]) count--;
      const inX = x + r + 1;
      if (inX < rw && rawMask[row + inX]) count++;
    }
  }

  const out = new Uint8Array(rw * rh);
  for (let x = 0; x < rw; x++) {
    let count = 0;
    for (let ky = 0; ky <= Math.min(r, rh - 1); ky++) {
      if (horiz[ky * rw + x]) count++;
    }
    for (let y = 0; y < rh; y++) {
      out[y * rw + x] = count > 0 ? 1 : 0;
      const outY = y - r;
      if (outY >= 0 && horiz[outY * rw + x]) count--;
      const inY = y + r + 1;
      if (inY < rh && horiz[inY * rw + x]) count++;
    }
  }
  return out;
}

/**
 * Core ROI inpainting routine shared by both 2048px preview and full-resolution native export.
 */
function inpaintMaskedRoi(
  before: ImageData,
  rawMask: Uint8Array,
  rw: number,
  rh: number,
  scaleFactor = 1
): ImageData | null {
  const work = new Uint8ClampedArray(before.data);
  const len = rw * rh;

  // Dilate mask proportionally so edge anti-aliasing around object outline is included cleanly
  const dilateR = Math.max(2, Math.min(8, Math.round(2 * scaleFactor)));
  const mask = dilateBinaryMask(rawMask, rw, rh, dilateR);

  // Step 1: Compute distance-from-valid map (Manhattan/BFS)
  const dist = new Int32Array(len).fill(999999);
  const queue = new Int32Array(len);
  let qHead = 0;
  let qTail = 0;

  for (let i = 0; i < len; i++) {
    if (mask[i] === 0) {
      dist[i] = 0;
      queue[qTail++] = i;
    }
  }

  if (qTail === 0) {
    // Whole ROI masked (rare edge case) -> nothing valid to reconstruct from
    return null;
  }

  const dirs = [-1, 1, -rw, rw];
  let maxDist = 0;
  while (qHead < qTail) {
    const cur = queue[qHead++];
    const cx = cur % rw;
    const cy = Math.floor(cur / rw);
    const nextD = dist[cur] + 1;

    if (cx > 0 && dist[cur - 1] > nextD) {
      dist[cur - 1] = nextD;
      if (nextD > maxDist) maxDist = nextD;
      queue[qTail++] = cur - 1;
    }
    if (cx < rw - 1 && dist[cur + 1] > nextD) {
      dist[cur + 1] = nextD;
      if (nextD > maxDist) maxDist = nextD;
      queue[qTail++] = cur + 1;
    }
    if (cy > 0 && dist[cur - rw] > nextD) {
      dist[cur - rw] = nextD;
      if (nextD > maxDist) maxDist = nextD;
      queue[qTail++] = cur - rw;
    }
    if (cy < rh - 1 && dist[cur + rw] > nextD) {
      dist[cur + rw] = nextD;
      if (nextD > maxDist) maxDist = nextD;
      queue[qTail++] = cur + rw;
    }
  }

  // Step 2: Initialize masked pixels inward in concentric distance order (Telea-style neighbor diffusion)
  const filled = new Uint8Array(len);
  for (let i = 0; i < len; i++) filled[i] = mask[i] === 0 ? 1 : 0;

  const layers: number[][] = Array.from({ length: maxDist + 1 }, () => []);
  for (let i = 0; i < len; i++) {
    if (mask[i] === 1) {
      layers[dist[i]].push(i);
    }
  }

  for (let d = 1; d <= maxDist; d++) {
    const layer = layers[d];
    for (let k = 0; k < layer.length; k++) {
      const idx = layer[k];
      const x = idx % rw;
      const y = Math.floor(idx / rw);
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let wt = 0;

      for (let oy = -2; oy <= 2; oy++) {
        const ny = y + oy;
        if (ny < 0 || ny >= rh) continue;
        for (let ox = -2; ox <= 2; ox++) {
          const nx = x + ox;
          if (nx < 0 || nx >= rw) continue;
          const nIdx = ny * rw + nx;
          if (filled[nIdx]) {
            const wgt = 1 / (ox * ox + oy * oy + 0.5);
            sr += work[nIdx * 4] * wgt;
            sg += work[nIdx * 4 + 1] * wgt;
            sb += work[nIdx * 4 + 2] * wgt;
            wt += wgt;
          }
        }
      }
      if (wt > 0) {
        work[idx * 4] = clamp255(sr / wt);
        work[idx * 4 + 1] = clamp255(sg / wt);
        work[idx * 4 + 2] = clamp255(sb / wt);
        filled[idx] = 1;
      }
    }
  }

  // Smooth harmonic diffusion refinement over masked pixels
  const tmpBuf = new Float32Array(len * 3);
  for (let i = 0; i < len; i++) {
    tmpBuf[i * 3] = work[i * 4];
    tmpBuf[i * 3 + 1] = work[i * 4 + 1];
    tmpBuf[i * 3 + 2] = work[i * 4 + 2];
  }

  const diffPasses = Math.min(18, Math.max(6, Math.round(maxDist * 0.35)));
  for (let pass = 0; pass < diffPasses; pass++) {
    for (let i = 0; i < len; i++) {
      if (mask[i] === 0) continue;
      const x = i % rw;
      const y = Math.floor(i / rw);
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let cnt = 0;
      for (let dirIdx = 0; dirIdx < dirs.length; dirIdx++) {
        if (dirIdx === 0 && x === 0) continue;
        if (dirIdx === 1 && x === rw - 1) continue;
        if (dirIdx === 2 && y === 0) continue;
        if (dirIdx === 3 && y === rh - 1) continue;
        const ni = i + dirs[dirIdx];
        sr += tmpBuf[ni * 3];
        sg += tmpBuf[ni * 3 + 1];
        sb += tmpBuf[ni * 3 + 2];
        cnt++;
      }
      if (cnt > 0) {
        tmpBuf[i * 3] = sr / cnt;
        tmpBuf[i * 3 + 1] = sg / cnt;
        tmpBuf[i * 3 + 2] = sb / cnt;
      }
    }
  }

  for (let i = 0; i < len; i++) {
    if (mask[i] === 1) {
      work[i * 4] = clamp255(tmpBuf[i * 3]);
      work[i * 4 + 1] = clamp255(tmpBuf[i * 3 + 1]);
      work[i * 4 + 2] = clamp255(tmpBuf[i * 3 + 2]);
    }
  }

  // Step 3: Exemplar Patch Texture Synthesis from surrounding valid native-res region
  const pHalf = Math.max(3, Math.min(7, Math.round(3 * scaleFactor)));
  const candidates: number[] = [];
  const candStride = Math.max(2, Math.floor(Math.sqrt((rw * rh) / 600)));

  for (let y = pHalf; y < rh - pHalf; y += candStride) {
    for (let x = pHalf; x < rw - pHalf; x += candStride) {
      let validPatch = true;
      for (let oy = -pHalf; oy <= pHalf && validPatch; oy++) {
        for (let ox = -pHalf; ox <= pHalf; ox++) {
          if (mask[(y + oy) * rw + (x + ox)] === 1) {
            validPatch = false;
            break;
          }
        }
      }
      if (validPatch) {
        candidates.push(y * rw + x);
      }
    }
  }

  if (candidates.length > 0) {
    const texOut = new Float32Array(len * 3);
    const texWgt = new Float32Array(len);

    // Synthesize texture in concentric rings from outer boundary inward
    const stepStride = Math.max(3, Math.min(pHalf, Math.floor(pHalf * 0.85)));
    const cmpStep = Math.max(2, Math.floor(pHalf * 0.65));
    const evalStride = Math.max(1, Math.floor(candidates.length / 80));

    for (let d = 1; d <= maxDist; d += stepStride) {
      const layer = layers[d];
      for (let k = 0; k < layer.length; k += stepStride) {
        const idx = layer[k];
        const cx = idx % rw;
        const cy = Math.floor(idx / rw);
        if (cx < pHalf || cx >= rw - pHalf || cy < pHalf || cy >= rh - pHalf) continue;

        let bestCand = candidates[0];
        let bestErr = Infinity;

        for (let c = 0; c < candidates.length; c += evalStride) {
          const candIdx = candidates[c];
          const sx = candIdx % rw;
          const sy = Math.floor(candIdx / rw);

          let err = 0;
          for (let oy = -pHalf; oy <= pHalf; oy += cmpStep) {
            for (let ox = -pHalf; ox <= pHalf; ox += cmpStep) {
              const ti = ((cy + oy) * rw + (cx + ox)) * 4;
              const si = ((sy + oy) * rw + (sx + ox)) * 4;
              const dr = work[ti] - before.data[si];
              const dg = work[ti + 1] - before.data[si + 1];
              const db = work[ti + 2] - before.data[si + 2];
              const weight = mask[(cy + oy) * rw + (cx + ox)] === 0 ? 3.0 : 1.0;
              err += (dr * dr + dg * dg + db * db) * weight;
            }
          }

          if (err < bestErr) {
            bestErr = err;
            bestCand = candIdx;
          }
        }

        const bsx = bestCand % rw;
        const bsy = Math.floor(bestCand / rw);

        let mDiffR = 0;
        let mDiffG = 0;
        let mDiffB = 0;
        let mCnt = 0;
        for (let oy = -pHalf; oy <= pHalf; oy += cmpStep) {
          for (let ox = -pHalf; ox <= pHalf; ox += cmpStep) {
            const ti = ((cy + oy) * rw + (cx + ox)) * 4;
            const si = ((bsy + oy) * rw + (bsx + ox)) * 4;
            mDiffR += work[ti] - before.data[si];
            mDiffG += work[ti + 1] - before.data[si + 1];
            mDiffB += work[ti + 2] - before.data[si + 2];
            mCnt++;
          }
        }
        mDiffR /= Math.max(1, mCnt);
        mDiffG /= Math.max(1, mCnt);
        mDiffB /= Math.max(1, mCnt);

        for (let oy = -pHalf; oy <= pHalf; oy++) {
          for (let ox = -pHalf; ox <= pHalf; ox++) {
            const tPix = (cy + oy) * rw + (cx + ox);
            if (mask[tPix] === 0) continue;
            const si = ((bsy + oy) * rw + (bsx + ox)) * 4;
            const wgt = 1 / (1 + ox * ox + oy * oy);
            texOut[tPix * 3] += (before.data[si] + mDiffR * 0.72) * wgt;
            texOut[tPix * 3 + 1] += (before.data[si + 1] + mDiffG * 0.72) * wgt;
            texOut[tPix * 3 + 2] += (before.data[si + 2] + mDiffB * 0.72) * wgt;
            texWgt[tPix] += wgt;
          }
        }
      }
    }

    const fadeDist = Math.max(3.0, 3.0 * scaleFactor);
    for (let i = 0; i < len; i++) {
      if (mask[i] === 1 && texWgt[i] > 0) {
        const edgeFade = clamp(dist[i] / fadeDist, 0.35, 0.88);
        const tr = texOut[i * 3] / texWgt[i];
        const tg = texOut[i * 3 + 1] / texWgt[i];
        const tb = texOut[i * 3 + 2] / texWgt[i];

        work[i * 4] = clamp255(work[i * 4] * (1 - edgeFade) + tr * edgeFade);
        work[i * 4 + 1] = clamp255(work[i * 4 + 1] * (1 - edgeFade) + tg * edgeFade);
        work[i * 4 + 2] = clamp255(work[i * 4 + 2] * (1 - edgeFade) + tb * edgeFade);
      }
    }
  }

  return new ImageData(work, rw, rh);
}

/**
 * Multi-Scale Diffusion + Exemplar Patch-Matching Inpainting for Object Removal.
 * Reconstructs masked regions from surrounding texture & structure locally in browser.
 */
export function inpaintObjectRemoval(
  retouchCanvas: HTMLCanvasElement,
  maskCanvas: HTMLCanvasElement
): DirtyPatchResult | null {
  const ctx = retouchCanvas.getContext('2d', { willReadFrequently: true });
  const mCtx = maskCanvas.getContext('2d', { willReadFrequently: true });
  if (!ctx || !mCtx) return null;

  const w = retouchCanvas.width;
  const h = retouchCanvas.height;
  const fullMask = mCtx.getImageData(0, 0, w, h).data;

  // Find tight bounding box of selected object mask
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (fullMask[(y * w + x) * 4 + 3] > 20) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < minX || maxY < minY) return null;

  const maskW = maxX - minX + 1;
  const maskH = maxY - minY + 1;
  const pad = Math.max(44, Math.min(160, Math.round(Math.max(maskW, maskH) * 0.55)));

  const rx0 = Math.max(0, minX - pad);
  const ry0 = Math.max(0, minY - pad);
  const rx1 = Math.min(w - 1, maxX + pad);
  const ry1 = Math.min(h - 1, maxY + pad);
  const rw = rx1 - rx0 + 1;
  const rh = ry1 - ry0 + 1;

  const before = ctx.getImageData(rx0, ry0, rw, rh);
  const rawMask = new Uint8Array(rw * rh);
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      const gx = rx0 + x;
      const gy = ry0 + y;
      rawMask[y * rw + x] = fullMask[(gy * w + gx) * 4 + 3] > 20 ? 1 : 0;
    }
  }

  const after = inpaintMaskedRoi(before, rawMask, rw, rh, 1);
  if (!after) return null;

  ctx.putImageData(after, rx0, ry0);

  return {
    rect: { x: rx0, y: ry0, width: rw, height: rh },
    before,
    after,
  };
}

/**
 * Non-blocking wrapper for interactive Object Removal so spinner/UI stays responsive
 * before heavy Telea + exemplar synthesis executes on large selections.
 */
export async function inpaintObjectRemovalAsync(
  retouchCanvas: HTMLCanvasElement,
  maskCanvas: HTMLCanvasElement
): Promise<DirtyPatchResult | null> {
  await new Promise((r) => setTimeout(r, 0));
  return inpaintObjectRemoval(retouchCanvas, maskCanvas);
}

const MAX_ROI_PIXELS_SINGLE_PASS = 4_500_000;
const RETOUCH_TILE_SIZE = 1024;

function expandNormalizedStrokeDabs(
  points: RetouchNormPoint[],
  w: number,
  h: number,
  radius: number
): { x: number; y: number }[] {
  if (points.length === 0) return [];
  const dabs: { x: number; y: number }[] = [];
  let lastX = clamp(points[0].nx * w, 0, w - 1);
  let lastY = clamp(points[0].ny * h, 0, h - 1);
  dabs.push({ x: lastX, y: lastY });

  const step = Math.max(2, radius * 0.28);
  for (let i = 1; i < points.length; i++) {
    const px = clamp(points[i].nx * w, 0, w - 1);
    const py = clamp(points[i].ny * h, 0, h - 1);
    const dx = px - lastX;
    const dy = py - lastY;
    const dist = Math.hypot(dx, dy);
    if (dist < 1) continue;
    const steps = Math.max(1, Math.ceil(dist / step));
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      dabs.push({ x: lastX + dx * t, y: lastY + dy * t });
    }
    lastX = px;
    lastY = py;
  }
  return dabs;
}

function replayHealingOpOnCanvas(
  targetCanvas: HTMLCanvasElement,
  op: Extract<RetouchOperation, { kind: 'healing' }>
): void {
  const ctx = targetCanvas.getContext('2d', { willReadFrequently: true });
  if (!ctx || op.points.length === 0) return;

  const w = targetCanvas.width;
  const h = targetCanvas.height;
  const radius = Math.max(3, op.radiusNorm * Math.max(w, h));
  const outerR = Math.min(radius * 1.9, radius + Math.max(26, radius * 0.45));
  const dabs = expandNormalizedStrokeDabs(op.points, w, h, radius);
  if (dabs.length === 0) return;

  let minX = w;
  let minY = h;
  let maxX = 0;
  let maxY = 0;
  for (const d of dabs) {
    if (d.x < minX) minX = d.x;
    if (d.x > maxX) maxX = d.x;
    if (d.y < minY) minY = d.y;
    if (d.y > maxY) maxY = d.y;
  }

  const pad = Math.ceil(outerR) + 2;
  const rx0 = Math.max(0, Math.floor(minX - pad));
  const ry0 = Math.max(0, Math.floor(minY - pad));
  const rx1 = Math.min(w - 1, Math.ceil(maxX + pad));
  const ry1 = Math.min(h - 1, Math.ceil(maxY + pad));
  const rw = rx1 - rx0 + 1;
  const rh = ry1 - ry0 + 1;
  if (rw <= 2 || rh <= 2) return;

  if (rw * rh <= MAX_ROI_PIXELS_SINGLE_PASS) {
    const roiCanvas = document.createElement('canvas');
    roiCanvas.width = rw;
    roiCanvas.height = rh;
    const snapCanvas = document.createElement('canvas');
    snapCanvas.width = rw;
    snapCanvas.height = rh;

    roiCanvas.getContext('2d', { willReadFrequently: true })?.drawImage(
      targetCanvas,
      rx0,
      ry0,
      rw,
      rh,
      0,
      0,
      rw,
      rh
    );
    snapCanvas.getContext('2d', { willReadFrequently: true })?.drawImage(roiCanvas, 0, 0);

    for (const d of dabs) {
      paintHealingDab(roiCanvas, snapCanvas, d.x - rx0, d.y - ry0, radius, op.softnessPct);
    }

    ctx.drawImage(roiCanvas, rx0, ry0);
    roiCanvas.width = 0;
    roiCanvas.height = 0;
    snapCanvas.width = 0;
    snapCanvas.height = 0;
    return;
  }

  // Tile processing for ultra-wide strokes to bound RAM without mutating pre-stroke source
  const tileResults: { x: number; y: number; data: ImageData }[] = [];
  const dabRadiusPad = Math.ceil(radius) + 2;

  for (let ty0 = ry0; ty0 <= ry1; ty0 += RETOUCH_TILE_SIZE) {
    const ty1 = Math.min(ry1, ty0 + RETOUCH_TILE_SIZE - 1);
    const th = ty1 - ty0 + 1;
    for (let tx0 = rx0; tx0 <= rx1; tx0 += RETOUCH_TILE_SIZE) {
      const tx1 = Math.min(rx1, tx0 + RETOUCH_TILE_SIZE - 1);
      const tw = tx1 - tx0 + 1;

      const tileDabs = dabs.filter(
        (d) =>
          d.x >= tx0 - dabRadiusPad &&
          d.x <= tx1 + dabRadiusPad &&
          d.y >= ty0 - dabRadiusPad &&
          d.y <= ty1 + dabRadiusPad
      );
      if (tileDabs.length === 0) continue;

      const px0 = Math.max(0, tx0 - pad);
      const py0 = Math.max(0, ty0 - pad);
      const px1 = Math.min(w - 1, tx1 + pad);
      const py1 = Math.min(h - 1, ty1 + pad);
      const pw = px1 - px0 + 1;
      const ph = py1 - py0 + 1;

      const tileWork = document.createElement('canvas');
      tileWork.width = pw;
      tileWork.height = ph;
      const tileSnap = document.createElement('canvas');
      tileSnap.width = pw;
      tileSnap.height = ph;

      const twCtx = tileWork.getContext('2d', { willReadFrequently: true });
      const tsCtx = tileSnap.getContext('2d', { willReadFrequently: true });
      if (!twCtx || !tsCtx) continue;

      twCtx.drawImage(targetCanvas, px0, py0, pw, ph, 0, 0, pw, ph);
      tsCtx.drawImage(tileWork, 0, 0);

      for (const d of tileDabs) {
        paintHealingDab(tileWork, tileSnap, d.x - px0, d.y - py0, radius, op.softnessPct);
      }

      const innerImg = twCtx.getImageData(tx0 - px0, ty0 - py0, tw, th);
      tileResults.push({ x: tx0, y: ty0, data: innerImg });
      tileWork.width = 0;
      tileWork.height = 0;
      tileSnap.width = 0;
      tileSnap.height = 0;
    }
  }

  for (const res of tileResults) {
    ctx.putImageData(res.data, res.x, res.y);
  }
}

function replayCloneOpOnCanvas(
  targetCanvas: HTMLCanvasElement,
  op: Extract<RetouchOperation, { kind: 'clone' }>
): void {
  const ctx = targetCanvas.getContext('2d', { willReadFrequently: true });
  if (!ctx || op.points.length === 0) return;

  const w = targetCanvas.width;
  const h = targetCanvas.height;
  const radius = Math.max(2, op.radiusNorm * Math.max(w, h));
  const deltaPxX = op.deltaNx * w;
  const deltaPxY = op.deltaNy * h;
  const dabs = expandNormalizedStrokeDabs(op.points, w, h, radius);
  if (dabs.length === 0) return;

  let minX = w;
  let minY = h;
  let maxX = 0;
  let maxY = 0;
  for (const d of dabs) {
    if (d.x < minX) minX = d.x;
    if (d.x > maxX) maxX = d.x;
    if (d.y < minY) minY = d.y;
    if (d.y > maxY) maxY = d.y;
  }

  const pad = Math.ceil(radius) + 2;
  const dx0 = Math.max(0, Math.floor(minX - pad));
  const dy0 = Math.max(0, Math.floor(minY - pad));
  const dx1 = Math.min(w - 1, Math.ceil(maxX + pad));
  const dy1 = Math.min(h - 1, Math.ceil(maxY + pad));
  const dw = dx1 - dx0 + 1;
  const dh = dy1 - dy0 + 1;
  if (dw <= 0 || dh <= 0) return;

  const sx0 = clamp(Math.floor(dx0 + deltaPxX), 0, w - 1);
  const sy0 = clamp(Math.floor(dy0 + deltaPxY), 0, h - 1);
  const sx1 = clamp(Math.ceil(dx1 + deltaPxX), 0, w - 1);
  const sy1 = clamp(Math.ceil(dy1 + deltaPxY), 0, h - 1);
  const sw = Math.max(1, sx1 - sx0 + 1);
  const sh = Math.max(1, sy1 - sy0 + 1);

  if (dw * dh <= MAX_ROI_PIXELS_SINGLE_PASS && sw * sh <= MAX_ROI_PIXELS_SINGLE_PASS) {
    const dstCanvas = document.createElement('canvas');
    dstCanvas.width = dw;
    dstCanvas.height = dh;
    const srcCanvas = document.createElement('canvas');
    srcCanvas.width = sw;
    srcCanvas.height = sh;

    dstCanvas.getContext('2d', { willReadFrequently: true })?.drawImage(
      targetCanvas,
      dx0,
      dy0,
      dw,
      dh,
      0,
      0,
      dw,
      dh
    );
    srcCanvas.getContext('2d', { willReadFrequently: true })?.drawImage(
      targetCanvas,
      sx0,
      sy0,
      sw,
      sh,
      0,
      0,
      sw,
      sh
    );

    for (const d of dabs) {
      paintCloneDab(
        dstCanvas,
        srcCanvas,
        d.x - dx0,
        d.y - dy0,
        d.x + deltaPxX - sx0,
        d.y + deltaPxY - sy0,
        radius,
        op.hardnessPct,
        op.opacityPct
      );
    }

    ctx.drawImage(dstCanvas, dx0, dy0);
    dstCanvas.width = 0;
    dstCanvas.height = 0;
    srcCanvas.width = 0;
    srcCanvas.height = 0;
    return;
  }

  // Tile processing for huge clone strokes to bound RAM while reading untouched source
  const tileResults: { x: number; y: number; data: ImageData }[] = [];
  for (let ty0 = dy0; ty0 <= dy1; ty0 += RETOUCH_TILE_SIZE) {
    const ty1 = Math.min(dy1, ty0 + RETOUCH_TILE_SIZE - 1);
    const tw0Max = ty1 - ty0 + 1;
    for (let tx0 = dx0; tx0 <= dx1; tx0 += RETOUCH_TILE_SIZE) {
      const tx1 = Math.min(dx1, tx0 + RETOUCH_TILE_SIZE - 1);
      const tw = tx1 - tx0 + 1;

      const tileDabs = dabs.filter(
        (d) =>
          d.x >= tx0 - pad &&
          d.x <= tx1 + pad &&
          d.y >= ty0 - pad &&
          d.y <= ty1 + pad
      );
      if (tileDabs.length === 0) continue;

      const tsx0 = clamp(Math.floor(tx0 + deltaPxX - pad), 0, w - 1);
      const tsy0 = clamp(Math.floor(ty0 + deltaPxY - pad), 0, h - 1);
      const tsx1 = clamp(Math.ceil(tx1 + deltaPxX + pad), 0, w - 1);
      const tsy1 = clamp(Math.ceil(ty1 + deltaPxY + pad), 0, h - 1);
      const tsw = Math.max(1, tsx1 - tsx0 + 1);
      const tsh = Math.max(1, tsy1 - tsy0 + 1);

      const tileDst = document.createElement('canvas');
      tileDst.width = tw;
      tileDst.height = tw0Max;
      const tileSrc = document.createElement('canvas');
      tileSrc.width = tsw;
      tileSrc.height = tsh;

      const tdCtx = tileDst.getContext('2d', { willReadFrequently: true });
      const tsCtx = tileSrc.getContext('2d', { willReadFrequently: true });
      if (!tdCtx || !tsCtx) continue;

      tdCtx.drawImage(targetCanvas, tx0, ty0, tw, tw0Max, 0, 0, tw, tw0Max);
      tsCtx.drawImage(targetCanvas, tsx0, tsy0, tsw, tsh, 0, 0, tsw, tsh);

      for (const d of tileDabs) {
        paintCloneDab(
          tileDst,
          tileSrc,
          d.x - tx0,
          d.y - ty0,
          d.x + deltaPxX - tsx0,
          d.y + deltaPxY - tsy0,
          radius,
          op.hardnessPct,
          op.opacityPct
        );
      }

      tileResults.push({ x: tx0, y: ty0, data: tdCtx.getImageData(0, 0, tw, tw0Max) });
      tileDst.width = 0;
      tileDst.height = 0;
      tileSrc.width = 0;
      tileSrc.height = 0;
    }
  }

  for (const res of tileResults) {
    ctx.putImageData(res.data, res.x, res.y);
  }
}

function replayObjectRemovalOpOnCanvas(
  targetCanvas: HTMLCanvasElement,
  op: Extract<RetouchOperation, { kind: 'object-removal' }>
): void {
  const ctx = targetCanvas.getContext('2d', { willReadFrequently: true });
  if (!ctx || op.maskWidth <= 0 || op.maskHeight <= 0) return;

  const w = targetCanvas.width;
  const h = targetCanvas.height;

  const natMinX = clamp(Math.floor(op.normRect.x * w), 0, w - 1);
  const natMinY = clamp(Math.floor(op.normRect.y * h), 0, h - 1);
  const natMaxX = clamp(Math.ceil((op.normRect.x + op.normRect.width) * w) - 1, natMinX, w - 1);
  const natMaxY = clamp(Math.ceil((op.normRect.y + op.normRect.height) * h) - 1, natMinY, h - 1);
  const natMaskW = natMaxX - natMinX + 1;
  const natMaskH = natMaxY - natMinY + 1;

  const scaleFactor = Math.max(1, Math.max(w, h) / MAX_RETOUCH_DIMENSION);
  const pad = Math.min(
    360,
    Math.max(Math.round(44 * scaleFactor), Math.min(Math.round(160 * scaleFactor), Math.round(Math.max(natMaskW, natMaskH) * 0.55)))
  );

  const rx0 = Math.max(0, natMinX - pad);
  const ry0 = Math.max(0, natMinY - pad);
  const rx1 = Math.min(w - 1, natMaxX + pad);
  const ry1 = Math.min(h - 1, natMaxY + pad);
  const rw = rx1 - rx0 + 1;
  const rh = ry1 - ry0 + 1;
  if (rw <= 2 || rh <= 2) return;

  const before = ctx.getImageData(rx0, ry0, rw, rh);
  const rawMask = new Uint8Array(rw * rh);

  const mw = op.maskWidth;
  const mh = op.maskHeight;
  const mb = op.maskBytes;

  for (let y = natMinY; y <= natMaxY; y++) {
    const syF = natMaskH > 1 ? ((y - natMinY) / (natMaskH - 1)) * (mh - 1) : 0;
    const sy0 = Math.floor(syF);
    const sy1 = Math.min(mh - 1, sy0 + 1);
    const ty = syF - sy0;
    const roiRow = (y - ry0) * rw;

    for (let x = natMinX; x <= natMaxX; x++) {
      const sxF = natMaskW > 1 ? ((x - natMinX) / (natMaskW - 1)) * (mw - 1) : 0;
      const sx0 = Math.floor(sxF);
      const sx1 = Math.min(mw - 1, sx0 + 1);
      const tx = sxF - sx0;

      const v00 = mb[sy0 * mw + sx0];
      const v10 = mb[sy0 * mw + sx1];
      const v01 = mb[sy1 * mw + sx0];
      const v11 = mb[sy1 * mw + sx1];
      const val =
        (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty;

      if (val > 85) {
        rawMask[roiRow + (x - rx0)] = 1;
      }
    }
  }

  const after = inpaintMaskedRoi(before, rawMask, rw, rh, scaleFactor);
  if (after) {
    ctx.putImageData(after, rx0, ry0);
  }
}

/**
 * Replays recorded resolution-independent retouch operations sequentially onto a
 * full-resolution canvas using bounded ROI/tile buffers.
 */
export async function replayRetouchOperationsOnCanvas(
  targetCanvas: HTMLCanvasElement,
  ops: RetouchOperation[]
): Promise<void> {
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op.kind === 'healing') {
      replayHealingOpOnCanvas(targetCanvas, op);
    } else if (op.kind === 'clone') {
      replayCloneOpOnCanvas(targetCanvas, op);
    } else if (op.kind === 'object-removal') {
      replayObjectRemovalOpOnCanvas(targetCanvas, op);
    }
    // Yield between operations on heavy native canvases to keep browser UI responsive
    if (i < ops.length - 1) {
      await new Promise((r) => setTimeout(r, 0));
    }
  }
}

/**
 * Builds a native-resolution canvas from sourceImage and replays all RGB retouch operations
 * at full native dimensions without upscaling the 2048px preview buffer.
 */
export async function createNativeRetouchedCanvas(
  sourceImage: HTMLImageElement,
  ops: RetouchOperation[]
): Promise<HTMLCanvasElement> {
  const canvas = document.createElement('canvas');
  canvas.width = sourceImage.naturalWidth;
  canvas.height = sourceImage.naturalHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (ctx) {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(sourceImage, 0, 0, canvas.width, canvas.height);
  }
  if (ops.length > 0) {
    await replayRetouchOperationsOnCanvas(canvas, ops);
  }
  return canvas;
}

/**
 * Synchronizes manual brush override deltas against refinedBaseAlpha inside a dirty region,
 * or resets manual deltas if refinedBaseAlpha is absent.
 */
export function syncManualAlphaDeltaRect(
  buffers: RetouchBuffers,
  rect: DirtyRect
): void {
  if (!buffers.refinedBaseAlpha || !buffers.manualAlphaDelta) return;
  const aCtx = buffers.alphaCanvas.getContext('2d', { willReadFrequently: true });
  if (!aCtx) return;

  const w = buffers.width;
  const x0 = Math.max(0, rect.x);
  const y0 = Math.max(0, rect.y);
  const bw = Math.min(w - x0, rect.width);
  const bh = Math.min(buffers.height - y0, rect.height);
  if (bw <= 0 || bh <= 0) return;

  const patchData = aCtx.getImageData(x0, y0, bw, bh).data;
  for (let py = 0; py < bh; py++) {
    const gy = y0 + py;
    for (let px = 0; px < bw; px++) {
      const gx = x0 + px;
      const idx = gy * w + gx;
      const alphaVal = patchData[(py * bw + px) * 4];
      buffers.manualAlphaDelta[idx] = alphaVal - buffers.refinedBaseAlpha[idx];
    }
  }
}

/**
 * Re-runs non-destructive edge refinement (Refine Edge, Feather, Smooth, Contrast,
 * Expand/Contract, Hair Refinement) from buffers.rawAutoAlpha while preserving
 * manual Restore/Erase brush edits cleanly.
 */
export function applyRefinementToAlphaBuffer(
  buffers: RetouchBuffers,
  settings: BgRefinementSettings
): DirtyPatchResult | null {
  const rCtx = buffers.retouchCanvas.getContext('2d', { willReadFrequently: true });
  const aCtx = buffers.alphaCanvas.getContext('2d', { willReadFrequently: true });
  if (!rCtx || !aCtx) return null;

  const w = buffers.width;
  const h = buffers.height;
  const before = aCtx.getImageData(0, 0, w, h);

  // If user drew manual mask first without running Auto Remove, snapshot it as rawAutoAlpha
  if (!buffers.rawAutoAlpha) {
    const snap = new Uint8ClampedArray(w * h);
    for (let i = 0; i < snap.length; i++) {
      snap[i] = before.data[i * 4];
    }
    buffers.rawAutoAlpha = snap;
    buffers.manualAlphaDelta = new Int16Array(w * h);
  }

  const rgba = rCtx.getImageData(0, 0, w, h).data;
  const refined = refineBackgroundAlphaMask(
    rgba,
    buffers.rawAutoAlpha,
    w,
    h,
    settings
  );
  buffers.refinedBaseAlpha = refined;

  if (!buffers.manualAlphaDelta) {
    buffers.manualAlphaDelta = new Int16Array(w * h);
  }

  const outData = aCtx.createImageData(w, h);
  const od = outData.data;
  const delta = buffers.manualAlphaDelta;
  for (let i = 0; i < refined.length; i++) {
    const v = clamp255(refined[i] + delta[i]);
    const i4 = i * 4;
    od[i4] = v;
    od[i4 + 1] = v;
    od[i4 + 2] = v;
    od[i4 + 3] = 255;
  }

  aCtx.putImageData(outData, 0, 0);
  return {
    rect: { x: 0, y: 0, width: w, height: h },
    before,
    after: outData,
  };
}

/**
 * Automatic Open-Source AI Background Remover:
 * Uses MODNet (Portrait hair & human detail) or RMBG-1.4 (General Object / Product)
 * via @huggingface/transformers (WebGPU/WASM locally in browser), followed by
 * guided edge refinement and hair alpha matting.
 */
export async function autoRemoveBackgroundAsync(
  buffers: RetouchBuffers,
  settings: BgRefinementSettings,
  onProgress?: (p: BgSegmentationProgress) => void
): Promise<{
  patch: DirtyPatchResult;
  usedModelId: string;
  usedDevice: string;
} | null> {
  const rCtx = buffers.retouchCanvas.getContext('2d', { willReadFrequently: true });
  const aCtx = buffers.alphaCanvas.getContext('2d', { willReadFrequently: true });
  if (!rCtx || !aCtx) return null;

  const w = buffers.width;
  const h = buffers.height;
  const before = aCtx.getImageData(0, 0, w, h);
  const rgba = rCtx.getImageData(0, 0, w, h).data;

  const effectiveMode = settings.mode === 'manual' ? 'general' : settings.mode;
  const { rawAlpha, usedModelId, usedDevice } = await segmentImageRgba(
    rgba,
    w,
    h,
    effectiveMode,
    onProgress
  );

  buffers.rawAutoAlpha = rawAlpha;
  buffers.manualAlphaDelta = new Int16Array(w * h);

  const refined = refineBackgroundAlphaMask(rgba, rawAlpha, w, h, settings);
  buffers.refinedBaseAlpha = refined;

  const outData = aCtx.createImageData(w, h);
  const od = outData.data;
  for (let i = 0; i < refined.length; i++) {
    const v = refined[i];
    const i4 = i * 4;
    od[i4] = v;
    od[i4 + 1] = v;
    od[i4 + 2] = v;
    od[i4 + 3] = 255;
  }
  aCtx.putImageData(outData, 0, 0);

  return {
    patch: {
      rect: { x: 0, y: 0, width: w, height: h },
      before,
      after: outData,
    },
    usedModelId,
    usedDevice,
  };
}

/**
 * Propagates user-painted Restore (Keep) and Erase (Remove) strokes along
 * color/edge boundaries for Manual Selection Mode, then applies active refinement sliders.
 */
export function applyManualSelectionSnap(
  buffers: RetouchBuffers,
  settings: BgRefinementSettings
): DirtyPatchResult | null {
  const rCtx = buffers.retouchCanvas.getContext('2d', { willReadFrequently: true });
  const aCtx = buffers.alphaCanvas.getContext('2d', { willReadFrequently: true });
  if (!rCtx || !aCtx) return null;

  const w = buffers.width;
  const h = buffers.height;
  const before = aCtx.getImageData(0, 0, w, h);
  const rgba = rCtx.getImageData(0, 0, w, h).data;

  const seedAlpha = new Uint8ClampedArray(w * h);
  for (let i = 0; i < seedAlpha.length; i++) {
    seedAlpha[i] = before.data[i * 4];
  }

  const propagated = propagateManualSelectionMask(rgba, seedAlpha, w, h);
  buffers.rawAutoAlpha = propagated;
  buffers.manualAlphaDelta = new Int16Array(w * h);

  const refined = refineBackgroundAlphaMask(rgba, propagated, w, h, settings);
  buffers.refinedBaseAlpha = refined;

  const outData = aCtx.createImageData(w, h);
  const od = outData.data;
  for (let i = 0; i < refined.length; i++) {
    const v = refined[i];
    const i4 = i * 4;
    od[i4] = v;
    od[i4 + 1] = v;
    od[i4 + 2] = v;
    od[i4 + 3] = 255;
  }
  aCtx.putImageData(outData, 0, 0);

  return {
    rect: { x: 0, y: 0, width: w, height: h },
    before,
    after: outData,
  };
}

/**
 * Synchronous local geodesic segmentation helper (used by non-destructive Masking panel).
 */
export function autoRemoveBackground(
  retouchCanvas: HTMLCanvasElement,
  alphaCanvas: HTMLCanvasElement
): DirtyPatchResult | null {
  const rCtx = retouchCanvas.getContext('2d', { willReadFrequently: true });
  const aCtx = alphaCanvas.getContext('2d', { willReadFrequently: true });
  if (!rCtx || !aCtx) return null;

  const w = retouchCanvas.width;
  const h = retouchCanvas.height;
  const before = aCtx.getImageData(0, 0, w, h);
  const rgba = rCtx.getImageData(0, 0, w, h).data;
  const maskBytes = localGeodesicFallbackSegmentation(rgba, w, h);

  const outData = aCtx.createImageData(w, h);
  const od = outData.data;
  for (let i = 0; i < maskBytes.length; i++) {
    const v = maskBytes[i];
    const i4 = i * 4;
    od[i4] = v;
    od[i4 + 1] = v;
    od[i4 + 2] = v;
    od[i4 + 3] = 255;
  }
  aCtx.putImageData(outData, 0, 0);

  return {
    rect: { x: 0, y: 0, width: w, height: h },
    before,
    after: outData,
  };
}

/**
 * Sets entire alphaCanvas to solid opaque (255) or solid transparent (0),
 * clearing cached auto-segmentation buffers cleanly.
 */
export function fillAlphaCanvasUniform(
  buffers: RetouchBuffers,
  value: 0 | 255
): DirtyPatchResult | null {
  const aCtx = buffers.alphaCanvas.getContext('2d', { willReadFrequently: true });
  if (!aCtx) return null;
  const before = aCtx.getImageData(0, 0, buffers.width, buffers.height);
  const hex = value === 255 ? '#ffffff' : '#000000';
  aCtx.fillStyle = hex;
  aCtx.fillRect(0, 0, buffers.width, buffers.height);
  const after = aCtx.getImageData(0, 0, buffers.width, buffers.height);
  buffers.rawAutoAlpha = null;
  buffers.refinedBaseAlpha = null;
  buffers.manualAlphaDelta = null;
  return {
    rect: { x: 0, y: 0, width: buffers.width, height: buffers.height },
    before,
    after,
  };
}

