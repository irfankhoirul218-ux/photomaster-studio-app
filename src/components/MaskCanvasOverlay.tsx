import React, { memo, useEffect, useRef, useState } from 'react';
import {
  evaluateMaskLayerBaseAlpha,
  getCachedBaseSourceRgba,
  getMaskRasterDimensions,
  getMaskSourceCacheKey,
  paintMaskBrushDab,
  projectMaskToTransformedSpace,
  retouchToDisplayNormalized,
  samplePixelAtNormalized,
  screenToRetouchCoords,
} from '../engine/maskOverlayBridge';
import { getDevicePerformanceProfile } from '../engine/performanceProfile';
import {
  MaskBrushSettings,
  MaskComponent,
  MaskCreationTool,
  MaskLayer,
  MaskOperation,
  TransformState,
} from '../types/editor';

export type ActiveMaskPointerTool =
  | { mode: 'idle' }
  | { mode: 'brush'; op: 'add' | 'subtract'; componentId: string }
  | { mode: 'create-linear'; op: MaskOperation }
  | { mode: 'create-radial'; op: MaskOperation }
  | { mode: 'create-object'; op: MaskOperation }
  | { mode: 'pick-color'; componentId: string }
  | { mode: 'pick-luminance'; componentId: string }
  | { mode: 'edit-handles' };

interface MaskCanvasOverlayProps {
  baseSourceCanvas: HTMLCanvasElement;
  displayWidth: number;
  displayHeight: number;
  transform: TransformState;
  activeMask: MaskLayer | null;
  pointerTool: ActiveMaskPointerTool;
  brushSettings: MaskBrushSettings;
  forceRedMask?: boolean;
  onUpdateMaskLayer: (maskId: string, updater: (prev: MaskLayer) => MaskLayer, commit?: boolean) => void;
  onFinishObjectBox: (box: { x: number; y: number; width: number; height: number }, op: MaskOperation) => void;
  onCreateGradientComponent: (comp: MaskComponent) => void;
  onSwitchBackToHandles: () => void;
}

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  if (clean.length === 6) {
    return [
      parseInt(clean.slice(0, 2), 16) || 239,
      parseInt(clean.slice(2, 4), 16) || 68,
      parseInt(clean.slice(4, 6), 16) || 68,
    ];
  }
  return [239, 68, 68];
}

const MaskCanvasOverlayComponent: React.FC<MaskCanvasOverlayProps> = ({
  baseSourceCanvas,
  displayWidth,
  displayHeight,
  transform,
  activeMask,
  pointerTool,
  brushSettings,
  forceRedMask = false,
  onUpdateMaskLayer,
  onFinishObjectBox,
  onCreateGradientComponent,
  onSwitchBackToHandles,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const cursorRingRef = useRef<HTMLDivElement>(null);
  const overlayImageDataRef = useRef<ImageData | null>(null);
  const rafRef = useRef<number | null>(null);
  const moveRafRef = useRef<number | null>(null);
  const hasDrawnOverlayRef = useRef<boolean>(false);

  const [liveBrushScale, setLiveBrushScale] = useState<number>(1);
  const [dragBox, setDragBox] = useState<{
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  } | null>(null);

  const pendingBrushPtsRef = useRef<{ nx: number; ny: number }[]>([]);
  const pendingHandleNormRef = useRef<{ nx: number; ny: number } | null>(null);
  const pendingBoxDispRef = useRef<{ x1: number; y1: number } | null>(null);

  const activeMaskRef = useRef(activeMask);
  activeMaskRef.current = activeMask;
  const brushSettingsRef = useRef(brushSettings);
  brushSettingsRef.current = brushSettings;

  const strokeRef = useRef<{
    type: 'brush' | 'linear-handle' | 'radial-handle' | 'new-linear' | 'new-radial' | 'object-box';
    componentId?: string;
    handle?: 'start' | 'end' | 'center' | 'edgeX' | 'edgeY';
    lastNorm?: { nx: number; ny: number };
    startNorm?: { nx: number; ny: number };
    snapshotBefore?: MaskLayer;
  } | null>(null);

  const updateCursorRing = (clientX: number, clientY: number) => {
    const el = cursorRingRef.current;
    const container = containerRef.current;
    if (!el || !container) return;
    const rect = container.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    el.style.display = 'block';
    el.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%)`;
  };

  const hideCursorRing = () => {
    if (cursorRingRef.current) {
      cursorRingRef.current.style.display = 'none';
    }
  };

  const renderOverlay = () => {
    const outCanvas = overlayCanvasRef.current;
    if (!outCanvas) return;
    const ctx = outCanvas.getContext('2d');
    if (!ctx) return;

    const maxOverlayDim = getDevicePerformanceProfile().maskOverlayMaxDim;
    const scale = Math.min(1, maxOverlayDim / Math.max(1, displayWidth, displayHeight));
    const pw = Math.max(1, Math.round(displayWidth * scale));
    const ph = Math.max(1, Math.round(displayHeight * scale));

    const mask = activeMaskRef.current;
    const shouldShowOverlay = Boolean(
      mask && mask.components.length > 0 && (forceRedMask || mask.showOverlay)
    );

    if (!shouldShowOverlay) {
      if (hasDrawnOverlayRef.current || outCanvas.width !== pw || outCanvas.height !== ph) {
        if (outCanvas.width !== pw || outCanvas.height !== ph) {
          outCanvas.width = pw;
          outCanvas.height = ph;
        } else {
          ctx.clearRect(0, 0, pw, ph);
        }
        hasDrawnOverlayRef.current = false;
      }
      return;
    }

    if (outCanvas.width !== pw || outCanvas.height !== ph) {
      outCanvas.width = pw;
      outCanvas.height = ph;
    }

    const { width: baseW, height: baseH } = getMaskRasterDimensions(
      baseSourceCanvas.width,
      baseSourceCanvas.height
    );

    const baseRgbaProvider = {
      key: getMaskSourceCacheKey(baseSourceCanvas),
      getRgba: () => getCachedBaseSourceRgba(baseSourceCanvas, baseW, baseH),
    };

    const baseAlpha = evaluateMaskLayerBaseAlpha(mask!, baseW, baseH, baseRgbaProvider);
    const dispAlpha = projectMaskToTransformedSpace(baseAlpha, baseW, baseH, pw, ph, transform);

    const [cr, cg, cb] = forceRedMask
      ? [239, 68, 68]
      : hexToRgb(mask!.overlayColor || '#ef4444');
    const alphaScale = forceRedMask ? 148 : 138;

    let img = overlayImageDataRef.current;
    if (!img || img.width !== pw || img.height !== ph) {
      img = ctx.createImageData(pw, ph);
      overlayImageDataRef.current = img;
    } else {
      img.data.fill(0);
    }

    const d = img.data;
    for (let i = 0; i < dispAlpha.length; i++) {
      const a = dispAlpha[i];
      if (a > 0.01) {
        const idx = i * 4;
        d[idx] = cr;
        d[idx + 1] = cg;
        d[idx + 2] = cb;
        d[idx + 3] = Math.round(a * alphaScale);
      }
    }
    ctx.putImageData(img, 0, 0);
    hasDrawnOverlayRef.current = true;
  };

  const scheduleOverlayRender = () => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      renderOverlay();
    });
  };

  useEffect(() => {
    scheduleOverlayRender();
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [
    activeMask?.id,
    activeMask?.showOverlay,
    activeMask?.overlayColor,
    activeMask?.inverted,
    activeMask?.feather,
    activeMask?.density,
    activeMask?.edgeRefinement,
    activeMask?.components,
    forceRedMask,
    transform,
    displayWidth,
    displayHeight,
    baseSourceCanvas,
  ]);

  useEffect(() => {
    return () => {
      if (moveRafRef.current !== null) {
        cancelAnimationFrame(moveRafRef.current);
        moveRafRef.current = null;
      }
      overlayImageDataRef.current = null;
    };
  }, []);

  // Keep brush cursor scaled to CSS size
  useEffect(() => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    if (rect.width <= 0) return;
    const mapped = screenToRetouchCoords(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
      rect,
      transform,
      baseSourceCanvas.width,
      baseSourceCanvas.height,
      true
    );
    const { width: maskBaseW } = getMaskRasterDimensions(
      baseSourceCanvas.width,
      baseSourceCanvas.height
    );
    const ratio = maskBaseW / Math.max(1, baseSourceCanvas.width);
    setLiveBrushScale(1 / Math.max(0.05, mapped.scaleDisplayToRetouch * ratio));
  }, [transform, baseSourceCanvas.width, baseSourceCanvas.height, displayWidth, displayHeight]);

  const clientToBaseNorm = (clientX: number, clientY: number): { nx: number; ny: number } => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return { nx: 0.5, ny: 0.5 };
    const pt = screenToRetouchCoords(
      clientX,
      clientY,
      rect,
      transform,
      baseSourceCanvas.width,
      baseSourceCanvas.height,
      true
    );
    return {
      nx: Math.max(0, Math.min(1, pt.x / Math.max(1, baseSourceCanvas.width - 1))),
      ny: Math.max(0, Math.min(1, pt.y / Math.max(1, baseSourceCanvas.height - 1))),
    };
  };

  const baseNormToDisplayPct = (nx: number, ny: number): { xPct: number; yPct: number } => {
    const res = retouchToDisplayNormalized(
      nx * (baseSourceCanvas.width - 1),
      ny * (baseSourceCanvas.height - 1),
      transform,
      baseSourceCanvas.width,
      baseSourceCanvas.height,
      true
    );
    return { xPct: res.nx * 100, yPct: res.ny * 100 };
  };

  const flushPendingMoves = () => {
    const st = strokeRef.current;
    const mask = activeMaskRef.current;
    if (!st || !mask) {
      pendingBrushPtsRef.current.length = 0;
      pendingHandleNormRef.current = null;
      pendingBoxDispRef.current = null;
      return;
    }

    if (st.type === 'brush' && st.componentId && st.lastNorm && pendingBrushPtsRef.current.length > 0) {
      const pts = pendingBrushPtsRef.current.splice(0, pendingBrushPtsRef.current.length);
      const bs = brushSettingsRef.current;
      const radiusPx = bs.size / 2;
      const step = Math.max(2, radiusPx * 0.25);
      const startLast = st.lastNorm;
      const endLast = pts[pts.length - 1];

      onUpdateMaskLayer(
        mask.id,
        (prev) => ({
          ...prev,
          components: prev.components.map((c) => {
            if (c.id !== st.componentId || c.kind !== 'brush') return c;
            const rw = c.raster.width;
            const rh = c.raster.height;
            let cur = startLast;
            for (let pIdx = 0; pIdx < pts.length; pIdx++) {
              const norm = pts[pIdx];
              const dx = (norm.nx - cur.nx) * rw;
              const dy = (norm.ny - cur.ny) * rh;
              const dist = Math.hypot(dx, dy);
              if (dist < 1) continue;
              const steps = Math.max(1, Math.ceil(dist / step));
              for (let s = 1; s <= steps; s++) {
                const t = s / steps;
                paintMaskBrushDab(
                  c.raster,
                  cur.nx + (norm.nx - cur.nx) * t,
                  cur.ny + (norm.ny - cur.ny) * t,
                  radiusPx,
                  bs.feather,
                  bs.flow,
                  bs.density,
                  false
                );
              }
              cur = norm;
            }
            return { ...c, raster: { ...c.raster } };
          }),
        }),
        false
      );
      st.lastNorm = endLast;
      scheduleOverlayRender();
      return;
    }

    if (st.type === 'object-box' && pendingBoxDispRef.current) {
      const boxPt = pendingBoxDispRef.current;
      pendingBoxDispRef.current = null;
      setDragBox((prev) => (prev ? { ...prev, x1: boxPt.x1, y1: boxPt.y1 } : null));
      return;
    }

    if (st.type === 'linear-handle' && st.componentId && st.handle && pendingHandleNormRef.current) {
      const norm = pendingHandleNormRef.current;
      pendingHandleNormRef.current = null;
      onUpdateMaskLayer(
        mask.id,
        (prev) => ({
          ...prev,
          components: prev.components.map((c) => {
            if (c.id !== st.componentId || c.kind !== 'linear') return c;
            if (st.handle === 'start') return { ...c, x0: norm.nx, y0: norm.ny };
            return { ...c, x1: norm.nx, y1: norm.ny };
          }),
        }),
        false
      );
      scheduleOverlayRender();
      return;
    }

    if (st.type === 'radial-handle' && st.componentId && st.handle && pendingHandleNormRef.current) {
      const norm = pendingHandleNormRef.current;
      pendingHandleNormRef.current = null;
      onUpdateMaskLayer(
        mask.id,
        (prev) => ({
          ...prev,
          components: prev.components.map((c) => {
            if (c.id !== st.componentId || c.kind !== 'radial') return c;
            if (st.handle === 'center') return { ...c, cx: norm.nx, cy: norm.ny };
            if (st.handle === 'edgeX') {
              return { ...c, rx: Math.max(0.03, Math.abs(norm.nx - c.cx)) };
            }
            return { ...c, ry: Math.max(0.03, Math.abs(norm.ny - c.cy)) };
          }),
        }),
        false
      );
      scheduleOverlayRender();
    }
  };

  const scheduleMoveFlush = () => {
    if (moveRafRef.current !== null) return;
    moveRafRef.current = requestAnimationFrame(() => {
      moveRafRef.current = null;
      flushPendingMoves();
    });
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    if (!containerRef.current || !activeMask) return;
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    e.stopPropagation();
    e.preventDefault();

    const rect = containerRef.current.getBoundingClientRect();
    updateCursorRing(e.clientX, e.clientY);
    const norm = clientToBaseNorm(e.clientX, e.clientY);

    // 1. Pick Color / Luminance Eyedropper
    if (pointerTool.mode === 'pick-color' || pointerTool.mode === 'pick-luminance') {
      const sampled = samplePixelAtNormalized(baseSourceCanvas, norm.nx, norm.ny);
      const compId = pointerTool.componentId;
      onUpdateMaskLayer(
        activeMask.id,
        (prev) => ({
          ...prev,
          components: prev.components.map((c) => {
            if (c.id !== compId) return c;
            if (pointerTool.mode === 'pick-color' && c.kind === 'color-range') {
              return { ...c, targetRgb: sampled.rgb };
            }
            if (pointerTool.mode === 'pick-luminance' && c.kind === 'luminance-range') {
              const lo = Math.max(0, sampled.lumPct - 18);
              const hi = Math.min(100, sampled.lumPct + 18);
              return { ...c, minLum: lo, maxLum: hi };
            }
            return c;
          }),
        }),
        true
      );
      onSwitchBackToHandles();
      return;
    }

    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // Ignore synthetic/unsupported pointer capture
    }

    // 2. Brush Painting
    if (pointerTool.mode === 'brush') {
      const compId = pointerTool.componentId;
      onUpdateMaskLayer(
        activeMask.id,
        (prev) => ({
          ...prev,
          components: prev.components.map((c) => {
            if (c.id !== compId || c.kind !== 'brush') return c;
            paintMaskBrushDab(
              c.raster,
              norm.nx,
              norm.ny,
              brushSettings.size / 2,
              brushSettings.feather,
              brushSettings.flow,
              brushSettings.density,
              false
            );
            return { ...c, raster: { ...c.raster } };
          }),
        }),
        false
      );
      pendingBrushPtsRef.current.length = 0;
      strokeRef.current = {
        type: 'brush',
        componentId: compId,
        lastNorm: norm,
        snapshotBefore: activeMask,
      };
      scheduleOverlayRender();
      return;
    }

    // 3. Object Bounding Box Selection
    if (pointerTool.mode === 'create-object') {
      const nxDisp = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)));
      const nyDisp = Math.max(0, Math.min(1, (e.clientY - rect.top) / Math.max(1, rect.height)));
      strokeRef.current = {
        type: 'object-box',
        startNorm: norm,
      };
      setDragBox({ x0: nxDisp, y0: nyDisp, x1: nxDisp, y1: nyDisp });
      return;
    }

    // 4. Drag to create new Linear Gradient
    if (pointerTool.mode === 'create-linear') {
      const id = `comp-lin-${Date.now()}`;
      const newComp: MaskComponent = {
        id,
        op: pointerTool.op,
        kind: 'linear',
        x0: norm.nx,
        y0: norm.ny,
        x1: Math.min(1, norm.nx + 0.02),
        y1: Math.min(1, norm.ny + 0.02),
      };
      onCreateGradientComponent(newComp);
      strokeRef.current = {
        type: 'linear-handle',
        componentId: id,
        handle: 'end',
      };
      return;
    }

    // 5. Drag to create new Radial Gradient
    if (pointerTool.mode === 'create-radial') {
      const id = `comp-rad-${Date.now()}`;
      const newComp: MaskComponent = {
        id,
        op: pointerTool.op,
        kind: 'radial',
        cx: norm.nx,
        cy: norm.ny,
        rx: 0.05,
        ry: 0.05,
        angle: 0,
        feather: 50,
      };
      onCreateGradientComponent(newComp);
      strokeRef.current = {
        type: 'radial-handle',
        componentId: id,
        handle: 'edgeX',
      };
    }
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!containerRef.current) return;
    updateCursorRing(e.clientX, e.clientY);

    const st = strokeRef.current;
    if (!st || !activeMask) return;

    if (st.type === 'object-box' && st.startNorm) {
      const rect = containerRef.current.getBoundingClientRect();
      const nxDisp = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)));
      const nyDisp = Math.max(0, Math.min(1, (e.clientY - rect.top) / Math.max(1, rect.height)));
      pendingBoxDispRef.current = { x1: nxDisp, y1: nyDisp };
      scheduleMoveFlush();
      return;
    }

    const norm = clientToBaseNorm(e.clientX, e.clientY);
    if (st.type === 'brush') {
      pendingBrushPtsRef.current.push(norm);
      scheduleMoveFlush();
      return;
    }

    if (st.type === 'linear-handle' || st.type === 'radial-handle') {
      pendingHandleNormRef.current = norm;
      scheduleMoveFlush();
    }
  };

  const endStroke = (e: React.PointerEvent) => {
    const st = strokeRef.current;
    if (!st) return;

    if (moveRafRef.current !== null) {
      cancelAnimationFrame(moveRafRef.current);
      moveRafRef.current = null;
    }
    flushPendingMoves();

    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }

    if (st.type === 'object-box' && st.startNorm && pointerTool.mode === 'create-object') {
      const endNorm = clientToBaseNorm(e.clientX, e.clientY);
      const x0 = Math.min(st.startNorm.nx, endNorm.nx);
      const y0 = Math.min(st.startNorm.ny, endNorm.ny);
      const w = Math.max(0.05, Math.abs(endNorm.nx - st.startNorm.nx));
      const h = Math.max(0.05, Math.abs(endNorm.ny - st.startNorm.ny));
      setDragBox(null);
      strokeRef.current = null;
      onFinishObjectBox({ x: x0, y: y0, width: Math.min(1 - x0, w), height: Math.min(1 - y0, h) }, pointerTool.op);
      return;
    }

    strokeRef.current = null;
    if (activeMaskRef.current) {
      onUpdateMaskLayer(activeMaskRef.current.id, (prev) => prev, true);
    }
    if (pointerTool.mode === 'create-linear' || pointerTool.mode === 'create-radial') {
      onSwitchBackToHandles();
    }
  };

  const startHandleDrag = (
    e: React.PointerEvent,
    type: 'linear-handle' | 'radial-handle',
    componentId: string,
    handle: 'start' | 'end' | 'center' | 'edgeX' | 'edgeY'
  ) => {
    e.stopPropagation();
    e.preventDefault();
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // Ignore synthetic/unsupported pointer capture
    }
    strokeRef.current = { type, componentId, handle };
  };

  const isIdle = pointerTool.mode === 'idle';
  const isBrushActive = pointerTool.mode === 'brush';
  const showSelectionHandles =
    pointerTool.mode === 'edit-handles' ||
    pointerTool.mode === 'create-linear' ||
    pointerTool.mode === 'create-radial';
  const cursorDiam = Math.max(8, brushSettings.size * liveBrushScale);

  return (
    <div
      ref={containerRef}
      onPointerDown={isIdle ? undefined : handlePointerDown}
      onPointerMove={isIdle ? undefined : handlePointerMove}
      onPointerEnter={
        isIdle
          ? undefined
          : (e) => {
              updateCursorRing(e.clientX, e.clientY);
            }
      }
      onPointerUp={isIdle ? undefined : endStroke}
      onPointerCancel={isIdle ? undefined : endStroke}
      onPointerLeave={hideCursorRing}
      className={`absolute inset-0 z-20 select-none ${
        isIdle
          ? 'pointer-events-none'
          : `touch-none ${
              isBrushActive
                ? 'cursor-none'
                : pointerTool.mode === 'edit-handles'
                  ? 'cursor-default'
                  : 'cursor-crosshair'
            }`
      }`}
    >
      {/* Active Mask Overlay Projection Canvas */}
      <canvas
        ref={overlayCanvasRef}
        className="pointer-events-none absolute inset-0 h-full w-full block"
      />

      {/* Interactive Gradient Handles (auto-hidden when editing adjustments / idle) */}
      {showSelectionHandles &&
        activeMask?.components.map((comp) => {
          if (comp.kind === 'linear') {
            const p0 = baseNormToDisplayPct(comp.x0, comp.y0);
            const p1 = baseNormToDisplayPct(comp.x1, comp.y1);
            return (
              <React.Fragment key={comp.id}>
                <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
                  <line
                    x1={`${p0.xPct}%`}
                    y1={`${p0.yPct}%`}
                    x2={`${p1.xPct}%`}
                    y2={`${p1.yPct}%`}
                    stroke="#ffffff"
                    strokeWidth="1.5"
                    strokeDasharray="4 3"
                  />
                </svg>
                <button
                  type="button"
                  aria-label="Gradient start handle"
                  onPointerDown={(e) => startHandleDrag(e, 'linear-handle', comp.id, 'start')}
                  className="absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-zinc-950 shadow-md cursor-grab active:cursor-grabbing"
                  style={{ left: `${p0.xPct}%`, top: `${p0.yPct}%` }}
                />
                <button
                  type="button"
                  aria-label="Gradient end handle"
                  onPointerDown={(e) => startHandleDrag(e, 'linear-handle', comp.id, 'end')}
                  className="absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-white shadow-md cursor-grab active:cursor-grabbing"
                  style={{ left: `${p1.xPct}%`, top: `${p1.yPct}%` }}
                />
              </React.Fragment>
            );
          }

          if (comp.kind === 'radial') {
            const pc = baseNormToDisplayPct(comp.cx, comp.cy);
            const px = baseNormToDisplayPct(Math.min(1, comp.cx + comp.rx), comp.cy);
            const py = baseNormToDisplayPct(comp.cx, Math.min(1, comp.cy + comp.ry));
            return (
              <React.Fragment key={comp.id}>
                <button
                  type="button"
                  aria-label="Radial center handle"
                  onPointerDown={(e) => startHandleDrag(e, 'radial-handle', comp.id, 'center')}
                  className="absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-white shadow-md cursor-grab active:cursor-grabbing"
                  style={{ left: `${pc.xPct}%`, top: `${pc.yPct}%` }}
                />
                <button
                  type="button"
                  aria-label="Radial width handle"
                  onPointerDown={(e) => startHandleDrag(e, 'radial-handle', comp.id, 'edgeX')}
                  className="absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-zinc-950 shadow cursor-ew-resize"
                  style={{ left: `${px.xPct}%`, top: `${px.yPct}%` }}
                />
                <button
                  type="button"
                  aria-label="Radial height handle"
                  onPointerDown={(e) => startHandleDrag(e, 'radial-handle', comp.id, 'edgeY')}
                  className="absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-zinc-950 shadow cursor-ns-resize"
                  style={{ left: `${py.xPct}%`, top: `${py.yPct}%` }}
                />
              </React.Fragment>
            );
          }

          return null;
        })}

      {/* Object Selection Box Marquee */}
      {!isIdle && dragBox && (
        <div
          className="pointer-events-none absolute border-2 border-dashed border-white bg-white/10"
          style={{
            left: `${Math.min(dragBox.x0, dragBox.x1) * 100}%`,
            top: `${Math.min(dragBox.y0, dragBox.y1) * 100}%`,
            width: `${Math.abs(dragBox.x1 - dragBox.x0) * 100}%`,
            height: `${Math.abs(dragBox.y1 - dragBox.y0) * 100}%`,
          }}
        />
      )}

      {/* Mode Hint Banner for creation / picking */}
      {!isIdle && pointerTool.mode !== 'edit-handles' && pointerTool.mode !== 'brush' && (
        <div className="pointer-events-none absolute top-3 left-1/2 -translate-x-1/2 rounded-md bg-black/80 px-3 py-1 text-[11px] font-medium text-white border border-white/15 backdrop-blur-sm">
          {pointerTool.mode === 'create-linear' && 'Drag across the photo to place Linear Gradient'}
          {pointerTool.mode === 'create-radial' && 'Drag from center outward to place Radial Gradient'}
          {pointerTool.mode === 'create-object' && 'Drag a box around the object to select it'}
          {pointerTool.mode === 'pick-color' && 'Click a color on the photo to sample Color Range'}
          {pointerTool.mode === 'pick-luminance' && 'Click on the photo to sample Luminance Range'}
        </div>
      )}

      {/* Live Mask Brush Ring Cursor (DOM-driven zero re-render positioning) */}
      <div
        ref={cursorRingRef}
        className="pointer-events-none absolute left-0 top-0 rounded-full border border-white shadow-[0_0_0_1px_rgba(0,0,0,0.75)]"
        style={{
          display: 'none',
          width: `${cursorDiam}px`,
          height: `${cursorDiam}px`,
          opacity: isBrushActive ? 1 : 0,
        }}
      />
    </div>
  );
};

export const MaskCanvasOverlay = memo(MaskCanvasOverlayComponent);

// Keep MaskCreationTool type exported for consumers if needed
export type { MaskCreationTool };
