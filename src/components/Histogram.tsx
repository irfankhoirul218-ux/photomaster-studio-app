import React, { memo, useMemo } from 'react';
import { HistogramData } from '../types/editor';

interface HistogramProps {
  data: HistogramData | null;
}

function buildAreaPath(bins: number[], width: number, height: number): string {
  if (!bins.length) return '';
  const stepX = width / (bins.length - 1);
  let d = `M 0 ${height}`;
  for (let i = 0; i < bins.length; i++) {
    const x = i * stepX;
    const y = height - Math.max(0, Math.min(1, bins[i])) * (height - 4);
    d += ` L ${x.toFixed(1)} ${y.toFixed(1)}`;
  }
  d += ` L ${width} ${height} Z`;
  return d;
}

const HistogramComponent: React.FC<HistogramProps> = ({ data }) => {
  const width = 280;
  const height = 76;

  const paths = useMemo(() => {
    if (!data) return null;
    return {
      r: buildAreaPath(data.r, width, height),
      g: buildAreaPath(data.g, width, height),
      b: buildAreaPath(data.b, width, height),
      l: buildAreaPath(data.l, width, height),
    };
  }, [data]);

  return (
    <div className="rounded-lg border border-white/[0.07] bg-[#0a0a0c] p-2.5">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[11px] font-medium text-zinc-400 tracking-wide">Histogram</span>
        <span className="text-[10px] font-mono-tabular text-zinc-500">RGB · Luma</span>
      </div>
      <div className="relative h-[76px] w-full overflow-hidden rounded bg-[#070709]">
        {/* Subtle tonal zone dividers (Blacks, Shadows, Midtones, Highlights, Whites) */}
        <div className="pointer-events-none absolute inset-0 grid grid-cols-4">
          <div className="border-r border-white/[0.05]" />
          <div className="border-r border-white/[0.05]" />
          <div className="border-r border-white/[0.05]" />
          <div />
        </div>

        {paths ? (
          <svg
            viewBox={`0 0 ${width} ${height}`}
            preserveAspectRatio="none"
            className="h-full w-full"
            aria-label="Color and luminance histogram"
          >
            <path d={paths.r} fill="rgba(239, 68, 68, 0.28)" />
            <path d={paths.g} fill="rgba(34, 197, 94, 0.26)" />
            <path d={paths.b} fill="rgba(59, 130, 246, 0.30)" />
            <path
              d={paths.l}
              fill="rgba(250, 250, 250, 0.16)"
              stroke="rgba(255, 255, 255, 0.55)"
              strokeWidth="1"
            />
          </svg>
        ) : (
          <div className="flex h-full items-center justify-center text-[11px] text-zinc-600">
            No image loaded
          </div>
        )}
      </div>
    </div>
  );
};

export const Histogram = memo(HistogramComponent);
