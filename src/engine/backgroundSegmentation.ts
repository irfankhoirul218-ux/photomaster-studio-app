import { AutoModel, AutoProcessor, env, RawImage } from '@huggingface/transformers';
import {
  BackgroundRemovalMode,
  BgRefinementSettings,
  BgSegmentationProgress,
} from '../types/editor';

type CachedModelEntry = {
  modelId: string;
  model: any;
  processor: any;
  device: string;
};

const modelCache = new Map<string, Promise<CachedModelEntry>>();

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / Math.max(1e-6, edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

async function detectBrowserDevice(): Promise<'webgpu' | 'wasm' | undefined> {
  // Node / tsx environment: let onnxruntime-node run natively without overriding device
  if (typeof window === 'undefined') {
    return undefined;
  }
  try {
    const nav = navigator as unknown as {
      gpu?: { requestAdapter?: () => Promise<unknown | null> };
    };
    if (nav?.gpu?.requestAdapter) {
      const adapter = await nav.gpu.requestAdapter();
      if (adapter) return 'webgpu';
    }
  } catch {
    // Fallback to WASM cleanly
  }
  return 'wasm';
}

function getModelIdForMode(mode: BackgroundRemovalMode): string {
  switch (mode) {
    case 'portrait':
      return 'Xenova/modnet';
    case 'general':
    case 'product':
    case 'manual':
    default:
      return 'briaai/RMBG-1.4';
  }
}

async function loadSegmentationModel(
  modelId: string,
  onProgress?: (p: BgSegmentationProgress) => void
): Promise<CachedModelEntry> {
  const existing = modelCache.get(modelId);
  if (existing) {
    return existing;
  }

  const loaderPromise = (async (): Promise<CachedModelEntry> => {
    if (typeof window !== 'undefined') {
      env.allowLocalModels = false;
      env.useBrowserCache = true;
    }

    const preferredDevice = await detectBrowserDevice();
    const isRmbg = modelId.includes('RMBG');

    const progressCallback = (info: any) => {
      if (!onProgress) return;
      if (info?.status === 'progress' && typeof info.progress === 'number') {
        const pct = clamp(Math.round(info.progress), 5, 85);
        onProgress({
          stage: 'loading-model',
          progress: pct,
          message: `Downloading local AI model (${pct}%)...`,
        });
      } else if (info?.status === 'initiate' || info?.status === 'download') {
        onProgress({
          stage: 'loading-model',
          progress: 12,
          message: `Loading ${isRmbg ? 'RMBG-1.4' : 'MODNet'} weights...`,
        });
      }
    };

    const loadWithDevice = async (device?: 'webgpu' | 'wasm') => {
      const modelOptions: Record<string, any> = {
        dtype: 'q8',
        progress_callback: progressCallback,
      };
      if (device) {
        modelOptions.device = device;
      }
      if (isRmbg) {
        modelOptions.config = { model_type: 'custom' };
      }

      const [model, processor] = await Promise.all([
        AutoModel.from_pretrained(modelId, modelOptions),
        AutoProcessor.from_pretrained(modelId),
      ]);

      return {
        modelId,
        model,
        processor,
        device: device ?? 'node-cpu',
      };
    };

    try {
      return await loadWithDevice(preferredDevice);
    } catch (err) {
      // If WebGPU execution fails for an unsupported op on mobile/older GPU, fall back to WASM
      if (preferredDevice === 'webgpu') {
        return await loadWithDevice('wasm');
      }
      throw err;
    }
  })().catch((err) => {
    modelCache.delete(modelId);
    throw err;
  });

  modelCache.set(modelId, loaderPromise);
  return loaderPromise;
}

/**
 * Bilinearly resamples a single-channel float matte (mw × mh, [0..1])
 * to target dimensions (dstW × dstH) returning Uint8ClampedArray [0..255].
 */
function resizeFloatMatteBilinear(
  src: Float32Array | ArrayLike<number>,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
  minVal = 0,
  maxVal = 1
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(dstW * dstH);
  const span = maxVal - minVal;
  const invSpan = span > 1e-5 ? 1 / span : 1;

  for (let y = 0; y < dstH; y++) {
    const fy = ((y + 0.5) / dstH) * srcH - 0.5;
    const y0 = Math.max(0, Math.min(srcH - 1, Math.floor(fy)));
    const y1 = Math.max(0, Math.min(srcH - 1, y0 + 1));
    const ty = clamp(fy - y0, 0, 1);

    for (let x = 0; x < dstW; x++) {
      const fx = ((x + 0.5) / dstW) * srcW - 0.5;
      const x0 = Math.max(0, Math.min(srcW - 1, Math.floor(fx)));
      const x1 = Math.max(0, Math.min(srcW - 1, x0 + 1));
      const tx = clamp(fx - x0, 0, 1);

      const v00 = src[y0 * srcW + x0];
      const v10 = src[y0 * srcW + x1];
      const v01 = src[y1 * srcW + x0];
      const v11 = src[y1 * srcW + x1];

      const top = v00 + (v10 - v00) * tx;
      const bot = v01 + (v11 - v01) * tx;
      const val = top + (bot - top) * ty;
      const norm = span > 1e-5 && (minVal < -0.05 || maxVal > 1.05) ? (val - minVal) * invSpan : val;
      out[y * dstW + x] = clamp255(clamp(norm, 0, 1) * 255);
    }
  }
  return out;
}

/**
 * Heuristic offline geodesic foreground segmentation fallback
 * (used only when uncached neural model cannot be downloaded offline).
 */
export function localGeodesicFallbackSegmentation(
  rgba: Uint8ClampedArray,
  width: number,
  height: number
): Uint8ClampedArray {
  const segMax = 240;
  const scale = Math.min(1, segMax / Math.max(width, height));
  const sw = Math.max(16, Math.round(width * scale));
  const sh = Math.max(16, Math.round(height * scale));

  const n = sw * sh;
  const L = new Float32Array(n);
  const A = new Float32Array(n);
  const B = new Float32Array(n);
  const smallRgb = new Uint8ClampedArray(n * 3);

  for (let y = 0; y < sh; y++) {
    const sy = Math.min(height - 1, Math.floor((y / sh) * height));
    for (let x = 0; x < sw; x++) {
      const sx = Math.min(width - 1, Math.floor((x / sw) * width));
      const si = (sy * width + sx) * 4;
      const i = y * sw + x;
      const r = rgba[si] / 255;
      const g = rgba[si + 1] / 255;
      const b = rgba[si + 2] / 255;
      smallRgb[i * 3] = rgba[si];
      smallRgb[i * 3 + 1] = rgba[si + 1];
      smallRgb[i * 3 + 2] = rgba[si + 2];
      L[i] = 0.299 * r + 0.587 * g + 0.114 * b;
      A[i] = r - g;
      B[i] = 0.5 * (r + g) - b;
    }
  }

  const bins = 10;
  const bgHist = new Float32Array(bins * bins * bins);
  let borderCount = 0;
  const borderThickness = Math.max(2, Math.round(Math.min(sw, sh) * 0.04));

  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      if (
        x < borderThickness ||
        x >= sw - borderThickness ||
        y < borderThickness ||
        y >= sh - borderThickness
      ) {
        const idx = (y * sw + x) * 3;
        const rBin = Math.min(bins - 1, Math.floor((smallRgb[idx] / 256) * bins));
        const gBin = Math.min(bins - 1, Math.floor((smallRgb[idx + 1] / 256) * bins));
        const bBin = Math.min(bins - 1, Math.floor((smallRgb[idx + 2] / 256) * bins));
        bgHist[rBin * bins * bins + gBin * bins + bBin] += 1;
        borderCount++;
      }
    }
  }

  const smoothHist = new Float32Array(bgHist.length);
  for (let r = 0; r < bins; r++) {
    for (let g = 0; g < bins; g++) {
      for (let b = 0; b < bins; b++) {
        let sum = 0;
        let wsum = 0;
        for (let dr = -1; dr <= 1; dr++) {
          for (let dg = -1; dg <= 1; dg++) {
            for (let db = -1; db <= 1; db++) {
              const nr = r + dr;
              const ng = g + dg;
              const nb = b + db;
              if (nr >= 0 && nr < bins && ng >= 0 && ng < bins && nb >= 0 && nb < bins) {
                const w = dr === 0 && dg === 0 && db === 0 ? 4 : 1;
                sum += bgHist[nr * bins * bins + ng * bins + nb] * w;
                wsum += w;
              }
            }
          }
        }
        smoothHist[r * bins * bins + g * bins + b] = sum / wsum / Math.max(1, borderCount);
      }
    }
  }

  const geoDist = new Float32Array(n).fill(1e6);
  const bgColorProb = new Float32Array(n);

  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const i = y * sw + x;
      const idx = i * 3;
      const rBin = Math.min(bins - 1, Math.floor((smallRgb[idx] / 256) * bins));
      const gBin = Math.min(bins - 1, Math.floor((smallRgb[idx + 1] / 256) * bins));
      const bBin = Math.min(bins - 1, Math.floor((smallRgb[idx + 2] / 256) * bins));
      bgColorProb[i] = clamp(smoothHist[rBin * bins * bins + gBin * bins + bBin] * 32, 0, 1);
      if (x === 0 || x === sw - 1 || y === 0 || y === sh - 1) {
        geoDist[i] = 0;
      }
    }
  }

  const edgeCost = (i: number, j: number): number => {
    const dL = L[i] - L[j];
    const dA = A[i] - A[j];
    const dB = B[i] - B[j];
    const colorDist = Math.sqrt(dL * dL * 1.4 + dA * dA * 2.2 + dB * dB * 2.2);
    return 0.008 + colorDist * 2.6 + (1 - bgColorProb[j]) * 0.04;
  };

  for (let sweep = 0; sweep < 4; sweep++) {
    for (let y = 1; y < sh - 1; y++) {
      for (let x = 1; x < sw - 1; x++) {
        const i = y * sw + x;
        let d = geoDist[i];
        d = Math.min(d, geoDist[i - 1] + edgeCost(i - 1, i));
        d = Math.min(d, geoDist[i - sw] + edgeCost(i - sw, i));
        d = Math.min(d, geoDist[i - sw - 1] + edgeCost(i - sw - 1, i) * 1.414);
        d = Math.min(d, geoDist[i - sw + 1] + edgeCost(i - sw + 1, i) * 1.414);
        geoDist[i] = d;
      }
    }
    for (let y = sh - 2; y >= 1; y--) {
      for (let x = sw - 2; x >= 1; x--) {
        const i = y * sw + x;
        let d = geoDist[i];
        d = Math.min(d, geoDist[i + 1] + edgeCost(i + 1, i));
        d = Math.min(d, geoDist[i + sw] + edgeCost(i + sw, i));
        d = Math.min(d, geoDist[i + sw + 1] + edgeCost(i + sw + 1, i) * 1.414);
        d = Math.min(d, geoDist[i + sw - 1] + edgeCost(i + sw - 1, i) * 1.414);
        geoDist[i] = d;
      }
    }
  }

  const validGeo: number[] = [];
  for (let i = 0; i < n; i++) {
    if (geoDist[i] < 1e5) validGeo.push(geoDist[i]);
  }
  validGeo.sort((a, b) => a - b);
  const p92 =
    validGeo.length > 0 ? validGeo[Math.min(validGeo.length - 1, Math.floor(validGeo.length * 0.92))] : 1;
  const geoScale = Math.max(0.18, p92 * 0.68);

  const fgScore = new Float32Array(n);
  let scoreSum = 0;
  for (let y = 0; y < sh; y++) {
    const ny = (y / sh - 0.48) * 2;
    for (let x = 0; x < sw; x++) {
      const nx = (x / sw - 0.5) * 2;
      const i = y * sw + x;
      const gNorm = clamp(geoDist[i] / geoScale, 0, 1);
      const colorFg = 1 - bgColorProb[i];
      const centerPrior = Math.exp(-(nx * nx * 0.7 + ny * ny * 0.65));
      fgScore[i] = clamp(gNorm * 0.58 + colorFg * 0.27 + centerPrior * gNorm * 0.25, 0, 1);
      scoreSum += fgScore[i];
    }
  }

  const meanScore = scoreSum / n;
  const threshLow = clamp(meanScore * 0.72, 0.16, 0.42);
  const threshHigh = clamp(meanScore * 1.15, threshLow + 0.14, 0.68);
  const maskSmall = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    maskSmall[i] = smoothstep(threshLow, threshHigh, fgScore[i]);
  }

  return resizeFloatMatteBilinear(maskSmall, sw, sh, width, height, 0, 1);
}

/**
 * Runs modern open-source neural background segmentation on raw RGBA pixels
 * using Portrait (MODNet) or General/Product (RMBG-1.4) models.
 */
export async function segmentImageRgba(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  mode: BackgroundRemovalMode,
  onProgress?: (p: BgSegmentationProgress) => void
): Promise<{
  rawAlpha: Uint8ClampedArray;
  usedModelId: string;
  usedDevice: string;
}> {
  const modelId = getModelIdForMode(mode);

  try {
    onProgress?.({
      stage: 'loading-model',
      progress: 10,
      message: `Preparing ${mode === 'portrait' ? 'Portrait Hair' : 'RMBG-1.4'} segmentation model...`,
    });

    const entry = await loadSegmentationModel(modelId, onProgress);

    onProgress?.({
      stage: 'segmenting',
      progress: 88,
      message: `Analyzing subject (${entry.device === 'webgpu' ? 'WebGPU' : 'Local AI'})...`,
    });

    const rawImg = new RawImage(new Uint8ClampedArray(rgba), width, height, 4);
    const { pixel_values } = await entry.processor(rawImg);
    const outputs = await entry.model({ input: pixel_values });
    const tensor = outputs.output ?? outputs[Object.keys(outputs)[0]];

    const dims = tensor.dims as number[];
    const outH = dims[dims.length - 2];
    const outW = dims[dims.length - 1];
    const data = tensor.data as Float32Array;

    let minVal = Infinity;
    let maxVal = -Infinity;
    for (let i = 0; i < data.length; i++) {
      if (data[i] < minVal) minVal = data[i];
      if (data[i] > maxVal) maxVal = data[i];
    }

    onProgress?.({
      stage: 'refining',
      progress: 96,
      message: 'Refining edges & hair strands...',
    });
    await new Promise((r) => setTimeout(r, 0));

    const rawAlpha = resizeFloatMatteBilinear(
      data,
      outW,
      outH,
      width,
      height,
      minVal,
      maxVal
    );

    return {
      rawAlpha,
      usedModelId: entry.modelId,
      usedDevice: entry.device,
    };
  } catch (err) {
    console.warn('[BackgroundSegmentation] Neural model unavailable offline, using local fallback:', err);
    onProgress?.({
      stage: 'segmenting',
      progress: 80,
      message: 'Running offline fallback segmentation...',
    });
    await new Promise((r) => setTimeout(r, 0));
    const fallbackAlpha = localGeodesicFallbackSegmentation(rgba, width, height);
    return {
      rawAlpha: fallbackAlpha,
      usedModelId: 'local-fallback',
      usedDevice: 'cpu',
    };
  }
}

/**
 * O(N) Separable 1D-Horizontal + 1D-Vertical Box Mean using Sliding Sum.
 */
function boxMean2D(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const n = w * h;
  const tmp = new Float32Array(n);
  const dst = new Float32Array(n);
  const rad = Math.max(1, Math.round(r));

  // Horizontal pass
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    let cnt = 0;
    for (let x = 0; x <= Math.min(w - 1, rad); x++) {
      sum += src[row + x];
      cnt++;
    }
    for (let x = 0; x < w; x++) {
      if (x > 0) {
        const addX = x + rad;
        const remX = x - rad - 1;
        if (addX < w) {
          sum += src[row + addX];
          cnt++;
        }
        if (remX >= 0) {
          sum -= src[row + remX];
          cnt--;
        }
      }
      tmp[row + x] = sum / Math.max(1, cnt);
    }
  }

  // Vertical pass
  for (let x = 0; x < w; x++) {
    let sum = 0;
    let cnt = 0;
    for (let y = 0; y <= Math.min(h - 1, rad); y++) {
      sum += tmp[y * w + x];
      cnt++;
    }
    for (let y = 0; y < h; y++) {
      if (y > 0) {
        const addY = y + rad;
        const remY = y - rad - 1;
        if (addY < h) {
          sum += tmp[addY * w + x];
          cnt++;
        }
        if (remY >= 0) {
          sum -= tmp[remY * w + x];
          cnt--;
        }
      }
      dst[y * w + x] = sum / Math.max(1, cnt);
    }
  }

  return dst;
}

/**
 * Edge-only Separable Gaussian-like 2-pass Box Blur along mask transition pixels.
 */
function smoothEdgeBand(
  alpha: Float32Array,
  w: number,
  h: number,
  radius: number,
  blendStrength: number
): Float32Array {
  if (radius < 0.7 || blendStrength <= 0.01) return alpha;
  const r1 = Math.max(1, Math.round(radius));
  const pass1 = boxMean2D(alpha, w, h, r1);
  const pass2 = boxMean2D(pass1, w, h, Math.max(1, Math.round(r1 * 0.75)));

  const out = new Float32Array(alpha);
  // Compute boundary proximity via dilation difference (only modify pixels near transition)
  const dilateCheck = Math.max(2, r1 + 1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const a = alpha[i];
      if (a > 0.015 && a < 0.985) {
        out[i] = clamp(a * (1 - blendStrength) + pass2[i] * blendStrength, 0, 1);
      } else {
        // Check if within dilateCheck pixels of a transition pixel
        const xL = Math.max(0, x - dilateCheck);
        const xR = Math.min(w - 1, x + dilateCheck);
        const yT = Math.max(0, y - dilateCheck);
        const yB = Math.min(h - 1, y + dilateCheck);
        const edgeDiff =
          Math.abs(alpha[y * w + xL] - a) +
          Math.abs(alpha[y * w + xR] - a) +
          Math.abs(alpha[yT * w + x] - a) +
          Math.abs(alpha[yB * w + x] - a);
        if (edgeDiff > 0.08) {
          out[i] = clamp(a * (1 - blendStrength) + pass2[i] * blendStrength, 0, 1);
        }
      }
    }
  }
  return out;
}

/**
 * Exact O(N) Chamfer Distance Transform (3-4 metric / 3x3 weighted sweep).
 * Computes shortest pixel distance to any pixel where predicate is true.
 */
function computeDistanceField(
  maskBinary: Uint8Array,
  targetVal: 0 | 1,
  w: number,
  h: number,
  maxDistPx: number
): Float32Array {
  const n = w * h;
  const dist = new Float32Array(n);
  const INF = maxDistPx + 10;

  for (let i = 0; i < n; i++) {
    dist[i] = maskBinary[i] === targetVal ? 0 : INF;
  }

  // Forward pass
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      let d = dist[i];
      if (d === 0) continue;
      if (x > 0) d = Math.min(d, dist[i - 1] + 1);
      if (y > 0) {
        d = Math.min(d, dist[i - w] + 1);
        if (x > 0) d = Math.min(d, dist[i - w - 1] + 1.414);
        if (x < w - 1) d = Math.min(d, dist[i - w + 1] + 1.414);
      }
      dist[i] = d;
    }
  }

  // Backward pass
  for (let y = h - 1; y >= 0; y--) {
    const row = y * w;
    for (let x = w - 1; x >= 0; x--) {
      const i = row + x;
      let d = dist[i];
      if (d === 0) continue;
      if (x < w - 1) d = Math.min(d, dist[i + 1] + 1);
      if (y < h - 1) {
        d = Math.min(d, dist[i + w] + 1);
        if (x < w - 1) d = Math.min(d, dist[i + w + 1] + 1.414);
        if (x > 0) d = Math.min(d, dist[i + w - 1] + 1.414);
      }
      dist[i] = d;
    }
  }

  return dist;
}

/**
 * Full Non-Destructive Alpha Mask Refinement Pipeline:
 * 1. Mask Expand / Contract (Euclidean/Chamfer SDF shift preserving AA)
 * 2. Fast O(N) Color-Guided Filter (Refine Edge snapping CNN mask onto fine photographic edges)
 * 3. Hair Refinement (local transition F/B linear alpha matting for fine strands)
 * 4. Edge Smooth (transition-band noise smoothing)
 * 5. Edge Contrast & Product Shadow Suppression
 * 6. Edge Feather (Gaussian boundary softening)
 */
export function refineBackgroundAlphaMask(
  rgba: Uint8ClampedArray,
  rawAlpha: Uint8ClampedArray,
  width: number,
  height: number,
  settings: BgRefinementSettings
): Uint8ClampedArray {
  const n = width * height;
  let alpha: Float32Array = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    alpha[i] = rawAlpha[i] / 255;
  }

  // 1. Mask Expand / Contract (-30 .. +30 px)
  const shift = clamp(settings.expandContract, -30, 30);
  if (Math.abs(shift) >= 0.25) {
    const bin = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      bin[i] = alpha[i] >= 0.5 ? 1 : 0;
    }
    const maxD = Math.ceil(Math.abs(shift)) + 3;
    if (shift > 0) {
      // Distance to nearest foreground pixel (where bin === 1)
      const dOut = computeDistanceField(bin, 1, width, height, maxD);
      for (let i = 0; i < n; i++) {
        if (alpha[i] < 0.99 && dOut[i] <= shift + 1.2) {
          const factor = clamp(1 - (dOut[i] - shift), 0, 1);
          alpha[i] = Math.max(alpha[i], factor);
        }
      }
    } else {
      // Contract: distance to nearest background pixel (where bin === 0)
      const shrink = -shift;
      const dIn = computeDistanceField(bin, 0, width, height, maxD);
      for (let i = 0; i < n; i++) {
        if (alpha[i] > 0.01 && dIn[i] <= shrink + 1.2) {
          const factor = clamp(dIn[i] - shrink, 0, 1);
          alpha[i] = Math.min(alpha[i], factor);
        }
      }
    }
  }

  // Build normalized luminance & RGB guides for edge refinement + hair matting
  const guideL = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const idx = i * 4;
    guideL[i] = (0.299 * rgba[idx] + 0.587 * rgba[idx + 1] + 0.114 * rgba[idx + 2]) / 255;
  }

  // 2. Refine Edge: Fast O(N) Guided Filter (He et al.) applied in edge transition band
  if (settings.refineEdge > 2) {
    const strength = clamp(settings.refineEdge / 100, 0, 1);
    const radius = Math.max(2, Math.round(2 + strength * 5));
    const eps = 0.0025 + (1 - strength) * 0.012;

    const meanI = boxMean2D(guideL, width, height, radius);
    const meanP = boxMean2D(alpha, width, height, radius);

    const ip = new Float32Array(n);
    const ii = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      ip[i] = guideL[i] * alpha[i];
      ii[i] = guideL[i] * guideL[i];
    }

    const meanIP = boxMean2D(ip, width, height, radius);
    const meanII = boxMean2D(ii, width, height, radius);

    const aCoef = new Float32Array(n);
    const bCoef = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const cov = meanIP[i] - meanI[i] * meanP[i];
      const variance = meanII[i] - meanI[i] * meanI[i];
      const a = cov / (variance + eps);
      aCoef[i] = a;
      bCoef[i] = meanP[i] - a * meanI[i];
    }

    const meanA = boxMean2D(aCoef, width, height, radius);
    const meanB = boxMean2D(bCoef, width, height, radius);

    // Apply guided output ONLY in transition zone around boundaries so solid subject never fades
    const bandRadius = radius + 2;
    const bandMin = boxMean2D(alpha, width, height, bandRadius);
    for (let i = 0; i < n; i++) {
      const nearEdge = bandMin[i] > 0.02 && bandMin[i] < 0.98;
      if (nearEdge) {
        const q = clamp(meanA[i] * guideL[i] + meanB[i], 0, 1);
        const edgeMix = strength * 0.85;
        alpha[i] = clamp(alpha[i] * (1 - edgeMix) + q * edgeMix, 0, 1);
      }
    }
  }

  // 3. Hair Refinement: Local Closed-Form F/B Color Projection Matting in transition zones
  if (settings.hairRefinement > 2) {
    const hairStr = clamp(settings.hairRefinement / 100, 0, 1);
    const updated = new Float32Array(alpha);
    const searchR = 7;

    // Precompute local background/foreground boundary mask via quick box mean
    const localAvg = boxMean2D(alpha, width, height, 4);

    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const i = y * width + x;
        const a = alpha[i];
        // Operate strictly in hair/edge transition band
        const inTransition =
          (a > 0.02 && a < 0.96) || (localAvg[i] > 0.06 && localAvg[i] < 0.94);
        if (!inTransition) continue;

        let fgR = 0;
        let fgG = 0;
        let fgB = 0;
        let fgW = 0;
        let bgR = 0;
        let bgG = 0;
        let bgB = 0;
        let bgW = 0;

        // Strided local ring sample for fast, clean F & B color estimation
        for (let oy = -searchR; oy <= searchR; oy += 2) {
          const ny = y + oy;
          if (ny < 0 || ny >= height) continue;
          for (let ox = -searchR; ox <= searchR; ox += 2) {
            const nx = x + ox;
            if (nx < 0 || nx >= width) continue;
            const j = ny * width + nx;
            const ja = alpha[j];
            const wgt = 1 / (1 + ox * ox + oy * oy);
            const j4 = j * 4;
            if (ja >= 0.9) {
              const fw = ja * wgt;
              fgR += rgba[j4] * fw;
              fgG += rgba[j4 + 1] * fw;
              fgB += rgba[j4 + 2] * fw;
              fgW += fw;
            } else if (ja <= 0.12) {
              const bw = (1 - ja) * wgt;
              bgR += rgba[j4] * bw;
              bgG += rgba[j4 + 1] * bw;
              bgB += rgba[j4 + 2] * bw;
              bgW += bw;
            }
          }
        }

        if (fgW <= 0.001 || bgW <= 0.001) continue;

        const fr = fgR / fgW;
        const fg = fgG / fgW;
        const fb = fgB / fgW;
        const br = bgR / bgW;
        const bg = bgG / bgW;
        const bb = bgB / bgW;

        const dr = fr - br;
        const dg = fg - bg;
        const db = fb - bb;
        const dist2 = dr * dr + dg * dg + db * db;

        // Only solve linear color alpha where F and B have clear color separation (> ~18 RGB levels)
        // so clothes matching similar background colors stay protected by the neural model!
        if (dist2 < 360) continue;

        const i4 = i * 4;
        const proj =
          ((rgba[i4] - br) * dr + (rgba[i4 + 1] - bg) * dg + (rgba[i4 + 2] - bb) * db) /
          dist2;
        const matAlpha = clamp(proj, 0, 1);

        // Conservative anchor: prevent wild outliers far from neural alpha
        if (Math.abs(matAlpha - a) < 0.55) {
          const wgt = hairStr * 0.45 * clamp(Math.sqrt(dist2) / 90, 0.25, 1);
          updated[i] = clamp(a * (1 - wgt) + matAlpha * wgt, 0, 1);
        }
      }
    }
    alpha = updated;
  }

  // 4. Edge Smooth (boundary-localized smoothing)
  if (settings.smooth > 2) {
    const smoothRad = 1 + (settings.smooth / 100) * 3.2;
    const smoothStr = clamp(settings.smooth / 100, 0, 1) * 0.85;
    alpha = smoothEdgeBand(alpha, width, height, smoothRad, smoothStr);
  }

  // 5. Edge Contrast + Product Photography haze/shadow cleanup
  const contrastNorm = clamp(settings.contrast / 100, 0, 1);
  if (contrastNorm > 0.01 || settings.mode === 'product') {
    const gain = 1 + contrastNorm * 4.5 + (settings.mode === 'product' ? 0.65 : 0);
    const lowFloor = settings.mode === 'product' ? 0.07 : 0.02 * contrastNorm;
    const highCeil = 1 - lowFloor;
    for (let i = 0; i < n; i++) {
      let a = alpha[i];
      if (a <= lowFloor) {
        a = 0;
      } else if (a >= highCeil) {
        a = 1;
      } else {
        const norm = (a - lowFloor) / (highCeil - lowFloor);
        const c = (norm - 0.5) * gain + 0.5;
        a = clamp(c, 0, 1);
      }
      alpha[i] = a;
    }
  }

  // 6. Edge Feather (0..40 px)
  if (settings.feather > 0.2) {
    const featherRad = clamp(settings.feather, 0.2, 40);
    // Use inward-biased border feather for small values, full Gaussian border feather for large values
    const feathered = smoothEdgeBand(alpha, width, height, featherRad, 0.92);
    if (featherRad <= 3) {
      // For gentle 0.5..3px feather, keep core solid while feathering outer edges smoothly
      for (let i = 0; i < n; i++) {
        if (alpha[i] < 0.96) {
          alpha[i] = feathered[i];
        } else {
          alpha[i] = Math.min(alpha[i], feathered[i] + 0.08);
        }
      }
    } else {
      alpha = feathered;
    }
  }

  const out = new Uint8ClampedArray(n);
  for (let i = 0; i < n; i++) {
    out[i] = clamp255(alpha[i] * 255);
  }
  return out;
}

/**
 * Non-Destructive Foreground Color Decontamination & Halo Removal:
 * Removes background color bleed from semi-transparent hair and border pixels
 * by estimating nearby confident interior foreground RGB (F) and outer background RGB (B),
 * un-mixing color contamination cleanly without altering original source pixels.
 */
export function decontaminateForegroundColors(
  rgba: Uint8ClampedArray,
  alpha: Uint8ClampedArray,
  width: number,
  height: number,
  decontaminateStrength: number,
  removeHaloStrength: number
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rgba);
  const dStr = clamp(decontaminateStrength / 100, 0, 1);
  const hStr = clamp(removeHaloStrength / 100, 0, 1);
  if (dStr <= 0.01 && hStr <= 0.01) {
    return out;
  }

  const dirs = [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ];
  const radii = [1, 2, 4, 7, 11];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const aVal = alpha[i];
      if (aVal <= 2) continue;

      // Check if opaque border pixel directly adjacent to semi-transparent/transparent edge
      let isBorderOpaque = false;
      if (aVal >= 248 && hStr > 0.1) {
        for (let k = 0; k < 4; k++) {
          const nx = x + dirs[k][0];
          const ny = y + dirs[k][1];
          if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
            if (alpha[ny * width + nx] < 210) {
              isBorderOpaque = true;
              break;
            }
          }
        }
        if (!isBorderOpaque) continue;
      } else if (aVal >= 248) {
        continue;
      }

      // Sample nearest confident interior foreground (alpha >= 235)
      let fgR = 0;
      let fgG = 0;
      let fgB = 0;
      let fgW = 0;
      // Sample nearest confident background (alpha <= 18)
      let bgR = 0;
      let bgG = 0;
      let bgB = 0;
      let bgW = 0;

      for (let rIdx = 0; rIdx < radii.length; rIdx++) {
        const step = radii[rIdx];
        const wgt = 1 / (step * step);
        for (let d = 0; d < dirs.length; d++) {
          const nx = x + dirs[d][0] * step;
          const ny = y + dirs[d][1] * step;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          const j = ny * width + nx;
          const ja = alpha[j];
          const j4 = j * 4;
          if (ja >= 232) {
            const w = wgt * (ja / 255);
            fgR += rgba[j4] * w;
            fgG += rgba[j4 + 1] * w;
            fgB += rgba[j4 + 2] * w;
            fgW += w;
          } else if (ja <= 20) {
            const w = wgt * (1 - ja / 255);
            bgR += rgba[j4] * w;
            bgG += rgba[j4 + 1] * w;
            bgB += rgba[j4 + 2] * w;
            bgW += w;
          }
        }
        if (fgW > 0 && bgW > 0 && step >= 2) break;
      }

      if (fgW <= 0) continue;

      const fr = fgR / fgW;
      const fg = fgG / fgW;
      const fb = fgB / fgW;

      const idx4 = i * 4;
      let tr = rgba[idx4];
      let tg = rgba[idx4 + 1];
      let tb = rgba[idx4 + 2];

      const aNorm = aVal / 255;
      const edgeWeight = isBorderOpaque ? 0.38 : clamp(Math.pow(1 - aNorm, 0.72), 0.12, 1);

      // Step 1: Remove Color Halo via un-premultiplied background color subtraction
      if (hStr > 0.01 && bgW > 0) {
        const br = bgR / bgW;
        const bg = bgG / bgW;
        const bb = bgB / bgW;
        const denom = Math.max(0.24, aNorm);
        let unR = clamp((tr - (1 - aNorm) * br) / denom, 0, 255);
        let unG = clamp((tg - (1 - aNorm) * bg) / denom, 0, 255);
        let unB = clamp((tb - (1 - aNorm) * bb) / denom, 0, 255);

        // Stabilize noisy high-amplification outliers toward confident interior foreground
        const distFg = Math.hypot(unR - fr, unG - fg, unB - fb);
        if (distFg > 75) {
          const clampPull = clamp((distFg - 75) / 140, 0, 0.78);
          unR = unR * (1 - clampPull) + fr * clampPull;
          unG = unG * (1 - clampPull) + fg * clampPull;
          unB = unB * (1 - clampPull) + fb * clampPull;
        }

        const hw = hStr * edgeWeight;
        tr = tr * (1 - hw) + unR * hw;
        tg = tg * (1 - hw) + unG * hw;
        tb = tb * (1 - hw) + unB * hw;
      }

      // Step 2: Decontaminate Colors by blending border RGB cleanly toward interior foreground RGB
      if (dStr > 0.01) {
        const dw = dStr * clamp(Math.pow(1 - aNorm, 0.85), 0.1, 0.92) * 0.88;
        tr = tr * (1 - dw) + fr * dw;
        tg = tg * (1 - dw) + fg * dw;
        tb = tb * (1 - dw) + fb * dw;
      }

      out[idx4] = clamp255(tr);
      out[idx4 + 1] = clamp255(tg);
      out[idx4 + 2] = clamp255(tb);
    }
  }

  return out;
}

/**
 * Interactive Color/Edge Propagation for Manual Selection Mode:
 * Takes user-painted foreground (`alpha >= 230`) and background (`alpha <= 25`) brush strokes
 * and computes edge-aware geodesic competition so rough manual strokes cleanly snap to subject borders.
 */
export function propagateManualSelectionMask(
  rgba: Uint8ClampedArray,
  seedAlpha: Uint8ClampedArray,
  width: number,
  height: number
): Uint8ClampedArray {
  const segMax = 360;
  const scale = Math.min(1, segMax / Math.max(width, height));
  const sw = Math.max(16, Math.round(width * scale));
  const sh = Math.max(16, Math.round(height * scale));
  const n = sw * sh;

  const L = new Float32Array(n);
  const A = new Float32Array(n);
  const B = new Float32Array(n);
  const seedSmall = new Uint8Array(n); // 1 = fg seed, 2 = bg seed, 0 = unknown

  let fgCount = 0;
  let bgCount = 0;

  for (let y = 0; y < sh; y++) {
    const sy = Math.min(height - 1, Math.floor((y / sh) * height));
    for (let x = 0; x < sw; x++) {
      const sx = Math.min(width - 1, Math.floor((x / sw) * width));
      const si = sy * width + sx;
      const s4 = si * 4;
      const i = y * sw + x;
      const r = rgba[s4] / 255;
      const g = rgba[s4 + 1] / 255;
      const b = rgba[s4 + 2] / 255;
      L[i] = 0.299 * r + 0.587 * g + 0.114 * b;
      A[i] = r - g;
      B[i] = 0.5 * (r + g) - b;

      const sa = seedAlpha[si];
      if (sa >= 230) {
        seedSmall[i] = 1;
        fgCount++;
      } else if (sa <= 25) {
        seedSmall[i] = 2;
        bgCount++;
      }
    }
  }

  // Need both fg & bg regions; otherwise return unchanged
  if (fgCount === 0 || bgCount === 0) {
    return new Uint8ClampedArray(seedAlpha);
  }

  const fgDist = new Float32Array(n).fill(1e6);
  const bgDist = new Float32Array(n).fill(1e6);
  for (let i = 0; i < n; i++) {
    if (seedSmall[i] === 1) fgDist[i] = 0;
    else if (seedSmall[i] === 2) bgDist[i] = 0;
  }

  const edgeStep = (i: number, j: number): number => {
    const dL = L[i] - L[j];
    const dA = A[i] - A[j];
    const dB = B[i] - B[j];
    return 0.005 + Math.sqrt(dL * dL * 1.5 + dA * dA * 2.2 + dB * dB * 2.2) * 3.0;
  };

  for (let sweep = 0; sweep < 4; sweep++) {
    for (let y = 1; y < sh - 1; y++) {
      for (let x = 1; x < sw - 1; x++) {
        const i = y * sw + x;
        const nbrs = [i - 1, i - sw, i - sw - 1, i - sw + 1];
        const mult = [1, 1, 1.414, 1.414];
        for (let k = 0; k < 4; k++) {
          const c = edgeStep(nbrs[k], i) * mult[k];
          fgDist[i] = Math.min(fgDist[i], fgDist[nbrs[k]] + c);
          bgDist[i] = Math.min(bgDist[i], bgDist[nbrs[k]] + c);
        }
      }
    }
    for (let y = sh - 2; y >= 1; y--) {
      for (let x = sw - 2; x >= 1; x--) {
        const i = y * sw + x;
        const nbrs = [i + 1, i + sw, i + sw + 1, i + sw - 1];
        const mult = [1, 1, 1.414, 1.414];
        for (let k = 0; k < 4; k++) {
          const c = edgeStep(nbrs[k], i) * mult[k];
          fgDist[i] = Math.min(fgDist[i], fgDist[nbrs[k]] + c);
          bgDist[i] = Math.min(bgDist[i], bgDist[nbrs[k]] + c);
        }
      }
    }
  }

  const outSmall = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (seedSmall[i] === 1) {
      outSmall[i] = 1;
    } else if (seedSmall[i] === 2) {
      outSmall[i] = 0;
    } else {
      const df = fgDist[i];
      const db = bgDist[i];
      const denom = Math.max(1e-5, df + db);
      const prob = db / denom;
      outSmall[i] = smoothstep(0.42, 0.58, prob);
    }
  }

  return resizeFloatMatteBilinear(outSmall, sw, sh, width, height, 0, 1);
}
