import React, { useRef, useState } from 'react';
import { MoveHorizontal } from 'lucide-react';

interface CompareOverlayProps {
  originalCanvasRef: React.RefObject<HTMLCanvasElement | null>;
  splitPosition: number; // 0..100
  onSplitChange: (pos: number) => void;
}

export const CompareOverlay: React.FC<CompareOverlayProps> = ({
  originalCanvasRef,
  splitPosition,
  onSplitChange,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);

  const updateFromClientX = (clientX: number) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    if (rect.width <= 0) return;
    const pct = Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100));
    onSplitChange(pct);
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDragging(true);
    updateFromClientX(e.clientX);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!dragging) return;
    updateFromClientX(e.clientX);
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (!dragging) return;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // Ignore
    }
    setDragging(false);
  };

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 z-10 select-none touch-none"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      {/* Original canvas clipped to left side of split */}
      <canvas
        ref={originalCanvasRef}
        className="pointer-events-none absolute inset-0 h-full w-full block"
        style={{
          clipPath: `inset(0 ${(100 - splitPosition).toFixed(2)}% 0 0)`,
        }}
      />

      {/* Before / After corner labels */}
      <span className="pointer-events-none absolute top-3 left-3 rounded bg-black/75 px-2 py-0.5 text-[11px] font-medium text-zinc-200 backdrop-blur-sm border border-white/10">
        Before
      </span>
      <span className="pointer-events-none absolute top-3 right-3 rounded bg-black/75 px-2 py-0.5 text-[11px] font-medium text-white backdrop-blur-sm border border-white/15">
        After
      </span>

      {/* Divider line and handle */}
      <div
        className="pointer-events-none absolute top-0 bottom-0 w-[1.5px] bg-white shadow-[0_0_8px_rgba(0,0,0,0.8)]"
        style={{ left: `${splitPosition}%` }}
      >
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 flex h-9 w-9 items-center justify-center rounded-full border border-white/40 bg-zinc-950/90 text-white shadow-xl backdrop-blur-md">
          <MoveHorizontal className="w-4 h-4" />
        </div>
      </div>
    </div>
  );
};
