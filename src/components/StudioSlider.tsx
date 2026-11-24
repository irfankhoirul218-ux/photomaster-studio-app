import React, { memo } from 'react';

interface StudioSliderProps {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  gradientTrack?: string;
  onChange: (value: number) => void;
  onCommit?: () => void;
  onReset?: () => void;
}

const StudioSliderComponent: React.FC<StudioSliderProps> = ({
  label,
  value,
  min = -100,
  max = 100,
  step = 1,
  unit = '',
  gradientTrack,
  onChange,
  onCommit,
  onReset,
}) => {
  const isBipolar = min < 0 && max > 0;
  const pct = ((value - min) / (max - min)) * 100;
  const zeroPct = isBipolar ? ((0 - min) / (max - min)) * 100 : 0;

  const fillLeft = isBipolar ? Math.min(pct, zeroPct) : 0;
  const fillWidth = isBipolar ? Math.abs(pct - zeroPct) : pct;

  const formattedValue =
    isBipolar && value > 0 ? `+${value}${unit}` : `${value}${unit}`;

  const handleReset = () => {
    if (onReset) {
      onReset();
    } else {
      onChange(0);
      onCommit?.();
    }
  };

  return (
    <div className="group py-1 select-none">
      <div className="flex items-center justify-between mb-1">
        <button
          type="button"
          onDoubleClick={handleReset}
          onClick={() => {
            // Double click resets; single click stays non-destructive
          }}
          title="Double-click to reset"
          className="text-xs font-medium text-zinc-300 group-hover:text-white transition-colors text-left cursor-default"
        >
          {label}
        </button>
        <button
          type="button"
          onClick={handleReset}
          title={value !== 0 ? 'Click to reset to 0' : undefined}
          className={`font-mono-tabular text-[11px] px-1.5 py-0.5 rounded transition-colors ${
            value !== 0
              ? 'text-white bg-white/[0.08] hover:bg-white/[0.14]'
              : 'text-zinc-500 hover:text-zinc-300'
          }`}
        >
          {formattedValue}
        </button>
      </div>

      <div className="relative flex items-center h-6">
        {/* Track background */}
        <div
          className="pointer-events-none absolute left-0 right-0 h-[3px] rounded-full overflow-hidden"
          style={{
            background: gradientTrack || 'rgba(255, 255, 255, 0.14)',
          }}
        >
          {!gradientTrack && (
            <div
              className="absolute top-0 bottom-0 bg-white/80"
              style={{
                left: `${fillLeft}%`,
                width: `${fillWidth}%`,
              }}
            />
          )}
        </div>

        {/* Center tick mark for bipolar sliders */}
        {isBipolar && (
          <div
            className="pointer-events-none absolute top-1/2 -translate-y-1/2 w-[1px] h-2.5 bg-zinc-500/70"
            style={{ left: `${zeroPct}%` }}
          />
        )}

        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          aria-label={label}
          onChange={(e) => onChange(Number(e.target.value))}
          onMouseUp={() => onCommit?.()}
          onTouchEnd={() => onCommit?.()}
          onKeyUp={() => onCommit?.()}
          onDoubleClick={handleReset}
          className="studio-slider relative z-10"
        />
      </div>
    </div>
  );
};

export const StudioSlider = memo(StudioSliderComponent);
