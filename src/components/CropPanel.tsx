import React, { memo } from 'react';
import {
  RotateCcw,
  RotateCw,
  FlipHorizontal2,
  FlipVertical2,
  Check,
  RefreshCcw,
} from 'lucide-react';
import { AspectRatioOption, TransformState } from '../types/editor';
import { StudioSlider } from './StudioSlider';

interface CropPanelProps {
  transform: TransformState;
  onAspectChange: (aspect: AspectRatioOption) => void;
  onRotate90: (dir: 1 | -1) => void;
  onFlip: (axis: 'h' | 'v') => void;
  onStraightenChange: (angle: number) => void;
  onStraightenCommit: () => void;
  onOpticsChange?: (
    patch: Partial<
      Pick<
        TransformState,
        'lensDistortion' | 'chromaticAberration' | 'perspectiveV' | 'perspectiveH'
      >
    >,
    commit?: boolean
  ) => void;
  onResetCrop: () => void;
  onDoneCrop?: () => void;
}

const ASPECT_OPTIONS: { id: AspectRatioOption; label: string }[] = [
  { id: 'free', label: 'Free' },
  { id: 'original', label: 'Original' },
  { id: '1:1', label: '1:1' },
  { id: '4:3', label: '4:3' },
  { id: '3:2', label: '3:2' },
  { id: '16:9', label: '16:9' },
  { id: '4:5', label: '4:5' },
  { id: '9:16', label: '9:16' },
];

const CropPanelComponent: React.FC<CropPanelProps> = ({
  transform,
  onAspectChange,
  onRotate90,
  onFlip,
  onStraightenChange,
  onStraightenCommit,
  onOpticsChange,
  onResetCrop,
  onDoneCrop,
}) => {
  const isModified =
    transform.rotate90 !== 0 ||
    transform.straighten !== 0 ||
    transform.flipH ||
    transform.flipV ||
    transform.lensDistortion !== 0 ||
    transform.chromaticAberration !== 0 ||
    transform.perspectiveV !== 0 ||
    transform.perspectiveH !== 0 ||
    transform.crop.x > 0.001 ||
    transform.crop.y > 0.001 ||
    transform.crop.width < 0.999 ||
    transform.crop.height < 0.999;

  return (
    <div className="space-y-4">
      {/* Rotate & Flip quick actions */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-medium text-zinc-400">Orientation</span>
          {isModified && (
            <button
              type="button"
              onClick={onResetCrop}
              className="flex items-center gap-1 text-[11px] text-zinc-400 hover:text-white px-1.5 py-0.5 rounded hover:bg-white/[0.06] transition-colors"
            >
              <RefreshCcw className="w-3 h-3" />
              <span>Reset All</span>
            </button>
          )}
        </div>
        <div className="grid grid-cols-4 gap-2">
          <button
            type="button"
            onClick={() => onRotate90(-1)}
            title="Rotate 90° Left"
            className="flex flex-col items-center justify-center gap-1 rounded-lg border border-white/[0.08] bg-[#16161a] py-2.5 text-[11px] font-medium text-zinc-300 hover:border-white/25 hover:text-white transition-colors min-h-[44px]"
          >
            <RotateCcw className="w-4 h-4" />
            <span>-90°</span>
          </button>
          <button
            type="button"
            onClick={() => onRotate90(1)}
            title="Rotate 90° Right"
            className="flex flex-col items-center justify-center gap-1 rounded-lg border border-white/[0.08] bg-[#16161a] py-2.5 text-[11px] font-medium text-zinc-300 hover:border-white/25 hover:text-white transition-colors min-h-[44px]"
          >
            <RotateCw className="w-4 h-4" />
            <span>+90°</span>
          </button>
          <button
            type="button"
            onClick={() => onFlip('h')}
            title="Flip Horizontal"
            className={`flex flex-col items-center justify-center gap-1 rounded-lg border py-2.5 text-[11px] font-medium transition-colors min-h-[44px] ${
              transform.flipH
                ? 'border-white bg-white text-zinc-950'
                : 'border-white/[0.08] bg-[#16161a] text-zinc-300 hover:border-white/25 hover:text-white'
            }`}
          >
            <FlipHorizontal2 className="w-4 h-4" />
            <span>Flip H</span>
          </button>
          <button
            type="button"
            onClick={() => onFlip('v')}
            title="Flip Vertical"
            className={`flex flex-col items-center justify-center gap-1 rounded-lg border py-2.5 text-[11px] font-medium transition-colors min-h-[44px] ${
              transform.flipV
                ? 'border-white bg-white text-zinc-950'
                : 'border-white/[0.08] bg-[#16161a] text-zinc-300 hover:border-white/25 hover:text-white'
            }`}
          >
            <FlipVertical2 className="w-4 h-4" />
            <span>Flip V</span>
          </button>
        </div>
      </div>

      {/* Straighten Slider */}
      <div className="border-t border-white/[0.07] pt-3 space-y-0.5">
        <StudioSlider
          label="Straighten"
          value={transform.straighten}
          min={-45}
          max={45}
          step={0.5}
          unit="°"
          onChange={onStraightenChange}
          onCommit={onStraightenCommit}
          onReset={() => {
            onStraightenChange(0);
            onStraightenCommit();
          }}
        />
        {onOpticsChange && (
          <>
            <StudioSlider
              label="Vertical Perspective"
              value={transform.perspectiveV}
              min={-100}
              max={100}
              onChange={(v) => onOpticsChange({ perspectiveV: v }, false)}
              onCommit={onStraightenCommit}
              onReset={() => onOpticsChange({ perspectiveV: 0 }, true)}
            />
            <StudioSlider
              label="Horizontal Perspective"
              value={transform.perspectiveH}
              min={-100}
              max={100}
              onChange={(v) => onOpticsChange({ perspectiveH: v }, false)}
              onCommit={onStraightenCommit}
              onReset={() => onOpticsChange({ perspectiveH: 0 }, true)}
            />
          </>
        )}
      </div>

      {/* Aspect Ratio Presets */}
      <div className="border-t border-white/[0.07] pt-3">
        <span className="block text-xs font-medium text-zinc-400 mb-2">Aspect Ratio</span>
        <div className="grid grid-cols-4 gap-1.5">
          {ASPECT_OPTIONS.map((opt) => {
            const active = transform.aspectRatio === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => onAspectChange(opt.id)}
                className={`rounded-md border py-2 text-xs font-medium transition-colors min-h-[36px] ${
                  active
                    ? 'border-white bg-white text-zinc-950 font-semibold'
                    : 'border-white/[0.08] bg-[#16161a] text-zinc-300 hover:border-white/25 hover:text-white'
                }`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>

      {onDoneCrop && (
        <div className="pt-2">
          <button
            type="button"
            onClick={onDoneCrop}
            className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-white py-2.5 text-xs font-semibold text-zinc-950 hover:bg-zinc-200 transition-colors min-h-[42px]"
          >
            <Check className="w-4 h-4" />
            <span>Apply Crop</span>
          </button>
        </div>
      )}
    </div>
  );
};

export const CropPanel = memo(CropPanelComponent);
