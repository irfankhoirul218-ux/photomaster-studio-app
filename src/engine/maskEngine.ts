import {
  DEFAULT_LOCAL_ADJUSTMENTS,
  DirtyRect,
  LocalAdjustments,
  MaskComponent,
  MaskLayer,
  MaskRasterData,
  TransformState,
} from '../types/editor';
import { getRotatedDimensions } from './imageProcessor';
import { getDevicePerformanceProfile } from './performanceProfile';
import { autoRemoveBackground } from './retouchEngine';

export const MAX_MASK_DIMENSION = 1024;

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

// ---------- Memoization & Revision Caches ----------
const objectUidMap = new WeakMap<object, number>();
let nextObjectUid = 1;
function getObjectUid(obj: object): number {
  let id = objectUidMap.get(obj);
  if (id === undefined) {
    id = nextObjectUid++;
    objectUidMap.set(obj, id);
  }
  return id;
}

const rasterBufferVersions = new WeakMap<Uint8Array, number>();
function getBufferVersion(buf: Uint8Array): number {
  return rasterBufferVersions.get(buf) ?? 0;
}

export function bumpMaskRasterVersion(buf: Uint8Array): void {
  rasterBufferVersions.set(buf, getBufferVersion(buf) + 1);
}

let basePixelCacheEpoch = 1;
export function invalidateMaskBasePixelCache(): void {
  basePixelCacheEpoch++;
}

const sourceBaseRgbaCache = new WeakMap<
  HTMLImageElement | HTMLCanvasElement,
  { epoch: number; width: number; height: number; data: Uint8ClampedArray }
>();

export function getCachedBaseSourceRgba(
  source: HTMLImageElement | HTMLCanvasElement,
  width: number,
  height: number
): Uint8ClampedArray | undefined {
  const cached = sourceBaseRgbaCache.get(source);
  if (cached && cached.epoch === basePixelCacheEpoch && cached.width === width && cached.height === height) {
    return cached.data;
  }
  if (typeof document === 'undefined') return undefined;
  const tmp = document.createElement('canvas');
  tmp.width = width;
  tmp.height = height;
  const tCtx = tmp.getContext('2d', { willReadFrequently: true });
  if (!tCtx) return undefined;
  tCtx.drawImage(source, 0, 0, width, height);
  const data = tCtx.getImageData(0, 0, width, height).data;
  sourceBaseRgbaCache.set(source, { epoch: basePixelCacheEpoch, width, height, data });
  return data;
}

export function getMaskSourceCacheKey(source: HTMLImageElement | HTMLCanvasElement): string {
  return `${getObjectUid(source)}@${basePixelCacheEpoch}`;
}

export type BaseRgbaInput =
  | Uint8ClampedArray
  | { key: string; getRgba: () => Uint8ClampedArray | undefined };

const baseAlphaLruCache = new Map<string, Float32Array>();
const COMPONENT_ALPHA_CACHE_LIMIT = 14;
const componentAlphaLruCache = new Map<string, Float32Array>();

export interface ProjectedMaskResult {
  alpha: Float32Array;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const PROJECTED_ALPHA_CACHE_LIMIT = 6;
const projectedAlphaCache = new WeakMap<Float32Array, Map<string, ProjectedMaskResult>>();

/**
 * Computes normalized base dimensions used by raster masks, adapted to device tier.
 */
export function getMaskRasterDimensions(srcW: number, srcH: number): { width: number; height: number } {
  const maxDim = getDevicePerformanceProfile().maskMaxDim;
  const longest = Math.max(1, srcW, srcH);
  const scale = longest > maxDim ? maxDim / longest : 1;
  return {
    width: Math.max(16, Math.round(srcW * scale)),
    height: Math.max(16, Math.round(srcH * scale)),
  };
}

export function createEmptyMaskRaster(width: number, height: number, fillValue = 0): MaskRasterData {
  const data = new Uint8Array(width * height);
  if (fillValue !== 0) data.fill(fillValue);
  return { width, height, data };
}

export function cloneMaskRaster(r: MaskRasterData): MaskRasterData {
  return {
    width: r.width,
    height: r.height,
    data: new Uint8Array(r.data),
  };
}

export function cloneMaskLayer(layer: MaskLayer): MaskLayer {
  return {
    ...layer,
    adjustments: { ...layer.adjustments },
    components: layer.components.map((c) => {
      if (c.kind === 'brush' || c.kind === 'subject' || c.kind === 'sky' || c.kind === 'background' || c.kind === 'object') {
        return { ...c, raster: cloneMaskRaster(c.raster) };
      }
      if (c.kind === 'mask-ref') {
        return { ...c, sourceRaster: cloneMaskRaster(c.sourceRaster) };
      }
      if (c.kind === 'color-range') {
        return { ...c, targetRgb: [...c.targetRgb] as [number, number, number] };
      }
      return { ...c };
    }),
  };
}

export function cloneMaskLayers(layers: MaskLayer[]): MaskLayer[] {
  return layers.map(cloneMaskLayer);
}

export function createDefaultMaskLayer(
  index: number,
  name: string,
  components: MaskComponent[]
): MaskLayer {
  const palette = ['#ef4444', '#3b82f6', '#22c55e', '#f59e0b', '#ec4899'];
  return {
    id: `mask-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name,
    enabled: true,
    inverted: false,
    overlayColor: palette[(index - 1) % palette.length],
    showOverlay: true,
    feather: 0,
    density: 100,
    edgeRefinement: 15,
    components,
    adjustments: { ...DEFAULT_LOCAL_ADJUSTMENTS },
  };
}

export function hasNonZeroLocalAdjustments(adj: LocalAdjustments): boolean {
  return (
    adj.exposure !== 0 ||
    adj.brightness !== 0 ||
    adj.contrast !== 0 ||
    adj.highlights !== 0 ||
    adj.shadows !== 0 ||
    adj.whites !== 0 ||
    adj.blacks !== 0 ||
    adj.temperature !== 0 ||
    adj.tint !== 0 ||
    adj.saturation !== 0 ||
    adj.texture !== 0 ||
    adj.clarity !== 0 ||
    adj.dehaze !== 0 ||
    adj.sharpness !== 0 ||
    adj.noiseReduction !== 0
  );
}

/**
 * Separable 1D blur on Uint8Array / Float32Array single-channel alpha maps.
 */
function blurFloatAlpha(src: Float32Array, width: number, height: number, radius: number): Float32Array {
  const r = Math.max(1, Math.round(radius));
  const win = r * 2 + 1;
  const tmp = new Float32Array(width * height);
  const dst = new Float32Array(width * height);

  for (let y = 0; y < height; y++) {
    const row = y * width;
    let sum = 0;
    for (let k = -r; k <= r; k++) {
      const sx = k < 0 ? 0 : k >= width ? width - 1 : k;
      sum += src[row + sx];
    }
    for (let x = 0; x < width; x++) {
      tmp[row + x] = sum / win;
      const lx = x - r < 0 ? 0 : x - r;
      const rx = x + r + 1 >= width ? width - 1 : x + r + 1;
      sum += src[row + rx] - src[row + lx];
    }
  }

  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) {
      const sy = k < 0 ? 0 : k >= height ? height - 1 : k;
      sum += tmp[sy * width + x];
    }
    for (let y = 0; y < height; y++) {
      dst[y * width + x] = sum / win;
      const ty = y - r < 0 ? 0 : y - r;
      const by = y + r + 1 >= height ? height - 1 : y + r + 1;
      sum += tmp[by * width + x] - tmp[ty * width + x];
    }
  }
  return dst;
}

/**
 * Paints a soft/hard circular dab onto a MaskRasterData buffer with Flow & Density limits.
 */
export function paintMaskBrushDab(
  raster: MaskRasterData,
  nx: number,
  ny: number,
  radiusPx: number,
  featherPct: number,
  flowPct: number,
  densityPct: number,
  isErase = false
): DirtyRect | null {
  const w = raster.width;
  const h = raster.height;
  const cx = nx * (w - 1);
  const cy = ny * (h - 1);
  const r = Math.max(2, radiusPx);

  const x0 = Math.max(0, Math.floor(cx - r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const x1 = Math.min(w - 1, Math.ceil(cx + r));
  const y1 = Math.min(h - 1, Math.ceil(cy + r));
  const bw = x1 - x0 + 1;
  const bh = y1 - y0 + 1;
  if (bw <= 0 || bh <= 0) return null;

  const hardness = clamp(1 - featherPct / 100, 0, 0.98);
  const flow = clamp(flowPct / 100, 0.02, 1);
  const densityMax = clamp255((densityPct / 100) * 255);
  const rSq = r * r;

  for (let py = y0; py <= y1; py++) {
    const dy = py - cy;
    const dy2 = dy * dy;
    for (let px = x0; px <= x1; px++) {
      const dx = px - cx;
      const d2 = dx * dx + dy2;
      if (d2 > rSq) continue;

      const distNorm = Math.sqrt(d2) / r;
      const falloff =
        distNorm <= hardness ? 1 : 1 - smoothstep(hardness, 1.0, distNorm);
      const strength = falloff * flow;
      if (strength <= 0.002) continue;

      const idx = py * w + px;
      const cur = raster.data[idx];
      if (isErase) {
        const next = Math.round(cur * (1 - strength));
        raster.data[idx] = Math.min(cur, Math.max(0, next));
      } else {
        const next = Math.round(cur + (densityMax - cur) * strength);
        raster.data[idx] = Math.max(cur, Math.min(densityMax, next));
      }
    }
  }

  bumpMaskRasterVersion(raster.data);
  return { x: x0, y: y0, width: bw, height: bh };
}

/**
 * Generates an automatic Subject mask using the geodesic barrier saliency engine.
 */
export function computeSubjectRasterMask(sourceCanvas: HTMLCanvasElement): MaskRasterData {
  const { width, height } = getMaskRasterDimensions(sourceCanvas.width, sourceCanvas.height);

  const tmpRetouch = document.createElement('canvas');
  tmpRetouch.width = width;
  tmpRetouch.height = height;
  tmpRetouch.getContext('2d')?.drawImage(sourceCanvas, 0, 0, width, height);

  const tmpAlpha = document.createElement('canvas');
  tmpAlpha.width = width;
  tmpAlpha.height = height;
  const aCtx = tmpAlpha.getContext('2d', { willReadFrequently: true });
  if (aCtx) {
    aCtx.fillStyle = '#ffffff';
    aCtx.fillRect(0, 0, width, height);
  }

  autoRemoveBackground(tmpRetouch, tmpAlpha);

  const out = createEmptyMaskRaster(width, height);
  if (aCtx) {
    const data = aCtx.getImageData(0, 0, width, height).data;
    for (let i = 0; i < width * height; i++) {
      out.data[i] = data[i * 4];
    }
  }
  return out;
}

/**
 * Generates an automatic Background mask as the clean complement of Subject selection.
 */
export function computeBackgroundRasterMask(sourceCanvas: HTMLCanvasElement): MaskRasterData {
  const subj = computeSubjectRasterMask(sourceCanvas);
  const out = createEmptyMaskRaster(subj.width, subj.height);
  for (let i = 0; i < subj.data.length; i++) {
    out.data[i] = 255 - subj.data[i];
  }
  return out;
}

/**
 * Local Heuristic Sky Selection:
 * Combines top-down spatial horizon prior, sky chromatic affinity (clear blue, overcast bright,
 * sunset gold/magenta with smooth local texture), and edge-barrier geodesic propagation
 * from top image corners. Purely local browser math (zero cloud APIs).
 */
export function computeSkyRasterMask(sourceCanvas: HTMLCanvasElement): MaskRasterData {
  const { width: fullW, height: fullH } = getMaskRasterDimensions(
    sourceCanvas.width,
    sourceCanvas.height
  );

  // Downsample to <= 200px for geodesic horizon propagation
  const segMax = 200;
  const scale = Math.min(1, segMax / Math.max(fullW, fullH));
  const sw = Math.max(16, Math.round(fullW * scale));
  const sh = Math.max(16, Math.round(fullH * scale));

  const small = document.createElement('canvas');
  small.width = sw;
  small.height = sh;
  const sCtx = small.getContext('2d', { willReadFrequently: true });
  const out = createEmptyMaskRaster(fullW, fullH);
  if (!sCtx) return out;

  sCtx.drawImage(sourceCanvas, 0, 0, sw, sh);
  const rgba = sCtx.getImageData(0, 0, sw, sh).data;
  const n = sw * sh;

  const L = new Float32Array(n);
  const C1 = new Float32Array(n);
  const C2 = new Float32Array(n);
  const skyColorPrior = new Float32Array(n);

  // Estimate dominant upper-band sky color statistics (top 22%)
  const topRows = Math.max(2, Math.floor(sh * 0.22));
  let avgTopR = 0;
  let avgTopG = 0;
  let avgTopB = 0;
  let topCnt = 0;
  for (let y = 0; y < topRows; y++) {
    for (let x = 0; x < sw; x++) {
      const idx = (y * sw + x) * 4;
      avgTopR += rgba[idx] / 255;
      avgTopG += rgba[idx + 1] / 255;
      avgTopB += rgba[idx + 2] / 255;
      topCnt++;
    }
  }
  avgTopR /= Math.max(1, topCnt);
  avgTopG /= Math.max(1, topCnt);
  avgTopB /= Math.max(1, topCnt);

  for (let y = 0; y < sh; y++) {
    const ny = y / Math.max(1, sh - 1);
    const verticalPrior = 1 - smoothstep(0.18, 0.88, ny);
    for (let x = 0; x < sw; x++) {
      const i = y * sw + x;
      const idx = i * 4;
      const r = rgba[idx] / 255;
      const g = rgba[idx + 1] / 255;
      const b = rgba[idx + 2] / 255;

      L[i] = 0.299 * r + 0.587 * g + 0.114 * b;
      C1[i] = r - g;
      C2[i] = 0.5 * (r + g) - b;

      // Sky cues: blue-sky bias OR bright upper-band match OR sunset smooth luminance
      const blueBias = clamp((b - r * 0.85) * 2.4 + 0.35, 0, 1);
      const brightBias = smoothstep(0.28, 0.88, L[i]);
      const dTop = Math.hypot(r - avgTopR, g - avgTopG, b - avgTopB);
      const topMatch = Math.exp(-dTop * dTop * 6.5);

      skyColorPrior[i] = clamp(
        (0.45 * topMatch + 0.35 * blueBias + 0.2 * brightBias) * (0.25 + 0.75 * verticalPrior),
        0,
        1
      );
    }
  }

  // Local smoothness/low-texture cue
  const edgeStrength = new Float32Array(n);
  for (let y = 1; y < sh - 1; y++) {
    for (let x = 1; x < sw - 1; x++) {
      const i = y * sw + x;
      const gx = Math.abs(L[i + 1] - L[i - 1]) + Math.abs(C2[i + 1] - C2[i - 1]);
      const gy = Math.abs(L[i + sw] - L[i - sw]) + Math.abs(C2[i + sw] - C2[i - sw]);
      edgeStrength[i] = gx + gy;
    }
  }

  // Geodesic propagation downward from top border row (y = 0)
  const geoDist = new Float32Array(n).fill(1e6);
  for (let x = 0; x < sw; x++) {
    // Only seed top pixels that have plausible sky score
    geoDist[x] = skyColorPrior[x] > 0.22 ? 0 : 0.4;
  }

  const stepCost = (i: number, j: number): number => {
    const dL = L[i] - L[j];
    const d1 = C1[i] - C1[j];
    const d2 = C2[i] - C2[j];
    const cd = Math.sqrt(dL * dL * 1.6 + d1 * d1 * 2.0 + d2 * d2 * 2.2);
    const py = Math.floor(j / sw) / Math.max(1, sh - 1);
    return 0.006 + cd * 2.8 + edgeStrength[j] * 0.45 + (1 - skyColorPrior[j]) * 0.08 + py * 0.012;
  };

  for (let sweep = 0; sweep < 4; sweep++) {
    for (let y = 1; y < sh - 1; y++) {
      for (let x = 1; x < sw - 1; x++) {
        const i = y * sw + x;
        let d = geoDist[i];
        d = Math.min(d, geoDist[i - 1] + stepCost(i - 1, i));
        d = Math.min(d, geoDist[i - sw] + stepCost(i - sw, i));
        d = Math.min(d, geoDist[i - sw - 1] + stepCost(i - sw - 1, i) * 1.414);
        d = Math.min(d, geoDist[i - sw + 1] + stepCost(i - sw + 1, i) * 1.414);
        geoDist[i] = d;
      }
    }
    for (let y = sh - 2; y >= 1; y--) {
      for (let x = sw - 2; x >= 1; x--) {
        const i = y * sw + x;
        let d = geoDist[i];
        d = Math.min(d, geoDist[i + 1] + stepCost(i + 1, i));
        d = Math.min(d, geoDist[i + sw] + stepCost(i + sw, i));
        d = Math.min(d, geoDist[i + sw + 1] + stepCost(i + sw + 1, i) * 1.414);
        d = Math.min(d, geoDist[i + sw - 1] + stepCost(i + sw - 1, i) * 1.414);
        geoDist[i] = d;
      }
    }
  }

  const skySmall = new Float32Array(n);
  for (let y = 0; y < sh; y++) {
    const ny = y / Math.max(1, sh - 1);
    for (let x = 0; x < sw; x++) {
      const i = y * sw + x;
      const geoAffinity = Math.exp(-geoDist[i] * 2.9);
      const bottomCutoff = 1 - smoothstep(0.62, 0.94, ny);
      const score = geoAffinity * 0.65 + skyColorPrior[i] * 0.35;
      skySmall[i] = smoothstep(0.32, 0.56, score) * bottomCutoff;
    }
  }

  // Bilinearly upscale skySmall -> out
  for (let y = 0; y < fullH; y++) {
    const fy = (y / Math.max(1, fullH - 1)) * (sh - 1);
    const y0 = Math.floor(fy);
    const y1 = Math.min(sh - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < fullW; x++) {
      const fx = (x / Math.max(1, fullW - 1)) * (sw - 1);
      const x0 = Math.floor(fx);
      const x1 = Math.min(sw - 1, x0 + 1);
      const wx = fx - x0;

      const v00 = skySmall[y0 * sw + x0];
      const v10 = skySmall[y0 * sw + x1];
      const v01 = skySmall[y1 * sw + x0];
      const v11 = skySmall[y1 * sw + x1];
      const val =
        (v00 * (1 - wx) + v10 * wx) * (1 - wy) + (v01 * (1 - wx) + v11 * wx) * wy;
      out.data[y * fullW + x] = clamp255(val * 255);
    }
  }

  return out;
}

/**
 * Interactive Local Object Selection:
 * Given a user-drawn bounding box (normalized 0..1 coords), models outer border colors vs
 * interior colors and runs geodesic foreground segmentation inside the region.
 */
export function computeObjectSelectionRasterMask(
  sourceCanvas: HTMLCanvasElement,
  box: { x: number; y: number; width: number; height: number }
): MaskRasterData {
  const { width: fullW, height: fullH } = getMaskRasterDimensions(
    sourceCanvas.width,
    sourceCanvas.height
  );
  const out = createEmptyMaskRaster(fullW, fullH);

  const segMax = 200;
  const scale = Math.min(1, segMax / Math.max(fullW, fullH));
  const sw = Math.max(16, Math.round(fullW * scale));
  const sh = Math.max(16, Math.round(fullH * scale));

  const small = document.createElement('canvas');
  small.width = sw;
  small.height = sh;
  const sCtx = small.getContext('2d', { willReadFrequently: true });
  if (!sCtx) return out;
  sCtx.drawImage(sourceCanvas, 0, 0, sw, sh);
  const rgba = sCtx.getImageData(0, 0, sw, sh).data;

  const bx0 = Math.max(0, Math.floor(box.x * sw));
  const by0 = Math.max(0, Math.floor(box.y * sh));
  const bx1 = Math.min(sw - 1, Math.ceil((box.x + box.width) * sw));
  const by1 = Math.min(sh - 1, Math.ceil((box.y + box.height) * sh));
  const bw = Math.max(4, bx1 - bx0 + 1);
  const bh = Math.max(4, by1 - by0 + 1);

  // Sample border ring colors around box
  const ringColors: [number, number, number][] = [];
  const pad = Math.max(2, Math.round(Math.min(bw, bh) * 0.1));
  const ox0 = Math.max(0, bx0 - pad);
  const oy0 = Math.max(0, by0 - pad);
  const ox1 = Math.min(sw - 1, bx1 + pad);
  const oy1 = Math.min(sh - 1, by1 + pad);

  for (let y = oy0; y <= oy1; y++) {
    for (let x = ox0; x <= ox1; x++) {
      if (x <= bx0 || x >= bx1 || y <= by0 || y >= by1) {
        const i = (y * sw + x) * 4;
        ringColors.push([rgba[i] / 255, rgba[i + 1] / 255, rgba[i + 2] / 255]);
      }
    }
  }

  // Sample inner center core (center 35% of box) as foreground color seed
  const fgColors: [number, number, number][] = [];
  const ix0 = Math.round(bx0 + bw * 0.32);
  const ix1 = Math.round(bx1 - bw * 0.32);
  const iy0 = Math.round(by0 + bh * 0.32);
  const iy1 = Math.round(by1 - bh * 0.32);
  for (let y = iy0; y <= iy1; y++) {
    for (let x = ix0; x <= ix1; x++) {
      const i = (y * sw + x) * 4;
      fgColors.push([rgba[i] / 255, rgba[i + 1] / 255, rgba[i + 2] / 255]);
    }
  }

  const strideRing = Math.max(1, Math.floor(ringColors.length / 40));
  const strideFg = Math.max(1, Math.floor(fgColors.length / 40));

  const n = sw * sh;
  const objSmall = new Float32Array(n);
  const cxBox = (bx0 + bx1) / 2;
  const cyBox = (by0 + by1) / 2;
  const rxBox = Math.max(2, bw / 2);
  const ryBox = Math.max(2, bh / 2);

  for (let y = by0; y <= by1; y++) {
    for (let x = bx0; x <= bx1; x++) {
      const idx = (y * sw + x) * 4;
      const r = rgba[idx] / 255;
      const g = rgba[idx + 1] / 255;
      const b = rgba[idx + 2] / 255;

      let minBg = 999;
      for (let k = 0; k < ringColors.length; k += strideRing) {
        const rc = ringColors[k];
        const d = (r - rc[0]) ** 2 + (g - rc[1]) ** 2 + (b - rc[2]) ** 2;
        if (d < minBg) minBg = d;
      }

      let minFg = 999;
      for (let k = 0; k < fgColors.length; k += strideFg) {
        const fc = fgColors[k];
        const d = (r - fc[0]) ** 2 + (g - fc[1]) ** 2 + (b - fc[2]) ** 2;
        if (d < minFg) minFg = d;
      }

      const ellDist = Math.hypot((x - cxBox) / rxBox, (y - cyBox) / ryBox);
      const spatial = 1 - smoothstep(0.65, 1.05, ellDist);
      const colorRatio = minBg / Math.max(1e-4, minBg + minFg);
      const score = colorRatio * 0.68 + spatial * 0.32;
      objSmall[y * sw + x] = smoothstep(0.36, 0.62, score) * (ellDist <= 1.05 ? 1 : 0);
    }
  }

  // Smooth & upscale to full mask dimensions
  const smoothed = blurFloatAlpha(objSmall, sw, sh, 1);
  for (let y = 0; y < fullH; y++) {
    const fy = (y / Math.max(1, fullH - 1)) * (sh - 1);
    const y0 = Math.floor(fy);
    const y1 = Math.min(sh - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < fullW; x++) {
      const fx = (x / Math.max(1, fullW - 1)) * (sw - 1);
      const x0 = Math.floor(fx);
      const x1 = Math.min(sw - 1, x0 + 1);
      const wx = fx - x0;
      const v =
        (smoothed[y0 * sw + x0] * (1 - wx) + smoothed[y0 * sw + x1] * wx) * (1 - wy) +
        (smoothed[y1 * sw + x0] * (1 - wx) + smoothed[y1 * sw + x1] * wx) * wy;
      out.data[y * fullW + x] = clamp255(v * 255);
    }
  }

  return out;
}

/**
 * Samples average RGB and Luminance [0..100] at a normalized (0..1) image point.
 */
export function samplePixelAtNormalized(
  sourceCanvas: HTMLCanvasElement,
  nx: number,
  ny: number
): { rgb: [number, number, number]; lumPct: number } {
  const ctx = sourceCanvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return { rgb: [128, 128, 128], lumPct: 50 };

  const cx = Math.max(1, Math.min(sourceCanvas.width - 2, Math.round(nx * (sourceCanvas.width - 1))));
  const cy = Math.max(1, Math.min(sourceCanvas.height - 2, Math.round(ny * (sourceCanvas.height - 1))));
  const patch = ctx.getImageData(cx - 1, cy - 1, 3, 3).data;

  let sr = 0;
  let sg = 0;
  let sb = 0;
  for (let i = 0; i < patch.length; i += 4) {
    sr += patch[i];
    sg += patch[i + 1];
    sb += patch[i + 2];
  }
  const r = Math.round(sr / 9);
  const g = Math.round(sg / 9);
  const b = Math.round(sb / 9);
  const lumPct = Math.round(((0.2126 * r + 0.7152 * g + 0.0722 * b) / 255) * 100);
  return { rgb: [r, g, b], lumPct };
}

/**
 * Evaluates a MaskComponent on base dimensions (outW x outH) given base RGB pixels (optional for color/lum).
 */
export function evaluateComponentAlpha(
  comp: MaskComponent,
  outW: number,
  outH: number,
  baseRgba?: Uint8ClampedArray
): Float32Array {
  const n = outW * outH;
  const alpha = new Float32Array(n);

  if (
    comp.kind === 'brush' ||
    comp.kind === 'subject' ||
    comp.kind === 'sky' ||
    comp.kind === 'background' ||
    comp.kind === 'object' ||
    comp.kind === 'mask-ref'
  ) {
    const r = comp.kind === 'mask-ref' ? comp.sourceRaster : comp.raster;
    const rw = r.width;
    const rh = r.height;
    const rd = r.data;
    if (rw === outW && rh === outH) {
      for (let i = 0; i < n; i++) alpha[i] = rd[i] / 255;
    } else {
      for (let y = 0; y < outH; y++) {
        const fy = (y / Math.max(1, outH - 1)) * (rh - 1);
        const y0 = Math.floor(fy);
        const y1 = Math.min(rh - 1, y0 + 1);
        const wy = fy - y0;
        for (let x = 0; x < outW; x++) {
          const fx = (x / Math.max(1, outW - 1)) * (rw - 1);
          const x0 = Math.floor(fx);
          const x1 = Math.min(rw - 1, x0 + 1);
          const wx = fx - x0;
          const v =
            (rd[y0 * rw + x0] * (1 - wx) + rd[y0 * rw + x1] * wx) * (1 - wy) +
            (rd[y1 * rw + x0] * (1 - wx) + rd[y1 * rw + x1] * wx) * wy;
          alpha[y * outW + x] = v / 255;
        }
      }
    }
    return alpha;
  }

  if (comp.kind === 'linear') {
    const vx = comp.x1 - comp.x0;
    const vy = comp.y1 - comp.y0;
    const len2 = Math.max(1e-6, vx * vx + vy * vy);
    for (let y = 0; y < outH; y++) {
      const ny = y / Math.max(1, outH - 1);
      for (let x = 0; x < outW; x++) {
        const nx = x / Math.max(1, outW - 1);
        const t = ((nx - comp.x0) * vx + (ny - comp.y0) * vy) / len2;
        // t <= 0 => full effect (1.0), t >= 1 => no effect (0.0)
        alpha[y * outW + x] = 1 - smoothstep(0, 1, clamp(t, 0, 1));
      }
    }
    return alpha;
  }

  if (comp.kind === 'radial') {
    const cosA = Math.cos((-comp.angle * Math.PI) / 180);
    const sinA = Math.sin((-comp.angle * Math.PI) / 180);
    const inner = clamp(1 - comp.feather / 100, 0, 0.98);
    const aspect = outW / Math.max(1, outH);
    for (let y = 0; y < outH; y++) {
      const dy = (y / Math.max(1, outH - 1) - comp.cy);
      for (let x = 0; x < outW; x++) {
        const dx = (x / Math.max(1, outW - 1) - comp.cx) * aspect;
        const rx = comp.rx * aspect;
        const ry = comp.ry;
        const px = dx * cosA - dy * sinA;
        const py = dx * sinA + dy * cosA;
        const dist = Math.hypot(px / Math.max(0.01, rx), py / Math.max(0.01, ry));
        alpha[y * outW + x] = 1 - smoothstep(inner, 1.0, dist);
      }
    }
    return alpha;
  }

  if (comp.kind === 'color-range' && baseRgba) {
    const tr = comp.targetRgb[0] / 255;
    const tg = comp.targetRgb[1] / 255;
    const tb = comp.targetRgb[2] / 255;
    const tol = clamp(comp.tolerance / 100, 0.02, 0.95) * 0.72;
    const smooth = clamp(comp.smoothness / 100, 0.02, 1.0) * 0.35;

    for (let i = 0; i < n; i++) {
      const idx = i * 4;
      const dr = baseRgba[idx] / 255 - tr;
      const dg = baseRgba[idx + 1] / 255 - tg;
      const db = baseRgba[idx + 2] / 255 - tb;
      const dist = Math.sqrt(dr * dr * 0.34 + dg * dg * 0.44 + db * db * 0.22);
      alpha[i] = 1 - smoothstep(tol, tol + smooth, dist);
    }
    return alpha;
  }

  if (comp.kind === 'luminance-range' && baseRgba) {
    const lo = clamp(Math.min(comp.minLum, comp.maxLum) / 100, 0, 1);
    const hi = clamp(Math.max(comp.minLum, comp.maxLum) / 100, 0, 1);
    const sm = clamp(comp.smoothness / 100, 0.01, 1) * 0.35;

    for (let i = 0; i < n; i++) {
      const idx = i * 4;
      const lum =
        (0.2126 * baseRgba[idx] + 0.7152 * baseRgba[idx + 1] + 0.0722 * baseRgba[idx + 2]) / 255;
      const lowRamp = lo <= 0.005 ? 1 : smoothstep(lo - sm, lo + sm * 0.25, lum);
      const highRamp = hi >= 0.995 ? 1 : 1 - smoothstep(hi - sm * 0.25, hi + sm, lum);
      alpha[i] = clamp(lowRamp * highRamp, 0, 1);
    }
    return alpha;
  }

  return alpha;
}

function serializeComponentGeometry(comp: MaskComponent): string {
  if (
    comp.kind === 'brush' ||
    comp.kind === 'subject' ||
    comp.kind === 'sky' ||
    comp.kind === 'background' ||
    comp.kind === 'object'
  ) {
    return `${comp.kind}:${comp.op}:${comp.raster.width}x${comp.raster.height}:${getObjectUid(comp.raster.data)}#${getBufferVersion(comp.raster.data)}`;
  }
  if (comp.kind === 'mask-ref') {
    return `ref:${comp.op}:${comp.sourceRaster.width}x${comp.sourceRaster.height}:${getObjectUid(comp.sourceRaster.data)}#${getBufferVersion(comp.sourceRaster.data)}`;
  }
  if (comp.kind === 'linear') {
    return `lin:${comp.op}:${comp.x0}:${comp.y0}:${comp.x1}:${comp.y1}`;
  }
  if (comp.kind === 'radial') {
    return `rad:${comp.op}:${comp.cx}:${comp.cy}:${comp.rx}:${comp.ry}:${comp.angle}:${comp.feather}`;
  }
  if (comp.kind === 'color-range') {
    return `col:${comp.op}:${comp.targetRgb[0]},${comp.targetRgb[1]},${comp.targetRgb[2]}:${comp.tolerance}:${comp.smoothness}`;
  }
  if (comp.kind === 'luminance-range') {
    return `lum:${comp.op}:${comp.minLum}:${comp.maxLum}:${comp.smoothness}`;
  }
  return '';
}

/**
 * Evaluates a full MaskLayer into a combined [0..1] alpha Float32Array in un-transformed base coordinates,
 * applying Add / Subtract / Intersect boolean ops, Feather, Edge Refinement, Invert, and Density.
 * Results are memoized on mask geometry + source pixels so local tonal/color slider drags never recompute alpha.
 */
export function evaluateMaskLayerBaseAlpha(
  layer: MaskLayer,
  baseW: number,
  baseH: number,
  baseRgbaInput?: BaseRgbaInput
): Float32Array {
  const needsBasePixels =
    layer.edgeRefinement > 0 ||
    layer.components.some((c) => c.kind === 'color-range' || c.kind === 'luminance-range');

  const pixelKey = !needsBasePixels
    ? 'nopx'
    : baseRgbaInput instanceof Uint8ClampedArray
      ? `arr:${getObjectUid(baseRgbaInput)}`
      : baseRgbaInput
        ? baseRgbaInput.key
        : 'none';

  const compKey = layer.components.map(serializeComponentGeometry).join('|');
  const cacheKey = `${baseW}x${baseH}|f:${layer.feather}|d:${layer.density}|e:${layer.edgeRefinement}|i:${layer.inverted ? 1 : 0}|p:${pixelKey}|c:${compKey}`;

  const baseAlphaCacheLimit = getDevicePerformanceProfile().maskAlphaCacheLimit;
  const cached = baseAlphaLruCache.get(cacheKey);
  if (cached) {
    // Refresh LRU order
    baseAlphaLruCache.delete(cacheKey);
    baseAlphaLruCache.set(cacheKey, cached);
    return cached;
  }

  const baseRgba = !needsBasePixels
    ? undefined
    : baseRgbaInput instanceof Uint8ClampedArray
      ? baseRgbaInput
      : baseRgbaInput?.getRgba();

  const pxKeyForRange =
    baseRgbaInput instanceof Uint8ClampedArray
      ? `arr:${getObjectUid(baseRgbaInput)}`
      : baseRgbaInput
        ? baseRgbaInput.key
        : 'none';

  const n = baseW * baseH;
  let combined: Float32Array = new Float32Array(n);

  for (let idx = 0; idx < layer.components.length; idx++) {
    const comp = layer.components[idx];
    const compUsesPixels = comp.kind === 'color-range' || comp.kind === 'luminance-range';
    const compCacheKey = `${baseW}x${baseH}|${compUsesPixels ? pxKeyForRange : 'nopx'}|${serializeComponentGeometry(comp)}`;
    let compAlpha = componentAlphaLruCache.get(compCacheKey);
    if (compAlpha) {
      componentAlphaLruCache.delete(compCacheKey);
      componentAlphaLruCache.set(compCacheKey, compAlpha);
    } else {
      compAlpha = evaluateComponentAlpha(comp, baseW, baseH, baseRgba);
      while (componentAlphaLruCache.size >= COMPONENT_ALPHA_CACHE_LIMIT) {
        const oldestComp = componentAlphaLruCache.keys().next().value;
        if (oldestComp !== undefined) componentAlphaLruCache.delete(oldestComp);
        else break;
      }
      componentAlphaLruCache.set(compCacheKey, compAlpha);
    }
    if (idx === 0) {
      combined.set(compAlpha);
      continue;
    }
    if (comp.op === 'add') {
      for (let i = 0; i < n; i++) {
        if (compAlpha[i] > combined[i]) combined[i] = compAlpha[i];
      }
    } else if (comp.op === 'subtract') {
      for (let i = 0; i < n; i++) {
        combined[i] = Math.max(0, combined[i] - compAlpha[i]);
      }
    } else if (comp.op === 'intersect') {
      for (let i = 0; i < n; i++) {
        combined[i] = Math.min(combined[i], compAlpha[i]);
      }
    }
  }

  // Feather mask globally
  if (layer.feather > 0) {
    const rad = Math.max(1, Math.round((layer.feather / 100) * Math.min(baseW, baseH) * 0.06));
    combined = blurFloatAlpha(combined, baseW, baseH, rad);
  }

  // Edge Refinement: snap soft mask boundaries cleanly to underlying image luminance edges
  if (layer.edgeRefinement > 0 && baseRgba) {
    const strength = clamp(layer.edgeRefinement / 100, 0, 1);
    const refined = new Float32Array(combined);
    const expScale = -(22 + strength * 60);
    const expLut = new Float32Array(512);
    for (let k = 0; k < 512; k++) {
      expLut[k] = Math.exp((k / 511) * expScale);
    }
    const invMaxDiffSq = 511 / (255 * 255 * 3);
    const edgeLow = 0.5 - (0.38 - strength * 0.24);
    const edgeHigh = 0.5 + (0.38 - strength * 0.24);

    for (let y = 1; y < baseH - 1; y++) {
      for (let x = 1; x < baseW - 1; x++) {
        const i = y * baseW + x;
        const a = combined[i];
        // Only refine transition band
        if (a <= 0.02 || a >= 0.98) continue;
        const idx = i * 4;
        const r0 = baseRgba[idx];
        const g0 = baseRgba[idx + 1];
        const b0 = baseRgba[idx + 2];

        let sum = 0;
        let wsum = 0;
        for (let oy = -1; oy <= 1; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            const j = (y + oy) * baseW + (x + ox);
            const jIdx = j * 4;
            const dr = r0 - baseRgba[jIdx];
            const dg = g0 - baseRgba[jIdx + 1];
            const db = b0 - baseRgba[jIdx + 2];
            const lutIdx = Math.min(511, ((dr * dr + dg * dg + db * db) * invMaxDiffSq) | 0);
            const w = expLut[lutIdx];
            sum += combined[j] * w;
            wsum += w;
          }
        }
        const snapped = wsum > 0 ? sum / wsum : a;
        // Slight contrast steepening near edges
        const edgeBoost = smoothstep(edgeLow, edgeHigh, snapped);
        refined[i] = a * (1 - strength * 0.65) + edgeBoost * (strength * 0.65);
      }
    }
    combined = refined;
  }

  // Invert Mask
  if (layer.inverted) {
    for (let i = 0; i < n; i++) {
      combined[i] = 1 - combined[i];
    }
  }

  // Density scaling
  const densityScale = clamp(layer.density / 100, 0, 1);
  if (densityScale < 0.999) {
    for (let i = 0; i < n; i++) {
      combined[i] *= densityScale;
    }
  }

  while (baseAlphaLruCache.size >= baseAlphaCacheLimit) {
    const oldest = baseAlphaLruCache.keys().next().value;
    if (oldest !== undefined) baseAlphaLruCache.delete(oldest);
    else break;
  }
  baseAlphaLruCache.set(cacheKey, combined);

  return combined;
}

/**
 * Projects a base-coordinate alpha array into the transformed + cropped output canvas space,
 * computing tight non-zero bounding box and memoizing against `(baseAlpha, dims, transform)`.
 */
export function projectMaskToTransformedSpaceWithBounds(
  baseAlpha: Float32Array,
  baseW: number,
  baseH: number,
  outW: number,
  outH: number,
  transform: TransformState
): ProjectedMaskResult {
  const projKey = `${baseW}x${baseH}->${outW}x${outH}|r${transform.rotate90}|fh${transform.flipH ? 1 : 0}|fv${transform.flipV ? 1 : 0}|s${transform.straighten}|c${transform.crop.x.toFixed(4)},${transform.crop.y.toFixed(4)},${transform.crop.width.toFixed(4)},${transform.crop.height.toFixed(4)}`;

  let byTransform = projectedAlphaCache.get(baseAlpha);
  if (byTransform) {
    const hit = byTransform.get(projKey);
    if (hit) {
      byTransform.delete(projKey);
      byTransform.set(projKey, hit);
      return hit;
    }
  } else {
    byTransform = new Map();
    projectedAlphaCache.set(baseAlpha, byTransform);
  }

  const { width: rotW, height: rotH } = getRotatedDimensions(baseW, baseH, transform.rotate90);
  const out = new Float32Array(outW * outH);

  const hasStraighten = transform.straighten !== 0;
  let autoScale = 1;
  let cosNeg = 1;
  let sinNeg = 0;
  if (hasStraighten) {
    const rad = (transform.straighten * Math.PI) / 180;
    const cosA = Math.abs(Math.cos(rad));
    const sinA = Math.abs(Math.sin(rad));
    autoScale = Math.max((rotW * cosA + rotH * sinA) / rotW, (rotW * sinA + rotH * cosA) / rotH);
    cosNeg = Math.cos(-rad);
    sinNeg = Math.sin(-rad);
  }

  let minX = outW;
  let minY = outH;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < outH; y++) {
    const ny = y / Math.max(1, outH - 1);
    const wy = transform.crop.y + ny * transform.crop.height;
    const py0 = (wy - 0.5) * rotH;

    for (let x = 0; x < outW; x++) {
      const nx = x / Math.max(1, outW - 1);
      const wx = transform.crop.x + nx * transform.crop.width;
      let px = (wx - 0.5) * rotW;
      let py = py0;

      if (hasStraighten) {
        const sPx = px / autoScale;
        const sPy = py / autoScale;
        px = sPx * cosNeg - sPy * sinNeg;
        py = sPx * sinNeg + sPy * cosNeg;
      }

      if (transform.flipH) px = -px;
      if (transform.flipV) py = -py;

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

      const bx = sx + baseW / 2;
      const by = sy + baseH / 2;
      if (bx < 0 || bx >= baseW || by < 0 || by >= baseH) continue;

      const x0 = Math.floor(bx);
      const y0 = Math.floor(by);
      const x1 = Math.min(baseW - 1, x0 + 1);
      const y1 = Math.min(baseH - 1, y0 + 1);
      const tx = bx - x0;
      const ty = by - y0;

      const v =
        (baseAlpha[y0 * baseW + x0] * (1 - tx) + baseAlpha[y0 * baseW + x1] * tx) * (1 - ty) +
        (baseAlpha[y1 * baseW + x0] * (1 - tx) + baseAlpha[y1 * baseW + x1] * tx) * ty;
      out[y * outW + x] = v;
      if (v > 0.002) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  const res: ProjectedMaskResult = { alpha: out, minX, minY, maxX, maxY };
  if (byTransform.size >= PROJECTED_ALPHA_CACHE_LIMIT) {
    const oldest = byTransform.keys().next().value;
    if (oldest !== undefined) byTransform.delete(oldest);
  }
  byTransform.set(projKey, res);

  return res;
}

/**
 * Projects a base-coordinate alpha array into the transformed + cropped output canvas space.
 */
export function projectMaskToTransformedSpace(
  baseAlpha: Float32Array,
  baseW: number,
  baseH: number,
  outW: number,
  outH: number,
  transform: TransformState
): Float32Array {
  return projectMaskToTransformedSpaceWithBounds(baseAlpha, baseW, baseH, outW, outH, transform).alpha;
}

/**
 * Snapshot a MaskLayer's evaluated alpha into a MaskRasterData (used for Mask Intersection).
 */
export function bakeMaskLayerToRaster(
  layer: MaskLayer,
  sourceCanvas: HTMLCanvasElement
): MaskRasterData {
  const { width, height } = getMaskRasterDimensions(sourceCanvas.width, sourceCanvas.height);
  const tmp = document.createElement('canvas');
  tmp.width = width;
  tmp.height = height;
  const ctx = tmp.getContext('2d', { willReadFrequently: true });
  ctx?.drawImage(sourceCanvas, 0, 0, width, height);
  const baseRgba = ctx ? ctx.getImageData(0, 0, width, height).data : undefined;

  const alpha = evaluateMaskLayerBaseAlpha(layer, width, height, baseRgba);
  const data = new Uint8Array(width * height);
  for (let i = 0; i < alpha.length; i++) {
    data[i] = clamp255(alpha[i] * 255);
  }
  return { width, height, data };
}
