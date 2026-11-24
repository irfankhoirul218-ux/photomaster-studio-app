import { CurvePoint, DEFAULT_TONE_CURVE, ToneCurveChannels } from '../types/editor';

export function isIdentityCurve(points: CurvePoint[]): boolean {
  if (!points || points.length < 2) return true;
  if (points.length === 2) {
    return (
      Math.abs(points[0].x) <= 0.5 &&
      Math.abs(points[0].y) <= 0.5 &&
      Math.abs(points[1].x - 255) <= 0.5 &&
      Math.abs(points[1].y - 255) <= 0.5
    );
  }
  return points.every((p) => Math.abs(p.x - p.y) <= 0.5);
}

export function hasActiveToneCurve(curves: ToneCurveChannels | undefined): boolean {
  if (!curves) return false;
  return (
    !isIdentityCurve(curves.rgb) ||
    !isIdentityCurve(curves.red) ||
    !isIdentityCurve(curves.green) ||
    !isIdentityCurve(curves.blue)
  );
}

export function cloneToneCurves(curves?: ToneCurveChannels): ToneCurveChannels {
  const src = curves ?? DEFAULT_TONE_CURVE;
  return {
    rgb: (src.rgb ?? DEFAULT_TONE_CURVE.rgb).map((p) => ({ x: p.x, y: p.y })),
    red: (src.red ?? DEFAULT_TONE_CURVE.red).map((p) => ({ x: p.x, y: p.y })),
    green: (src.green ?? DEFAULT_TONE_CURVE.green).map((p) => ({ x: p.x, y: p.y })),
    blue: (src.blue ?? DEFAULT_TONE_CURVE.blue).map((p) => ({ x: p.x, y: p.y })),
  };
}

/**
 * Generates a smooth, monotonic 256-entry [0..1] lookup table from control points
 * using Fritsch-Carlson monotone cubic Hermite interpolation (no overshoot rings).
 */
export function buildCurveLUT(rawPoints: CurvePoint[]): Float32Array {
  const lut = new Float32Array(256);
  const pts = [...(rawPoints || [])]
    .map((p) => ({
      x: Math.max(0, Math.min(255, p.x)),
      y: Math.max(0, Math.min(255, p.y)),
    }))
    .sort((a, b) => a.x - b.x);

  // Deduplicate coinciding X coordinates cleanly
  const clean: CurvePoint[] = [];
  for (const p of pts) {
    if (clean.length === 0 || Math.abs(p.x - clean[clean.length - 1].x) >= 1) {
      clean.push(p);
    } else {
      clean[clean.length - 1] = p;
    }
  }

  if (clean.length === 0) {
    for (let i = 0; i < 256; i++) lut[i] = i / 255;
    return lut;
  }
  if (clean.length === 1) {
    const v = clean[0].y / 255;
    lut.fill(v);
    return lut;
  }

  const n = clean.length;
  const dxs: number[] = [];
  const ms: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = clean[i + 1].x - clean[i].x;
    const dy = clean[i + 1].y - clean[i].y;
    dxs.push(dx);
    ms.push(dx > 0 ? dy / dx : 0);
  }

  // Initial tangents
  const c1s: number[] = [ms[0]];
  for (let i = 0; i < n - 2; i++) {
    const m = ms[i];
    const mNext = ms[i + 1];
    if (m * mNext <= 0) {
      c1s.push(0);
    } else {
      const dx = dxs[i];
      const dxNext = dxs[i + 1];
      const common = dx + dxNext;
      c1s.push((3 * common) / ((common + dxNext) / m + (common + dx) / mNext));
    }
  }
  c1s.push(ms[ms.length - 1]);

  // Cubic Hermite polynomial coefficients per segment
  const c2s: number[] = [];
  const c3s: number[] = [];
  for (let i = 0; i < c1s.length - 1; i++) {
    const c1 = c1s[i];
    const m = ms[i];
    const invDx = 1 / Math.max(1e-5, dxs[i]);
    const common = c1 + c1s[i + 1] - 2 * m;
    c2s.push((m - c1 - common) * invDx);
    c3s.push(common * invDx * invDx);
  }

  for (let x = 0; x < 256; x++) {
    if (x <= clean[0].x) {
      lut[x] = clean[0].y / 255;
      continue;
    }
    if (x >= clean[n - 1].x) {
      lut[x] = clean[n - 1].y / 255;
      continue;
    }

    // Find segment containing x
    let seg = 0;
    for (let i = 0; i < n - 1; i++) {
      if (x >= clean[i].x && x <= clean[i + 1].x) {
        seg = i;
        break;
      }
    }

    const diff = x - clean[seg].x;
    const y = clean[seg].y + diff * (c1s[seg] + diff * (c2s[seg] + diff * c3s[seg]));
    lut[x] = Math.max(0, Math.min(1, y / 255));
  }

  return lut;
}
