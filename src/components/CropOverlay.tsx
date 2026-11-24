import React, { useRef, useState } from 'react';
import { AspectRatioOption, CropRect } from '../types/editor';

interface CropOverlayProps {
  crop: CropRect;
  aspectRatio: AspectRatioOption;
  imageWidth: number;
  imageHeight: number;
  onChange: (crop: CropRect) => void;
  onCommit: () => void;
}

type DragHandle = 'move' | 'nw' | 'ne' | 'sw' | 'se' | 'n' | 's' | 'w' | 'e';

export function getTargetAspectRatio(
  option: AspectRatioOption,
  imageWidth: number,
  imageHeight: number
): number | null {
  switch (option) {
    case 'free':
      return null;
    case 'original':
      return imageWidth / Math.max(1, imageHeight);
    case '1:1':
      return 1;
    case '4:3':
      return 4 / 3;
    case '3:2':
      return 3 / 2;
    case '16:9':
      return 16 / 9;
    case '4:5':
      return 4 / 5;
    case '9:16':
      return 9 / 16;
  }
}

export function fitCropToAspect(
  current: CropRect,
  targetAspect: number | null,
  imageWidth: number,
  imageHeight: number
): CropRect {
  if (!targetAspect) return current;
  const imgAspect = imageWidth / Math.max(1, imageHeight);
  // Normalized ratio: (crop.width * imageWidth) / (crop.height * imageHeight) = targetAspect
  // => crop.width / crop.height = targetAspect / imgAspect
  const normRatio = targetAspect / imgAspect;

  let w = current.width;
  let h = w / normRatio;
  if (h > 1) {
    h = 1;
    w = h * normRatio;
  }
  if (w > 1) {
    w = 1;
    h = w / normRatio;
  }

  const cx = current.x + current.width / 2;
  const cy = current.y + current.height / 2;
  const x = Math.max(0, Math.min(1 - w, cx - w / 2));
  const y = Math.max(0, Math.min(1 - h, cy - h / 2));

  return { x, y, width: w, height: h };
}

export const CropOverlay: React.FC<CropOverlayProps> = ({
  crop,
  aspectRatio,
  imageWidth,
  imageHeight,
  onChange,
  onCommit,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [activeHandle, setActiveHandle] = useState<DragHandle | null>(null);
  const dragStartRef = useRef<{
    pointerX: number;
    pointerY: number;
    startCrop: CropRect;
    handle: DragHandle;
  } | null>(null);

  const MIN_SIZE = 0.08;

  const startDrag = (e: React.PointerEvent, handle: DragHandle) => {
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setActiveHandle(handle);
    dragStartRef.current = {
      pointerX: e.clientX,
      pointerY: e.clientY,
      startCrop: { ...crop },
      handle,
    };
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!dragStartRef.current || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const dx = (e.clientX - dragStartRef.current.pointerX) / rect.width;
    const dy = (e.clientY - dragStartRef.current.pointerY) / rect.height;
    const s = dragStartRef.current.startCrop;
    const handle = dragStartRef.current.handle;

    if (handle === 'move') {
      const nx = Math.max(0, Math.min(1 - s.width, s.x + dx));
      const ny = Math.max(0, Math.min(1 - s.height, s.y + dy));
      onChange({ ...s, x: nx, y: ny });
      return;
    }

    let left = s.x;
    let right = s.x + s.width;
    let top = s.y;
    let bottom = s.y + s.height;

    if (handle.includes('w')) left = Math.max(0, Math.min(right - MIN_SIZE, s.x + dx));
    if (handle.includes('e')) right = Math.min(1, Math.max(left + MIN_SIZE, s.x + s.width + dx));
    if (handle.includes('n')) top = Math.max(0, Math.min(bottom - MIN_SIZE, s.y + dy));
    if (handle.includes('s')) bottom = Math.min(1, Math.max(top + MIN_SIZE, s.y + s.height + dy));

    const targetAspect = getTargetAspectRatio(aspectRatio, imageWidth, imageHeight);
    if (targetAspect) {
      const imgAspect = imageWidth / Math.max(1, imageHeight);
      const normRatio = targetAspect / imgAspect;

      let w = right - left;
      let h = bottom - top;

      if (handle === 'n' || handle === 's') {
        w = h * normRatio;
        const centerX = s.x + s.width / 2;
        left = centerX - w / 2;
        right = centerX + w / 2;
        if (left < 0) {
          left = 0;
          right = w;
        }
        if (right > 1) {
          right = 1;
          left = 1 - w;
        }
        if (left < 0 || right > 1) {
          left = Math.max(0, left);
          right = Math.min(1, right);
          w = right - left;
          h = w / normRatio;
          if (handle === 'n') top = bottom - h;
          else bottom = top + h;
        }
      } else {
        h = w / normRatio;
        if (handle === 'w' || handle === 'e') {
          const centerY = s.y + s.height / 2;
          top = centerY - h / 2;
          bottom = centerY + h / 2;
        } else if (handle.includes('n')) {
          top = bottom - h;
        } else {
          bottom = top + h;
        }

        if (top < 0) {
          top = 0;
          bottom = h;
        }
        if (bottom > 1) {
          bottom = 1;
          top = 1 - h;
        }
        if (top < 0 || bottom > 1) {
          top = Math.max(0, top);
          bottom = Math.min(1, bottom);
          h = bottom - top;
          w = h * normRatio;
          if (handle.includes('w')) left = right - w;
          else right = left + w;
        }
      }
    }

    onChange({
      x: Math.max(0, left),
      y: Math.max(0, top),
      width: Math.max(MIN_SIZE, right - left),
      height: Math.max(MIN_SIZE, bottom - top),
    });
  };

  const endDrag = (e: React.PointerEvent) => {
    if (!dragStartRef.current) return;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // Ignore if pointer capture already released
    }
    dragStartRef.current = null;
    setActiveHandle(null);
    onCommit();
  };

  const leftPct = crop.x * 100;
  const topPct = crop.y * 100;
  const widthPct = crop.width * 100;
  const heightPct = crop.height * 100;

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 z-20 select-none touch-none"
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      {/* Dimmed regions outside crop */}
      <div
        className="pointer-events-none absolute bg-black/65"
        style={{ left: 0, top: 0, right: 0, height: `${topPct}%` }}
      />
      <div
        className="pointer-events-none absolute bg-black/65"
        style={{ left: 0, top: `${topPct + heightPct}%`, right: 0, bottom: 0 }}
      />
      <div
        className="pointer-events-none absolute bg-black/65"
        style={{ left: 0, top: `${topPct}%`, width: `${leftPct}%`, height: `${heightPct}%` }}
      />
      <div
        className="pointer-events-none absolute bg-black/65"
        style={{
          left: `${leftPct + widthPct}%`,
          top: `${topPct}%`,
          right: 0,
          height: `${heightPct}%`,
        }}
      />

      {/* Active Crop Frame */}
      <div
        onPointerDown={(e) => startDrag(e, 'move')}
        className="absolute border border-white/90 cursor-move"
        style={{
          left: `${leftPct}%`,
          top: `${topPct}%`,
          width: `${widthPct}%`,
          height: `${heightPct}%`,
        }}
      >
        {/* Rule-of-thirds gridlines */}
        <div className="pointer-events-none absolute inset-0 grid grid-cols-3 grid-rows-3">
          {Array.from({ length: 9 }).map((_, idx) => (
            <div
              key={idx}
              className={`border-white/${activeHandle ? '35' : '20'} ${
                idx % 3 !== 2 ? 'border-r' : ''
              } ${idx < 6 ? 'border-b' : ''}`}
            />
          ))}
        </div>

        {/* Edge drag targets */}
        <div
          onPointerDown={(e) => startDrag(e, 'n')}
          className="absolute -top-2.5 left-4 right-4 h-5 cursor-ns-resize flex items-center justify-center"
        >
          <div className="w-6 h-1 rounded-full bg-white shadow" />
        </div>
        <div
          onPointerDown={(e) => startDrag(e, 's')}
          className="absolute -bottom-2.5 left-4 right-4 h-5 cursor-ns-resize flex items-center justify-center"
        >
          <div className="w-6 h-1 rounded-full bg-white shadow" />
        </div>
        <div
          onPointerDown={(e) => startDrag(e, 'w')}
          className="absolute -left-2.5 top-4 bottom-4 w-5 cursor-ew-resize flex items-center justify-center"
        >
          <div className="h-6 w-1 rounded-full bg-white shadow" />
        </div>
        <div
          onPointerDown={(e) => startDrag(e, 'e')}
          className="absolute -right-2.5 top-4 bottom-4 w-5 cursor-ew-resize flex items-center justify-center"
        >
          <div className="h-6 w-1 rounded-full bg-white shadow" />
        </div>

        {/* Corner L-bracket handles */}
        <div
          onPointerDown={(e) => startDrag(e, 'nw')}
          className="absolute -top-3 -left-3 w-7 h-7 cursor-nwse-resize flex items-center justify-center"
        >
          <div className="w-3.5 h-3.5 border-t-[3px] border-l-[3px] border-white shadow" />
        </div>
        <div
          onPointerDown={(e) => startDrag(e, 'ne')}
          className="absolute -top-3 -right-3 w-7 h-7 cursor-nesw-resize flex items-center justify-center"
        >
          <div className="w-3.5 h-3.5 border-t-[3px] border-r-[3px] border-white shadow" />
        </div>
        <div
          onPointerDown={(e) => startDrag(e, 'sw')}
          className="absolute -bottom-3 -left-3 w-7 h-7 cursor-nesw-resize flex items-center justify-center"
        >
          <div className="w-3.5 h-3.5 border-b-[3px] border-l-[3px] border-white shadow" />
        </div>
        <div
          onPointerDown={(e) => startDrag(e, 'se')}
          className="absolute -bottom-3 -right-3 w-7 h-7 cursor-nwse-resize flex items-center justify-center"
        >
          <div className="w-3.5 h-3.5 border-b-[3px] border-r-[3px] border-white shadow" />
        </div>
      </div>
    </div>
  );
};
