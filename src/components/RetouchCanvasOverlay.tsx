import React, { memo, useEffect, useRef, useState } from 'react';
import {
  DirtyRect,
  RetouchBrushConfig,
  RetouchNormPoint,
  RetouchOperation,
  RetouchTool,
  TransformState,
} from '../types/editor';
import { renderGeometryCanvas } from '../engine/imageProcessor';
import { getDevicePerformanceProfile } from '../engine/performanceProfile';
import {
  paintAlphaMaskDab,
  paintCloneDab,
  paintHealingDab,
  paintObjectMaskDab,
  RetouchBuffers,
  retouchToDisplayNormalized,
  screenToRetouchCoords,
  syncManualAlphaDeltaRect,
} from '../engine/retouchEngine';

export interface CloneSourcePoint {
  x: number;
  y: number;
}

interface RetouchCanvasOverlayProps {
  buffers: RetouchBuffers;
  transform: TransformState;
  activeTool: RetouchTool;
  brushConfig: RetouchBrushConfig;
  cloneSource: CloneSourcePoint | null;
  isPickingCloneSource: boolean;
  maskRenderVersion: number;
  onSetCloneSource: (pt: CloneSourcePoint) => void;
  onRetouchLiveUpdate: () => void;
  onCommitDirtyPatch: (
    target: 'rgb' | 'alpha',
    rect: DirtyRect,
    before: ImageData,
    after: ImageData,
    retouchOp?: RetouchOperation
  ) => void;
  onObjectMaskPainted: () => void;
}

function unionDirtyRect(a: DirtyRect | null, b: DirtyRect | null): DirtyRect | null {
  if (!a) return b;
  if (!b) return a;
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.width, b.x + b.width);
  const y1 = Math.max(a.y + a.height, b.y + b.height);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

const RetouchCanvasOverlayComponent: React.FC<RetouchCanvasOverlayProps> = ({
  buffers,
  transform,
  activeTool,
  brushConfig,
  cloneSource,
  isPickingCloneSource,
  maskRenderVersion,
  onSetCloneSource,
  onRetouchLiveUpdate,
  onCommitDirtyPatch,
  onObjectMaskPainted,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const maskPreviewCanvasRef = useRef<HTMLCanvasElement>(null);
  const alphaOverlayTmpCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const maskGeoCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const strokeSnapshotCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const reusableBeforeAlphaRef = useRef<Uint8ClampedArray | null>(null);
  const cursorRingRef = useRef<HTMLDivElement>(null);
  const cloneCrosshairRef = useRef<HTMLDivElement>(null);
  const maskRafRef = useRef<number | null>(null);
  const dabRafRef = useRef<number | null>(null);

  const [liveBrushScale, setLiveBrushScale] = useState<number>(1);
  const pendingMovePtsRef = useRef<{ x: number; y: number }[]>([]);

  // Stroke tracking refs
  const strokeRef = useRef<{
    active: boolean;
    lastRetouchPt: { x: number; y: number };
    recordedPoints: RetouchNormPoint[];
    dirtyRect: DirtyRect | null;
    beforeFullSnapshot: HTMLCanvasElement | null;
    beforeAlphaSnapshot: Uint8ClampedArray | null;
    cloneDelta: { dx: number; dy: number } | null;
  } | null>(null);

  // Track persistent aligned clone offset across strokes
  const alignedCloneDeltaRef = useRef<{ dx: number; dy: number } | null>(null);
  const lastCloneSourceRef = useRef<CloneSourcePoint | null>(cloneSource);

  useEffect(() => {
    if (lastCloneSourceRef.current !== cloneSource) {
      lastCloneSourceRef.current = cloneSource;
      alignedCloneDeltaRef.current = null;
    }
  }, [cloneSource]);

  const currentBrushRadius = (() => {
    switch (activeTool) {
      case 'object-remover':
        return brushConfig.objectBrushSize / 2;
      case 'eraser':
        return brushConfig.eraserSize / 2;
      case 'healing':
        return brushConfig.healingSize / 2;
      case 'clone':
        return brushConfig.cloneSize / 2;
      case 'background':
        return brushConfig.bgBrushSize / 2;
    }
  })();

  const showAlphaMaskPreview =
    (activeTool === 'eraser' && brushConfig.eraserShowMask) ||
    (activeTool === 'background' && brushConfig.bgShowMask);

  const updateCursorDom = (clientX: number, clientY: number, cloneFollowDelta: { dx: number; dy: number } | null) => {
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;

    if (cursorRingRef.current) {
      cursorRingRef.current.style.display =
        activeTool === 'clone' && isPickingCloneSource ? 'none' : 'block';
      cursorRingRef.current.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%)`;
    }

    if (cloneCrosshairRef.current && activeTool === 'clone' && cloneSource) {
      let sx = cloneSource.x;
      let sy = cloneSource.y;
      if (cloneFollowDelta) {
        const curRetouch = screenToRetouchCoords(
          clientX,
          clientY,
          rect,
          transform,
          buffers.width,
          buffers.height,
          true
        );
        sx = curRetouch.x + cloneFollowDelta.dx;
        sy = curRetouch.y + cloneFollowDelta.dy;
      }
      const norm = retouchToDisplayNormalized(
        sx,
        sy,
        transform,
        buffers.width,
        buffers.height,
        true
      );
      if (norm.nx >= 0 && norm.nx <= 1 && norm.ny >= 0 && norm.ny <= 1) {
        cloneCrosshairRef.current.style.display = 'block';
        cloneCrosshairRef.current.style.left = `${norm.nx * 100}%`;
        cloneCrosshairRef.current.style.top = `${norm.ny * 100}%`;
      } else {
        cloneCrosshairRef.current.style.display = 'none';
      }
    }
  };

  const hideCursorDom = () => {
    if (cursorRingRef.current) {
      cursorRingRef.current.style.display = 'none';
    }
  };

  // Render Object Remover selection mask or Eraser/BG red mask preview aligned with geometry
  const syncMaskOverlay = () => {
    const outCanvas = maskPreviewCanvasRef.current;
    if (!outCanvas) return;

    const maxOverlayDim = Math.min(720, getDevicePerformanceProfile().maskOverlayMaxDim + 180);
    if (!maskGeoCanvasRef.current) {
      maskGeoCanvasRef.current = document.createElement('canvas');
    }

    if (activeTool === 'object-remover') {
      const geo = renderGeometryCanvas(
        buffers.objectMaskCanvas,
        transform,
        maxOverlayDim,
        true,
        maskGeoCanvasRef.current
      );
      if (outCanvas.width !== geo.width || outCanvas.height !== geo.height) {
        outCanvas.width = geo.width;
        outCanvas.height = geo.height;
      }
      const ctx = outCanvas.getContext('2d');
      if (ctx) {
        ctx.clearRect(0, 0, geo.width, geo.height);
        ctx.globalAlpha = 0.48;
        ctx.drawImage(geo, 0, 0);
      }
      return;
    }

    if (showAlphaMaskPreview) {
      const hex = activeTool === 'background' ? brushConfig.bgMaskOverlayColor || '#ef4444' : '#ef4444';
      const clean = hex.replace('#', '');
      const ovR = parseInt(clean.slice(0, 2), 16) || 239;
      const ovG = parseInt(clean.slice(2, 4), 16) || 68;
      const ovB = parseInt(clean.slice(4, 6), 16) || 68;

      const maxPrev = getDevicePerformanceProfile().maskOverlayMaxDim;
      const scale = Math.min(1, maxPrev / Math.max(buffers.width, buffers.height));
      const pw = Math.max(1, Math.round(buffers.width * scale));
      const ph = Math.max(1, Math.round(buffers.height * scale));

      if (!alphaOverlayTmpCanvasRef.current) {
        alphaOverlayTmpCanvasRef.current = document.createElement('canvas');
      }
      const tmp = alphaOverlayTmpCanvasRef.current;
      if (tmp.width !== pw || tmp.height !== ph) {
        tmp.width = pw;
        tmp.height = ph;
      }
      const tCtx = tmp.getContext('2d', { willReadFrequently: true });
      if (tCtx) {
        tCtx.clearRect(0, 0, pw, ph);
        tCtx.drawImage(buffers.alphaCanvas, 0, 0, pw, ph);
        const overlayImg = tCtx.getImageData(0, 0, pw, ph);
        const od = overlayImg.data;
        for (let i = 0; i < od.length; i += 4) {
          const alpha = od[i];
          if (alpha < 252) {
            od[i] = ovR;
            od[i + 1] = ovG;
            od[i + 2] = ovB;
            od[i + 3] = Math.round(((255 - alpha) / 255) * 165);
          } else {
            od[i + 3] = 0;
          }
        }
        tCtx.putImageData(overlayImg, 0, 0);
        const geo = renderGeometryCanvas(
          tmp,
          transform,
          maxOverlayDim,
          true,
          maskGeoCanvasRef.current
        );
        if (outCanvas.width !== geo.width || outCanvas.height !== geo.height) {
          outCanvas.width = geo.width;
          outCanvas.height = geo.height;
        }
        const ctx = outCanvas.getContext('2d');
        if (ctx) {
          ctx.clearRect(0, 0, geo.width, geo.height);
          ctx.drawImage(geo, 0, 0);
        }
      }
      return;
    }

    const ctx = outCanvas.getContext('2d');
    if (ctx) {
      ctx.clearRect(0, 0, outCanvas.width, outCanvas.height);
    }
  };

  const scheduleMaskOverlaySync = () => {
    if (maskRafRef.current !== null) return;
    maskRafRef.current = requestAnimationFrame(() => {
      maskRafRef.current = null;
      syncMaskOverlay();
    });
  };

  useEffect(() => {
    syncMaskOverlay();
    return () => {
      if (maskRafRef.current !== null) {
        cancelAnimationFrame(maskRafRef.current);
        maskRafRef.current = null;
      }
    };
  }, [
    activeTool,
    showAlphaMaskPreview,
    brushConfig.bgMaskOverlayColor,
    transform,
    maskRenderVersion,
    buffers,
  ]);

  useEffect(() => {
    return () => {
      if (dabRafRef.current !== null) {
        cancelAnimationFrame(dabRafRef.current);
        dabRafRef.current = null;
      }
      if (strokeSnapshotCanvasRef.current) {
        strokeSnapshotCanvasRef.current.width = 0;
        strokeSnapshotCanvasRef.current.height = 0;
      }
      if (alphaOverlayTmpCanvasRef.current) {
        alphaOverlayTmpCanvasRef.current.width = 0;
        alphaOverlayTmpCanvasRef.current.height = 0;
      }
      if (maskGeoCanvasRef.current) {
        maskGeoCanvasRef.current.width = 0;
        maskGeoCanvasRef.current.height = 0;
      }
    };
  }, []);

  // Keep live brush cursor radius matched to CSS display scale
  useEffect(() => {
    const updateScale = () => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      if (rect.width <= 0) return;
      const mapped = screenToRetouchCoords(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
        rect,
        transform,
        buffers.width,
        buffers.height,
        true
      );
      setLiveBrushScale(1 / Math.max(0.05, mapped.scaleDisplayToRetouch));
    };
    updateScale();
    const ro = new ResizeObserver(updateScale);
    if (containerRef.current) ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [transform, buffers.width, buffers.height]);

  const applyDabAt = (rx: number, ry: number) => {
    const st = strokeRef.current;
    if (!st) return;

    if (activeTool === 'object-remover') {
      paintObjectMaskDab(buffers.objectMaskCanvas, rx, ry, currentBrushRadius);
      return;
    }

    if (activeTool === 'eraser' || activeTool === 'background') {
      const isBg = activeTool === 'background';
      const radius = isBg ? brushConfig.bgBrushSize / 2 : brushConfig.eraserSize / 2;
      const hardness = isBg ? brushConfig.bgBrushHardness : brushConfig.eraserHardness;
      const feather = isBg ? brushConfig.bgBrushFeather : 0;
      const opacity = isBg ? 100 : brushConfig.eraserOpacity;
      const mode = isBg ? brushConfig.bgBrushMode : brushConfig.eraserMode;

      const dirty = paintAlphaMaskDab(
        buffers.alphaCanvas,
        rx,
        ry,
        radius,
        hardness,
        opacity,
        mode,
        st.beforeAlphaSnapshot ?? undefined,
        feather
      );
      if (dirty) {
        if (isBg) {
          syncManualAlphaDeltaRect(buffers, dirty);
        }
        st.dirtyRect = unionDirtyRect(st.dirtyRect, dirty);
      }
      return;
    }

    if (activeTool === 'healing' && st.beforeFullSnapshot) {
      const dirty = paintHealingDab(
        buffers.retouchCanvas,
        st.beforeFullSnapshot,
        rx,
        ry,
        brushConfig.healingSize / 2,
        brushConfig.healingSoftness
      );
      st.dirtyRect = unionDirtyRect(st.dirtyRect, dirty);
      return;
    }

    if (activeTool === 'clone' && st.beforeFullSnapshot && st.cloneDelta) {
      const sx = rx + st.cloneDelta.dx;
      const sy = ry + st.cloneDelta.dy;
      const dirty = paintCloneDab(
        buffers.retouchCanvas,
        st.beforeFullSnapshot,
        rx,
        ry,
        sx,
        sy,
        brushConfig.cloneSize / 2,
        brushConfig.cloneHardness,
        brushConfig.cloneOpacity
      );
      st.dirtyRect = unionDirtyRect(st.dirtyRect, dirty);
    }
  };

  const flushPendingDabs = () => {
    const st = strokeRef.current;
    const pts = pendingMovePtsRef.current;
    if (!st || !st.active || pts.length === 0) {
      pts.length = 0;
      return;
    }

    const batch = pts.splice(0, pts.length);
    const step = Math.max(2, currentBrushRadius * 0.28);
    let anyPainted = false;

    for (let i = 0; i < batch.length; i++) {
      const pt = batch[i];
      const dx = pt.x - st.lastRetouchPt.x;
      const dy = pt.y - st.lastRetouchPt.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 1) continue;

      const steps = Math.max(1, Math.ceil(dist / step));
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        applyDabAt(st.lastRetouchPt.x + dx * t, st.lastRetouchPt.y + dy * t);
      }
      st.lastRetouchPt = pt;
      st.recordedPoints.push({
        nx: Math.max(0, Math.min(1, pt.x / Math.max(1, buffers.width))),
        ny: Math.max(0, Math.min(1, pt.y / Math.max(1, buffers.height))),
      });
      anyPainted = true;
    }

    if (!anyPainted) return;

    if (activeTool === 'object-remover') {
      scheduleMaskOverlaySync();
      onObjectMaskPainted();
    } else {
      if (showAlphaMaskPreview) scheduleMaskOverlaySync();
      onRetouchLiveUpdate();
    }
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    if (!containerRef.current) return;
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    e.stopPropagation();
    e.preventDefault();

    const rect = containerRef.current.getBoundingClientRect();
    const pt = screenToRetouchCoords(
      e.clientX,
      e.clientY,
      rect,
      transform,
      buffers.width,
      buffers.height,
      true
    );
    setLiveBrushScale(1 / Math.max(0.05, pt.scaleDisplayToRetouch));

    // Clone Stamp source selection (via Pick Source toggle OR Alt+Click)
    if (activeTool === 'clone' && (isPickingCloneSource || e.altKey)) {
      updateCursorDom(e.clientX, e.clientY, null);
      onSetCloneSource({ x: pt.x, y: pt.y });
      return;
    }

    if (activeTool === 'clone' && !cloneSource) {
      updateCursorDom(e.clientX, e.clientY, null);
      onSetCloneSource({ x: pt.x, y: pt.y });
      return;
    }

    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // Ignore synthetic/unsupported pointer capture
    }

    // Prepare before-snapshot for undoable dirty patch & non-smearing stroke source
    let beforeFullSnapshot: HTMLCanvasElement | null = null;
    let beforeAlphaSnapshot: Uint8ClampedArray | null = null;

    if (activeTool !== 'object-remover') {
      if (!strokeSnapshotCanvasRef.current) {
        strokeSnapshotCanvasRef.current = document.createElement('canvas');
      }
      beforeFullSnapshot = strokeSnapshotCanvasRef.current;
      if (
        beforeFullSnapshot.width !== buffers.width ||
        beforeFullSnapshot.height !== buffers.height
      ) {
        beforeFullSnapshot.width = buffers.width;
        beforeFullSnapshot.height = buffers.height;
      }
    }

    if ((activeTool === 'eraser' || activeTool === 'background') && beforeFullSnapshot) {
      beforeFullSnapshot.getContext('2d')?.drawImage(buffers.alphaCanvas, 0, 0);

      const aCtx = buffers.alphaCanvas.getContext('2d', { willReadFrequently: true });
      if (aCtx) {
        const raw = aCtx.getImageData(0, 0, buffers.width, buffers.height).data;
        const neededLen = buffers.width * buffers.height;
        if (
          !reusableBeforeAlphaRef.current ||
          reusableBeforeAlphaRef.current.length !== neededLen
        ) {
          reusableBeforeAlphaRef.current = new Uint8ClampedArray(neededLen);
        }
        beforeAlphaSnapshot = reusableBeforeAlphaRef.current;
        for (let i = 0; i < neededLen; i++) {
          beforeAlphaSnapshot[i] = raw[i * 4];
        }
      }
    } else if ((activeTool === 'healing' || activeTool === 'clone') && beforeFullSnapshot) {
      beforeFullSnapshot.getContext('2d')?.drawImage(buffers.retouchCanvas, 0, 0);
    }

    let cloneDelta: { dx: number; dy: number } | null = null;
    if (activeTool === 'clone' && cloneSource) {
      if (brushConfig.cloneAligned && alignedCloneDeltaRef.current) {
        cloneDelta = alignedCloneDeltaRef.current;
      } else {
        cloneDelta = {
          dx: cloneSource.x - pt.x,
          dy: cloneSource.y - pt.y,
        };
        if (brushConfig.cloneAligned) {
          alignedCloneDeltaRef.current = cloneDelta;
        }
      }
    }

    updateCursorDom(e.clientX, e.clientY, cloneDelta);

    const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
    pendingMovePtsRef.current.length = 0;
    strokeRef.current = {
      active: true,
      lastRetouchPt: { x: pt.x, y: pt.y },
      recordedPoints: [
        {
          nx: clamp01(pt.x / Math.max(1, buffers.width)),
          ny: clamp01(pt.y / Math.max(1, buffers.height)),
        },
      ],
      dirtyRect: null,
      beforeFullSnapshot,
      beforeAlphaSnapshot,
      cloneDelta,
    };

    applyDabAt(pt.x, pt.y);

    if (activeTool === 'object-remover') {
      scheduleMaskOverlaySync();
      onObjectMaskPainted();
    } else {
      if (showAlphaMaskPreview) scheduleMaskOverlaySync();
      onRetouchLiveUpdate();
    }
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!containerRef.current) return;
    const st = strokeRef.current;
    updateCursorDom(e.clientX, e.clientY, st?.active ? st.cloneDelta : null);

    if (!st || !st.active) return;

    const rect = containerRef.current.getBoundingClientRect();
    const pt = screenToRetouchCoords(
      e.clientX,
      e.clientY,
      rect,
      transform,
      buffers.width,
      buffers.height,
      true
    );
    pendingMovePtsRef.current.push({ x: pt.x, y: pt.y });

    if (dabRafRef.current === null) {
      dabRafRef.current = requestAnimationFrame(() => {
        dabRafRef.current = null;
        flushPendingDabs();
      });
    }
  };

  const endStroke = (e: React.PointerEvent) => {
    const st = strokeRef.current;
    if (!st || !st.active) return;

    if (dabRafRef.current !== null) {
      cancelAnimationFrame(dabRafRef.current);
      dabRafRef.current = null;
    }
    flushPendingDabs();

    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // Ignore
    }
    strokeRef.current = null;
    updateCursorDom(e.clientX, e.clientY, null);

    if (activeTool === 'object-remover') {
      onObjectMaskPainted();
      return;
    }

    if (st.dirtyRect && st.beforeFullSnapshot) {
      const { x, y, width, height } = st.dirtyRect;
      const beforeCtx = st.beforeFullSnapshot.getContext('2d', { willReadFrequently: true });
      const targetCanvas =
        activeTool === 'eraser' || activeTool === 'background'
          ? buffers.alphaCanvas
          : buffers.retouchCanvas;
      const afterCtx = targetCanvas.getContext('2d', { willReadFrequently: true });

      if (beforeCtx && afterCtx && width > 0 && height > 0) {
        const beforeImg = beforeCtx.getImageData(x, y, width, height);
        const afterImg = afterCtx.getImageData(x, y, width, height);
        const isAlphaTool = activeTool === 'eraser' || activeTool === 'background';
        const maxBufDim = Math.max(1, buffers.width, buffers.height);
        let retouchOp: RetouchOperation | undefined;

        if (activeTool === 'healing' && st.recordedPoints.length > 0) {
          retouchOp = {
            id: `retouch-heal-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            kind: 'healing',
            points: st.recordedPoints,
            radiusNorm: brushConfig.healingSize / 2 / maxBufDim,
            softnessPct: brushConfig.healingSoftness,
          };
        } else if (activeTool === 'clone' && st.cloneDelta && st.recordedPoints.length > 0) {
          retouchOp = {
            id: `retouch-clone-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            kind: 'clone',
            points: st.recordedPoints,
            deltaNx: st.cloneDelta.dx / Math.max(1, buffers.width),
            deltaNy: st.cloneDelta.dy / Math.max(1, buffers.height),
            radiusNorm: brushConfig.cloneSize / 2 / maxBufDim,
            hardnessPct: brushConfig.cloneHardness,
            opacityPct: brushConfig.cloneOpacity,
          };
        }

        onCommitDirtyPatch(
          isAlphaTool ? 'alpha' : 'rgb',
          st.dirtyRect,
          beforeImg,
          afterImg,
          retouchOp
        );
      }
    }
  };

  const cursorDiameter = Math.max(8, currentBrushRadius * 2 * liveBrushScale);

  // Initial / resting display position of Clone Stamp source crosshair
  let cloneCrosshairNorm: { nx: number; ny: number } | null = null;
  if (activeTool === 'clone' && cloneSource) {
    cloneCrosshairNorm = retouchToDisplayNormalized(
      cloneSource.x,
      cloneSource.y,
      transform,
      buffers.width,
      buffers.height,
      true
    );
  }

  return (
    <div
      ref={containerRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endStroke}
      onPointerCancel={endStroke}
      onPointerLeave={hideCursorDom}
      className={`absolute inset-0 z-20 select-none touch-none ${
        activeTool === 'clone' && isPickingCloneSource ? 'cursor-crosshair' : 'cursor-none'
      }`}
    >
      {/* Object Selection or Alpha Mask Preview Overlay */}
      <canvas
        ref={maskPreviewCanvasRef}
        className="pointer-events-none absolute inset-0 h-full w-full block"
      />

      {/* Clone Stamp Source Crosshair */}
      {cloneCrosshairNorm && (
        <div
          ref={cloneCrosshairRef}
          className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2"
          style={{
            display:
              cloneCrosshairNorm.nx >= 0 &&
              cloneCrosshairNorm.nx <= 1 &&
              cloneCrosshairNorm.ny >= 0 &&
              cloneCrosshairNorm.ny <= 1
                ? 'block'
                : 'none',
            left: `${cloneCrosshairNorm.nx * 100}%`,
            top: `${cloneCrosshairNorm.ny * 100}%`,
          }}
        >
          <div className="relative h-6 w-6">
            <div className="absolute left-1/2 top-0 bottom-0 w-[1.5px] -translate-x-1/2 bg-white shadow-[0_0_2px_rgba(0,0,0,0.9)]" />
            <div className="absolute top-1/2 left-0 right-0 h-[1.5px] -translate-y-1/2 bg-white shadow-[0_0_2px_rgba(0,0,0,0.9)]" />
            <div className="absolute inset-1 rounded-full border border-black/70" />
          </div>
        </div>
      )}

      {/* Live Brush Ring Cursor (DOM-driven zero re-render positioning) */}
      <div
        ref={cursorRingRef}
        className="pointer-events-none absolute left-0 top-0 rounded-full border border-white shadow-[0_0_0_1px_rgba(0,0,0,0.65)]"
        style={{
          display: 'none',
          width: `${cursorDiameter}px`,
          height: `${cursorDiameter}px`,
          backgroundColor:
            activeTool === 'object-remover' ? 'rgba(239, 68, 68, 0.16)' : 'transparent',
        }}
      />
    </div>
  );
};

export const RetouchCanvasOverlay = memo(RetouchCanvasOverlayComponent);
