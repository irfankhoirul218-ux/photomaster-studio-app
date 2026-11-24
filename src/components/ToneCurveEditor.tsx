import React, { useMemo, useRef, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { buildCurveLUT, isIdentityCurve } from '../engine/toneCurve';
import { CurvePoint, DEFAULT_TONE_CURVE, ToneCurveChannels } from '../types/editor';

type CurveChannelKey = keyof ToneCurveChannels;

interface ToneCurveEditorProps {
  toneCurve: ToneCurveChannels;
  onChange: (next: ToneCurveChannels) => void;
  onCommit: () => void;
}

const CHANNELS: { key: CurveChannelKey; label: string; color: string }[] = [
  { key: 'rgb', label: 'RGB', color: '#ffffff' },
  { key: 'red', label: 'Red', color: '#ef4444' },
  { key: 'green', label: 'Green', color: '#22c55e' },
  { key: 'blue', label: 'Blue', color: '#3b82f6' },
];

export const ToneCurveEditor: React.FC<ToneCurveEditorProps> = ({
  toneCurve,
  onChange,
  onCommit,
}) => {
  const [channel, setChannel] = useState<CurveChannelKey>('rgb');
  const [draggingIdx, setDraggingIdx] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const safeCurve = toneCurve ?? DEFAULT_TONE_CURVE;
  const points = (safeCurve[channel] ?? DEFAULT_TONE_CURVE[channel])
    .slice()
    .sort((a, b) => a.x - b.x);

  const activeColor = CHANNELS.find((c) => c.key === channel)?.color ?? '#ffffff';

  const svgPath = useMemo(() => {
    const lut = buildCurveLUT(points);
    const cmds: string[] = [];
    for (let x = 0; x < 256; x += 2) {
      const sy = 255 - lut[x] * 255;
      cmds.push(`${x === 0 ? 'M' : 'L'}${x},${sy.toFixed(1)}`);
    }
    const lastY = 255 - lut[255] * 255;
    cmds.push(`L255,${lastY.toFixed(1)}`);
    return cmds.join(' ');
  }, [points]);

  const clientToCurve = (clientX: number, clientY: number): CurvePoint => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return { x: 128, y: 128 };
    const nx = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
    const ny = Math.max(0, Math.min(1, (clientY - rect.top) / Math.max(1, rect.height)));
    return {
      x: Math.round(nx * 255),
      y: Math.round((1 - ny) * 255),
    };
  };

  const updateChannelPoints = (nextPts: CurvePoint[]) => {
    onChange({
      ...safeCurve,
      [channel]: nextPts.slice().sort((a, b) => a.x - b.x),
    });
  };

  const handleSvgPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    e.preventDefault();
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);

    const pt = clientToCurve(e.clientX, e.clientY);
    // Check if user tapped near an existing point (within 16px in 255-space)
    let hitIdx = -1;
    let bestDist = 20;
    points.forEach((p, idx) => {
      const d = Math.hypot(p.x - pt.x, p.y - pt.y);
      if (d < bestDist) {
        bestDist = d;
        hitIdx = idx;
      }
    });

    if (hitIdx >= 0) {
      setDraggingIdx(hitIdx);
      return;
    }

    // Add new point if fewer than 10 points
    if (points.length < 10) {
      const clampedX = Math.max(4, Math.min(251, pt.x));
      const next = [...points, { x: clampedX, y: pt.y }].sort((a, b) => a.x - b.x);
      const insertedIdx = next.findIndex((p) => p.x === clampedX && p.y === pt.y);
      updateChannelPoints(next);
      setDraggingIdx(insertedIdx >= 0 ? insertedIdx : null);
    }
  };

  const handleSvgPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (draggingIdx === null || draggingIdx < 0 || draggingIdx >= points.length) return;
    const pt = clientToCurve(e.clientX, e.clientY);
    const next = points.map((p) => ({ ...p }));

    const isFirst = draggingIdx === 0;
    const isLast = draggingIdx === points.length - 1;
    if (isFirst) {
      next[draggingIdx] = {
        x: Math.max(0, Math.min(next[1].x - 6, pt.x)),
        y: pt.y,
      };
    } else if (isLast) {
      next[draggingIdx] = {
        x: Math.min(255, Math.max(next[draggingIdx - 1].x + 6, pt.x)),
        y: pt.y,
      };
    } else {
      const minX = next[draggingIdx - 1].x + 6;
      const maxX = next[draggingIdx + 1].x - 6;
      next[draggingIdx] = {
        x: Math.max(minX, Math.min(maxX, pt.x)),
        y: pt.y,
      };
    }
    updateChannelPoints(next);
  };

  const handleSvgPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    if (draggingIdx !== null) {
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
      setDraggingIdx(null);
      onCommit();
    }
  };

  const removePoint = (idx: number) => {
    if (points.length <= 2 || idx === 0 || idx === points.length - 1) return;
    const next = points.filter((_, i) => i !== idx);
    updateChannelPoints(next);
    onCommit();
  };

  const handleResetChannel = () => {
    updateChannelPoints([
      { x: 0, y: 0 },
      { x: 255, y: 255 },
    ]);
    onCommit();
  };

  const isModified = !isIdentityCurve(points);

  return (
    <div className="space-y-2 py-1.5">
      <div className="flex items-center justify-between gap-2">
        <div className="grid grid-cols-4 gap-1 p-0.5 rounded-md bg-zinc-950 border border-white/[0.08]">
          {CHANNELS.map((c) => {
            const active = channel === c.key;
            const changed = !isIdentityCurve(safeCurve[c.key]);
            return (
              <button
                key={c.key}
                type="button"
                onClick={() => setChannel(c.key)}
                className={`relative px-2 py-1 text-[10px] font-medium rounded transition-colors ${
                  active ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <span style={{ color: active ? c.color : undefined }}>{c.label}</span>
                {changed && !active && (
                  <span
                    className="inline-block ml-1 h-1 w-1 rounded-full align-middle"
                    style={{ backgroundColor: c.color }}
                  />
                )}
              </button>
            );
          })}
        </div>

        {isModified && (
          <button
            type="button"
            onClick={handleResetChannel}
            title="Reset curve channel"
            className="flex items-center gap-1 text-[11px] text-zinc-400 hover:text-white px-1.5 py-0.5 rounded hover:bg-white/[0.06]"
          >
            <RotateCcw className="w-3 h-3" />
            <span>Reset</span>
          </button>
        )}
      </div>

      {/* Interactive SVG Curve Grid */}
      <div className="relative rounded-lg border border-white/[0.08] bg-[#0b0b0e] p-2">
        <svg
          ref={svgRef}
          viewBox="0 0 255 255"
          onPointerDown={handleSvgPointerDown}
          onPointerMove={handleSvgPointerMove}
          onPointerUp={handleSvgPointerUp}
          onPointerCancel={handleSvgPointerUp}
          className="w-full h-36 touch-none cursor-crosshair select-none overflow-visible"
        >
          {/* Quarter grid */}
          {[64, 128, 192].map((g) => (
            <React.Fragment key={g}>
              <line x1={g} y1={0} x2={g} y2={255} stroke="rgba(255,255,255,0.06)" strokeWidth="1" />
              <line x1={0} y1={g} x2={255} y2={g} stroke="rgba(255,255,255,0.06)" strokeWidth="1" />
            </React.Fragment>
          ))}
          {/* Identity diagonal */}
          <line
            x1={0}
            y1={255}
            x2={255}
            y2={0}
            stroke="rgba(255,255,255,0.16)"
            strokeWidth="1"
            strokeDasharray="3 3"
          />

          {/* Spline path */}
          <path d={svgPath} fill="none" stroke={activeColor} strokeWidth="2.2" />

          {/* Control handles */}
          {points.map((p, idx) => (
            <circle
              key={idx}
              cx={p.x}
              cy={255 - p.y}
              r={draggingIdx === idx ? 7.5 : 6}
              fill={draggingIdx === idx ? activeColor : '#09090b'}
              stroke={activeColor}
              strokeWidth="2"
              onDoubleClick={(e) => {
                e.stopPropagation();
                removePoint(idx);
              }}
              className="cursor-grab active:cursor-grabbing"
            />
          ))}
        </svg>
        <p className="mt-1 text-[10px] text-zinc-500 text-center">
          Click/drag to shape tone · Double-click intermediate dot to remove
        </p>
      </div>
    </div>
  );
};
