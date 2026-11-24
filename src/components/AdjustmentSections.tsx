import React, { memo, useState } from 'react';
import { ChevronDown, RotateCcw } from 'lucide-react';
import {
  Adjustments,
  ColorGradingState,
  DEFAULT_COLOR_GRADING,
  DEFAULT_HSL_MIXER,
  DEFAULT_TONE_CURVE,
  EditSubSection,
  HslMixerState,
  ToneCurveChannels,
  TransformState,
  WhiteBalanceMode,
} from '../types/editor';
import { hasActiveToneCurve } from '../engine/toneCurve';
import { hasNonZeroColorGrading, hasNonZeroHsl } from '../engine/imageProcessor';
import { ColorGradingWheels, HslMixerControl } from './ColorGradingWheels';
import { StudioSlider } from './StudioSlider';
import { ToneCurveEditor } from './ToneCurveEditor';

interface AdjustmentGroupProps {
  title: string;
  defaultOpen?: boolean;
  hasChanges?: boolean;
  onResetGroup?: () => void;
  children: React.ReactNode;
}

const AdjustmentGroup: React.FC<AdjustmentGroupProps> = ({
  title,
  defaultOpen = true,
  hasChanges = false,
  onResetGroup,
  children,
}) => {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="border-b border-white/[0.07] pb-3 pt-2">
      <div className="flex items-center justify-between mb-1.5">
        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          className="flex items-center gap-1.5 text-xs font-semibold text-zinc-100 hover:text-white py-1"
        >
          <ChevronDown
            className={`w-3.5 h-3.5 text-zinc-400 transition-transform duration-150 ${
              open ? 'rotate-0' : '-rotate-90'
            }`}
          />
          <span>{title}</span>
        </button>
        {hasChanges && onResetGroup && (
          <button
            type="button"
            onClick={onResetGroup}
            title={`Reset ${title}`}
            className="flex items-center gap-1 text-[11px] text-zinc-400 hover:text-white px-1.5 py-0.5 rounded hover:bg-white/[0.06] transition-colors"
          >
            <RotateCcw className="w-3 h-3" />
            <span>Reset</span>
          </button>
        )}
      </div>
      {open && <div className="space-y-0.5">{children}</div>}
    </div>
  );
};

const WB_PRESETS: { id: WhiteBalanceMode; label: string; temp: number; tint: number }[] = [
  { id: 'as-shot', label: 'As Shot', temp: 0, tint: 0 },
  { id: 'daylight', label: 'Daylight', temp: 4, tint: 2 },
  { id: 'cloudy', label: 'Cloudy', temp: 18, tint: 4 },
  { id: 'shade', label: 'Shade', temp: 28, tint: 6 },
  { id: 'tungsten', label: 'Tungsten', temp: -34, tint: -4 },
  { id: 'fluorescent', label: 'Fluor.', temp: -14, tint: 22 },
];

interface AdjustmentControlsProps {
  adjustments: Adjustments;
  transform: TransformState;
  onChange: (key: keyof Adjustments, value: number) => void;
  onChangeAdjustmentsPatch: (patch: Partial<Adjustments>, commit?: boolean) => void;
  onChangeTransformOptics: (
    patch: Partial<
      Pick<
        TransformState,
        'lensDistortion' | 'chromaticAberration' | 'perspectiveV' | 'perspectiveH'
      >
    >,
    commit?: boolean
  ) => void;
  onCommit: () => void;
  onResetKeys: (keys: (keyof Adjustments)[]) => void;
  section?: 'all' | EditSubSection;
}

const AdjustmentControlsComponent: React.FC<AdjustmentControlsProps> = ({
  adjustments,
  transform,
  onChange,
  onChangeAdjustmentsPatch,
  onChangeTransformOptics,
  onCommit,
  onResetKeys,
  section = 'all',
}) => {
  const [subGroup, setSubGroup] = useState<'core' | 'curve' | 'hsl' | 'grading'>('core');

  const lightChanged =
    adjustments.exposure !== 0 ||
    adjustments.brightness !== 0 ||
    adjustments.contrast !== 0 ||
    adjustments.highlights !== 0 ||
    adjustments.shadows !== 0 ||
    adjustments.whites !== 0 ||
    adjustments.blacks !== 0 ||
    hasActiveToneCurve(adjustments.toneCurve);

  const colorChanged =
    adjustments.whiteBalance !== 'as-shot' ||
    adjustments.temperature !== 0 ||
    adjustments.tint !== 0 ||
    adjustments.saturation !== 0 ||
    adjustments.vibrance !== 0 ||
    hasNonZeroHsl(adjustments) ||
    hasNonZeroColorGrading(adjustments);

  const detailChanged =
    adjustments.texture !== 0 ||
    adjustments.clarity !== 0 ||
    adjustments.dehaze !== 0 ||
    adjustments.sharpness !== 0 ||
    adjustments.luminanceNR !== 0 ||
    adjustments.colorNR !== 0 ||
    adjustments.vignette !== 0 ||
    adjustments.grain !== 0;

  const opticsChanged =
    transform.lensDistortion !== 0 ||
    transform.chromaticAberration !== 0 ||
    transform.perspectiveV !== 0 ||
    transform.perspectiveH !== 0;

  const renderLight = () => (
    <div className="space-y-1">
      <StudioSlider
        label="Exposure"
        value={adjustments.exposure}
        onChange={(v) => onChange('exposure', v)}
        onCommit={onCommit}
      />
      <StudioSlider
        label="Brightness"
        value={adjustments.brightness}
        onChange={(v) => onChange('brightness', v)}
        onCommit={onCommit}
      />
      <StudioSlider
        label="Contrast"
        value={adjustments.contrast}
        onChange={(v) => onChange('contrast', v)}
        onCommit={onCommit}
      />
      <StudioSlider
        label="Highlights"
        value={adjustments.highlights}
        onChange={(v) => onChange('highlights', v)}
        onCommit={onCommit}
      />
      <StudioSlider
        label="Shadows"
        value={adjustments.shadows}
        onChange={(v) => onChange('shadows', v)}
        onCommit={onCommit}
      />
      <StudioSlider
        label="Whites"
        value={adjustments.whites}
        onChange={(v) => onChange('whites', v)}
        onCommit={onCommit}
      />
      <StudioSlider
        label="Blacks"
        value={adjustments.blacks}
        onChange={(v) => onChange('blacks', v)}
        onCommit={onCommit}
      />

      <div className="pt-2 border-t border-white/[0.06]">
        <div className="text-[11px] font-semibold text-zinc-300 mb-1">
          Tone Curve (RGB Channels)
        </div>
        <ToneCurveEditor
          toneCurve={adjustments.toneCurve ?? DEFAULT_TONE_CURVE}
          onChange={(nextCurve: ToneCurveChannels) =>
            onChangeAdjustmentsPatch({ toneCurve: nextCurve }, false)
          }
          onCommit={onCommit}
        />
      </div>
    </div>
  );

  const renderColor = () => (
    <div className="space-y-2">
      {/* Sub-mode switcher for cleaner Color density */}
      <div className="grid grid-cols-3 gap-1 p-1 rounded-lg bg-zinc-950 border border-white/[0.06]">
        <button
          type="button"
          onClick={() => setSubGroup('core')}
          className={`rounded py-1 text-[11px] font-medium transition-colors ${
            subGroup !== 'hsl' && subGroup !== 'grading'
              ? 'bg-zinc-800 text-white'
              : 'text-zinc-400 hover:text-zinc-200'
          }`}
        >
          WB & Tone
        </button>
        <button
          type="button"
          onClick={() => setSubGroup('hsl')}
          className={`rounded py-1 text-[11px] font-medium transition-colors ${
            subGroup === 'hsl'
              ? 'bg-zinc-800 text-white'
              : 'text-zinc-400 hover:text-zinc-200'
          }`}
        >
          HSL Mixer{hasNonZeroHsl(adjustments) ? ' ·' : ''}
        </button>
        <button
          type="button"
          onClick={() => setSubGroup('grading')}
          className={`rounded py-1 text-[11px] font-medium transition-colors ${
            subGroup === 'grading'
              ? 'bg-zinc-800 text-white'
              : 'text-zinc-400 hover:text-zinc-200'
          }`}
        >
          Grading{hasNonZeroColorGrading(adjustments) ? ' ·' : ''}
        </button>
      </div>

      {subGroup === 'hsl' ? (
        <HslMixerControl
          hsl={adjustments.hsl ?? DEFAULT_HSL_MIXER}
          onChange={(nextHsl: HslMixerState) =>
            onChangeAdjustmentsPatch({ hsl: nextHsl }, false)
          }
          onCommit={onCommit}
        />
      ) : subGroup === 'grading' ? (
        <ColorGradingWheels
          grading={adjustments.colorGrading ?? DEFAULT_COLOR_GRADING}
          onChange={(nextGrading: ColorGradingState) =>
            onChangeAdjustmentsPatch({ colorGrading: nextGrading }, false)
          }
          onCommit={onCommit}
        />
      ) : (
        <div className="space-y-1">
          {/* White Balance Presets */}
          <div>
            <span className="block text-[11px] font-medium text-zinc-400 mb-1">
              White Balance
            </span>
            <div className="grid grid-cols-3 gap-1">
              {WB_PRESETS.map((wb) => {
                const active = adjustments.whiteBalance === wb.id;
                return (
                  <button
                    key={wb.id}
                    type="button"
                    onClick={() =>
                      onChangeAdjustmentsPatch(
                        { whiteBalance: wb.id, temperature: wb.temp, tint: wb.tint },
                        true
                      )
                    }
                    className={`rounded border py-1 text-[10px] font-medium transition-colors ${
                      active
                        ? 'border-white bg-white text-zinc-950 font-semibold'
                        : 'border-white/[0.08] bg-[#16161a] text-zinc-300 hover:border-white/25 hover:text-white'
                    }`}
                  >
                    {wb.label}
                  </button>
                );
              })}
            </div>
          </div>

          <StudioSlider
            label="Temperature"
            value={adjustments.temperature}
            gradientTrack="linear-gradient(to right, #3b82f6, #52525b 50%, #f59e0b)"
            onChange={(v) =>
              onChangeAdjustmentsPatch({ whiteBalance: 'custom', temperature: v }, false)
            }
            onCommit={onCommit}
          />
          <StudioSlider
            label="Tint"
            value={adjustments.tint}
            gradientTrack="linear-gradient(to right, #22c55e, #52525b 50%, #d946ef)"
            onChange={(v) =>
              onChangeAdjustmentsPatch({ whiteBalance: 'custom', tint: v }, false)
            }
            onCommit={onCommit}
          />
          <StudioSlider
            label="Vibrance"
            value={adjustments.vibrance}
            onChange={(v) => onChange('vibrance', v)}
            onCommit={onCommit}
          />
          <StudioSlider
            label="Saturation"
            value={adjustments.saturation}
            gradientTrack="linear-gradient(to right, #52525b, #a1a1aa 50%, #f4f4f5)"
            onChange={(v) => onChange('saturation', v)}
            onCommit={onCommit}
          />
        </div>
      )}
    </div>
  );

  const renderDetail = () => (
    <div className="space-y-0.5">
      <StudioSlider
        label="Texture"
        value={adjustments.texture}
        onChange={(v) => onChange('texture', v)}
        onCommit={onCommit}
      />
      <StudioSlider
        label="Clarity"
        value={adjustments.clarity}
        onChange={(v) => onChange('clarity', v)}
        onCommit={onCommit}
      />
      <StudioSlider
        label="Dehaze"
        value={adjustments.dehaze}
        onChange={(v) => onChange('dehaze', v)}
        onCommit={onCommit}
      />
      <StudioSlider
        label="Sharpening"
        value={adjustments.sharpness}
        min={0}
        max={100}
        onChange={(v) => onChange('sharpness', v)}
        onCommit={onCommit}
      />
      <StudioSlider
        label="Luminance NR"
        value={adjustments.luminanceNR}
        min={0}
        max={100}
        onChange={(v) => onChange('luminanceNR', v)}
        onCommit={onCommit}
      />
      <StudioSlider
        label="Color NR"
        value={adjustments.colorNR}
        min={0}
        max={100}
        onChange={(v) => onChange('colorNR', v)}
        onCommit={onCommit}
      />
      <div className="pt-1 border-t border-white/[0.06]">
        <StudioSlider
          label="Vignette"
          value={adjustments.vignette}
          onChange={(v) => onChange('vignette', v)}
          onCommit={onCommit}
        />
        <StudioSlider
          label="Grain"
          value={adjustments.grain}
          min={0}
          max={100}
          onChange={(v) => onChange('grain', v)}
          onCommit={onCommit}
        />
      </div>
    </div>
  );

  const renderOptics = () => (
    <div className="space-y-0.5">
      <StudioSlider
        label="Lens Distortion"
        value={transform.lensDistortion}
        min={-100}
        max={100}
        onChange={(v) => onChangeTransformOptics({ lensDistortion: v }, false)}
        onCommit={onCommit}
        onReset={() => onChangeTransformOptics({ lensDistortion: 0 }, true)}
      />
      <StudioSlider
        label="Chromatic Aberration"
        value={transform.chromaticAberration}
        min={0}
        max={100}
        onChange={(v) => onChangeTransformOptics({ chromaticAberration: v }, false)}
        onCommit={onCommit}
        onReset={() => onChangeTransformOptics({ chromaticAberration: 0 }, true)}
      />
      <StudioSlider
        label="Vertical Transform"
        value={transform.perspectiveV}
        min={-100}
        max={100}
        onChange={(v) => onChangeTransformOptics({ perspectiveV: v }, false)}
        onCommit={onCommit}
        onReset={() => onChangeTransformOptics({ perspectiveV: 0 }, true)}
      />
      <StudioSlider
        label="Horizontal Transform"
        value={transform.perspectiveH}
        min={-100}
        max={100}
        onChange={(v) => onChangeTransformOptics({ perspectiveH: v }, false)}
        onCommit={onCommit}
        onReset={() => onChangeTransformOptics({ perspectiveH: 0 }, true)}
      />
    </div>
  );

  if (section === 'light') return renderLight();
  if (section === 'color') return renderColor();
  if (section === 'detail') return renderDetail();
  if (section === 'optics') return renderOptics();

  return (
    <div>
      <AdjustmentGroup
        title="Light & Tone Curve"
        defaultOpen
        hasChanges={lightChanged}
        onResetGroup={() =>
          onResetKeys([
            'exposure',
            'brightness',
            'contrast',
            'highlights',
            'shadows',
            'whites',
            'blacks',
            'toneCurve',
          ])
        }
      >
        {renderLight()}
      </AdjustmentGroup>

      <AdjustmentGroup
        title="Color, HSL & Grading"
        defaultOpen
        hasChanges={colorChanged}
        onResetGroup={() =>
          onResetKeys([
            'whiteBalance',
            'temperature',
            'tint',
            'saturation',
            'vibrance',
            'hsl',
            'colorGrading',
          ])
        }
      >
        {renderColor()}
      </AdjustmentGroup>

      <AdjustmentGroup
        title="Detail & Effects"
        defaultOpen={false}
        hasChanges={detailChanged}
        onResetGroup={() =>
          onResetKeys([
            'texture',
            'clarity',
            'dehaze',
            'sharpness',
            'luminanceNR',
            'colorNR',
            'vignette',
            'grain',
          ])
        }
      >
        {renderDetail()}
      </AdjustmentGroup>

      <AdjustmentGroup
        title="Optics & Perspective"
        defaultOpen={false}
        hasChanges={opticsChanged}
        onResetGroup={() =>
          onChangeTransformOptics(
            {
              lensDistortion: 0,
              chromaticAberration: 0,
              perspectiveV: 0,
              perspectiveH: 0,
            },
            true
          )
        }
      >
        {renderOptics()}
      </AdjustmentGroup>
    </div>
  );
};

export const AdjustmentControls = memo(AdjustmentControlsComponent);
