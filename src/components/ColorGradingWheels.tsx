import React, { useRef, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import {
  ColorGradingState,
  ColorWheelValue,
  DEFAULT_COLOR_GRADING,
  DEFAULT_HSL_MIXER,
  HslColorKey,
  HslMixerState,
} from '../types/editor';
import { StudioSlider } from './StudioSlider';

// -------- INTERACTIVE 8-BAND HSL MIXER --------

const HSL_BANDS: { key: HslColorKey; label: string; dot: string }[] = [
  { key: 'red', label: 'Red', dot: '#ef4444' },
  { key: 'orange', label: 'Orange', dot: '#f97316' },
  { key: 'yellow', label: 'Yellow', dot: '#eab308' },
  { key: 'green', label: 'Green', dot: '#22c55e' },
  { key: 'aqua', label: 'Aqua', dot: '#06b6d4' },
  { key: 'blue', label: 'Blue', dot: '#3b82f6' },
  { key: 'purple', label: 'Purple', dot: '#a855f7' },
  { key: 'magenta', label: 'Magenta', dot: '#ec4899' },
];

interface HslMixerControlProps {
  hsl: HslMixerState;
  onChange: (next: HslMixerState) => void;
  onCommit: () => void;
}

export const HslMixerControl: React.FC<HslMixerControlProps> = ({ hsl, onChange, onCommit }) => {
  const [attr, setAttr] = useState<'h' | 's' | 'l'>('s');
  const safeHsl = hsl ?? DEFAULT_HSL_MIXER;

  const isModified = HSL_BANDS.some((b) => {
    const v = safeHsl[b.key];
    return v && (v.h !== 0 || v.s !== 0 || v.l !== 0);
  });

  const handleSlider = (key: HslColorKey, val: number) => {
    onChange({
      ...safeHsl,
      [key]: {
        ...(safeHsl[key] ?? { h: 0, s: 0, l: 0 }),
        [attr]: val,
      },
    });
  };

  const handleReset = () => {
    onChange({
      red: { h: 0, s: 0, l: 0 },
      orange: { h: 0, s: 0, l: 0 },
      yellow: { h: 0, s: 0, l: 0 },
      green: { h: 0, s: 0, l: 0 },
      aqua: { h: 0, s: 0, l: 0 },
      blue: { h: 0, s: 0, l: 0 },
      purple: { h: 0, s: 0, l: 0 },
      magenta: { h: 0, s: 0, l: 0 },
    });
    onCommit();
  };

  return (
    <div className="space-y-2 py-1.5">
      <div className="flex items-center justify-between gap-2">
        <div className="grid grid-cols-3 flex-1 gap-1 p-0.5 rounded-md bg-zinc-950 border border-white/[0.08]">
          {(
            [
              { id: 'h', label: 'Hue' },
              { id: 's', label: 'Saturation' },
              { id: 'l', label: 'Luminance' },
            ] as const
          ).map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setAttr(t.id)}
              className={`rounded py-1 text-[11px] font-medium transition-colors ${
                attr === t.id ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        {isModified && (
          <button
            type="button"
            onClick={handleReset}
            className="flex items-center gap-1 text-[11px] text-zinc-400 hover:text-white px-1.5 py-0.5 rounded hover:bg-white/[0.06]"
          >
            <RotateCcw className="w-3 h-3" />
          </button>
        )}
      </div>

      <div className="space-y-0.5">
        {HSL_BANDS.map((band) => {
          const val = safeHsl[band.key]?.[attr] ?? 0;
          return (
            <div key={band.key} className="flex items-center gap-2">
              <span
                className="h-2.5 w-2.5 rounded-full shrink-0 border border-white/20"
                style={{ backgroundColor: band.dot }}
              />
              <div className="flex-1 min-w-0">
                <StudioSlider
                  label={band.label}
                  value={val}
                  min={-100}
                  max={100}
                  onChange={(v) => handleSlider(band.key, v)}
                  onCommit={onCommit}
                  onReset={() => {
                    handleSlider(band.key, 0);
                    onCommit();
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

// -------- INTERACTIVE 3-WAY COLOR GRADING WHEELS --------

interface SingleWheelProps {
  title: string;
  value: ColorWheelValue;
  onChange: (next: ColorWheelValue) => void;
  onCommit: () => void;
}

const SingleColorWheel: React.FC<SingleWheelProps> = ({ title, value, onChange, onCommit }) => {
  const wheelRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  const updateFromClient = (clientX: number, clientY: number) => {
    const el = wheelRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const maxR = Math.max(10, rect.width / 2 - 4);
    const dx = clientX - cx;
    const dy = clientY - cy;
    const dist = Math.min(maxR, Math.hypot(dx, dy));
    // CSS conic-gradient 0deg is at top (12 o'clock), increasing clockwise
    let deg = (Math.atan2(dx, -dy) * 180) / Math.PI;
    if (deg < 0) deg += 360;
    const sat = Math.round((dist / maxR) * 100);
    onChange({
      ...value,
      hue: Math.round(deg),
      sat,
    });
  };

  const rad = ((value.hue - 90) * Math.PI) / 180;
  const rPct = (value.sat / 100) * 44; // % from center
  const dotX = 50 + Math.cos(rad) * rPct;
  const dotY = 50 + Math.sin(rad) * rPct;

  return (
    <div className="space-y-1.5 flex flex-col items-center">
      <div className="flex items-center justify-between w-full px-1">
        <span className="text-[11px] font-medium text-zinc-300">{title}</span>
        {(value.sat > 0 || value.lum !== 0) && (
          <button
            type="button"
            onClick={() => {
              onChange({ hue: 0, sat: 0, lum: 0 });
              onCommit();
            }}
            className="text-[10px] text-zinc-400 hover:text-white"
          >
            Reset
          </button>
        )}
      </div>

      <div
        ref={wheelRef}
        onPointerDown={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          draggingRef.current = true;
          updateFromClient(e.clientX, e.clientY);
        }}
        onPointerMove={(e) => {
          if (!draggingRef.current) return;
          updateFromClient(e.clientX, e.clientY);
        }}
        onPointerUp={(e) => {
          if (!draggingRef.current) return;
          draggingRef.current = false;
          try {
            (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
          } catch {
            // ignore
          }
          onCommit();
        }}
        onDoubleClick={() => {
          onChange({ ...value, hue: 0, sat: 0 });
          onCommit();
        }}
        className="relative h-28 w-28 rounded-full border border-white/15 touch-none cursor-crosshair select-none shadow-inner"
        style={{
          background:
            'radial-gradient(circle, rgba(24,24,27,0.92) 0%, rgba(24,24,27,0.18) 65%, rgba(0,0,0,0.35) 100%), conic-gradient(#ff3b30, #ffcc00, #34c759, #00c7be, #007aff, #af52de, #ff2d55, #ff3b30)',
        }}
      >
        <div className="pointer-events-none absolute left-1/2 top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/40" />
        <div
          className="pointer-events-none absolute h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_4px_rgba(0,0,0,0.9)]"
          style={{
            left: `${dotX}%`,
            top: `${dotY}%`,
            backgroundColor:
              value.sat > 0 ? `hsl(${value.hue}, ${Math.max(40, value.sat)}%, 55%)` : '#27272a',
          }}
        />
      </div>

      <div className="w-full px-1">
        <StudioSlider
          label="Lum"
          value={value.lum}
          min={-100}
          max={100}
          onChange={(v) => onChange({ ...value, lum: v })}
          onCommit={onCommit}
          onReset={() => {
            onChange({ ...value, lum: 0 });
            onCommit();
          }}
        />
      </div>
    </div>
  );
};

interface ColorGradingWheelsProps {
  grading: ColorGradingState;
  onChange: (next: ColorGradingState) => void;
  onCommit: () => void;
}

export const ColorGradingWheels: React.FC<ColorGradingWheelsProps> = ({
  grading,
  onChange,
  onCommit,
}) => {
  const [zone, setZone] = useState<'midtones' | 'shadows' | 'highlights'>('midtones');
  const safe = grading ?? DEFAULT_COLOR_GRADING;

  const isChanged =
    safe.shadows.sat > 0 ||
    safe.shadows.lum !== 0 ||
    safe.midtones.sat > 0 ||
    safe.midtones.lum !== 0 ||
    safe.highlights.sat > 0 ||
    safe.highlights.lum !== 0;

  return (
    <div className="space-y-2 py-1.5">
      <div className="flex items-center justify-between gap-2">
        <div className="grid grid-cols-3 flex-1 gap-1 p-0.5 rounded-md bg-zinc-950 border border-white/[0.08]">
          {(
            [
              { id: 'shadows', label: 'Shadows' },
              { id: 'midtones', label: 'Midtones' },
              { id: 'highlights', label: 'Highlights' },
            ] as const
          ).map((z) => {
            const active = zone === z.id;
            const zVal = safe[z.id];
            const zEdited = zVal.sat > 0 || zVal.lum !== 0;
            return (
              <button
                key={z.id}
                type="button"
                onClick={() => setZone(z.id)}
                className={`rounded py-1 text-[11px] font-medium transition-colors ${
                  active ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {z.label}
                {zEdited && !active ? ' ·' : ''}
              </button>
            );
          })}
        </div>
        {isChanged && (
          <button
            type="button"
            onClick={() => {
              onChange({
                shadows: { hue: 0, sat: 0, lum: 0 },
                midtones: { hue: 0, sat: 0, lum: 0 },
                highlights: { hue: 0, sat: 0, lum: 0 },
                blending: 50,
                balance: 0,
              });
              onCommit();
            }}
            className="flex items-center gap-1 text-[11px] text-zinc-400 hover:text-white px-1.5 py-0.5 rounded hover:bg-white/[0.06]"
          >
            <RotateCcw className="w-3 h-3" />
          </button>
        )}
      </div>

      <SingleColorWheel
        title={zone === 'shadows' ? 'Shadows' : zone === 'midtones' ? 'Midtones' : 'Highlights'}
        value={safe[zone]}
        onChange={(nextZoneVal) => onChange({ ...safe, [zone]: nextZoneVal })}
        onCommit={onCommit}
      />

      <div className="border-t border-white/[0.06] pt-1">
        <StudioSlider
          label="Blending"
          value={safe.blending}
          min={0}
          max={100}
          unit="%"
          onChange={(v) => onChange({ ...safe, blending: v })}
          onCommit={onCommit}
          onReset={() => {
            onChange({ ...safe, blending: 50 });
            onCommit();
          }}
        />
        <StudioSlider
          label="Balance"
          value={safe.balance}
          min={-100}
          max={100}
          onChange={(v) => onChange({ ...safe, balance: v })}
          onCommit={onCommit}
          onReset={() => {
            onChange({ ...safe, balance: 0 });
            onCommit();
          }}
        />
      </div>
    </div>
  );
};
