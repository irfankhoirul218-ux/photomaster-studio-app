import React, { memo, useRef, useState } from 'react';
import {
  Bandage,
  Box,
  ChevronDown,
  ChevronRight,
  Crosshair,
  Eraser,
  Image as ImageIcon,
  Layers,
  Loader2,
  MousePointerClick,
  Paintbrush,
  RefreshCcw,
  Scissors,
  Sliders,
  Sparkles,
  Stamp,
  Trash2,
  User,
  Wand2,
} from 'lucide-react';
import {
  BackgroundMode,
  BackgroundRemovalMode,
  BackgroundSettings,
  BgRefinementSettings,
  BgSegmentationProgress,
  getDefaultRefinementForMode,
  RetouchBrushConfig,
  RetouchTool,
} from '../types/editor';
import { CloneSourcePoint } from './RetouchCanvasOverlay';
import { StudioSlider } from './StudioSlider';

interface RetouchPanelProps {
  activeTool: RetouchTool;
  onSelectTool: (tool: RetouchTool) => void;
  brushConfig: RetouchBrushConfig;
  onUpdateBrushConfig: (patch: Partial<RetouchBrushConfig>) => void;
  hasObjectSelection: boolean;
  isProcessingInpaint: boolean;
  onRunObjectRemoval: () => void;
  onClearObjectSelection: () => void;
  cloneSource: CloneSourcePoint | null;
  isPickingCloneSource: boolean;
  onTogglePickCloneSource: () => void;
  isProcessingBg: boolean;
  bgProgress: BgSegmentationProgress | null;
  bgLastModelLabel: string | null;
  hasTransparency: boolean;
  bgSettings: BackgroundSettings;
  bgRefinement: BgRefinementSettings;
  onChangeBgRefinement: (next: BgRefinementSettings, commit?: boolean) => void;
  onAutoRemoveBackground: () => void;
  onSnapManualSelection: () => void;
  onClearAlphaToEmpty: () => void;
  onResetAlphaMask: () => void;
  onChangeBgSettings: (next: BackgroundSettings) => void;
  onUploadBgImage: (file: File) => void;
}

const SOLID_BG_SWATCHES = [
  { label: 'Dark', color: '#09090b' },
  { label: 'White', color: '#ffffff' },
  { label: 'Slate', color: '#3f3f46' },
  { label: 'Blue', color: '#1d4ed8' },
  { label: 'Sage', color: '#15803d' },
];

const MASK_OVERLAY_COLORS = [
  { label: 'Red', color: '#ef4444' },
  { label: 'Blue', color: '#3b82f6' },
  { label: 'Green', color: '#22c55e' },
  { label: 'Amber', color: '#f59e0b' },
  { label: 'Purple', color: '#a855f7' },
  { label: 'White', color: '#ffffff' },
];

const RetouchPanelComponent: React.FC<RetouchPanelProps> = ({
  activeTool,
  onSelectTool,
  brushConfig,
  onUpdateBrushConfig,
  hasObjectSelection,
  isProcessingInpaint,
  onRunObjectRemoval,
  onClearObjectSelection,
  cloneSource,
  isPickingCloneSource,
  onTogglePickCloneSource,
  isProcessingBg,
  bgProgress,
  bgLastModelLabel,
  hasTransparency,
  bgSettings,
  bgRefinement,
  onChangeBgRefinement,
  onAutoRemoveBackground,
  onSnapManualSelection,
  onClearAlphaToEmpty,
  onResetAlphaMask,
  onChangeBgSettings,
  onUploadBgImage,
}) => {
  const bgFileInputRef = useRef<HTMLInputElement>(null);
  const [showRefinementGroup, setShowRefinementGroup] = useState(true);

  const tools: { id: RetouchTool; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
    { id: 'object-remover', label: 'Object', icon: Sparkles },
    { id: 'eraser', label: 'Eraser', icon: Eraser },
    { id: 'healing', label: 'Heal', icon: Bandage },
    { id: 'clone', label: 'Clone', icon: Stamp },
    { id: 'background', label: 'BG', icon: Scissors },
  ];

  return (
    <div className="space-y-3">
      <input
        ref={bgFileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onUploadBgImage(file);
          e.target.value = '';
        }}
      />

      {/* 5 Retouch Tool Sub-Tabs */}
      <div className="grid grid-cols-5 gap-1 rounded-lg border border-white/[0.07] bg-[#0a0a0c] p-1">
        {tools.map((t) => {
          const Icon = t.icon;
          const active = activeTool === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => onSelectTool(t.id)}
              className={`flex flex-col items-center justify-center gap-0.5 rounded-md py-1.5 text-[10px] font-medium transition-colors min-h-[42px] ${
                active
                  ? 'bg-white text-zinc-950 font-semibold shadow-sm'
                  : 'text-zinc-400 hover:bg-zinc-800/70 hover:text-zinc-100'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              <span>{t.label}</span>
            </button>
          );
        })}
      </div>

      {/* 1. OBJECT REMOVER */}
      {activeTool === 'object-remover' && (
        <div className="space-y-3 pt-1">
          <div>
            <h3 className="text-xs font-semibold text-white">Object Remover</h3>
            <p className="mt-0.5 text-[11px] leading-relaxed text-zinc-400">
              Brush over unwanted objects, cables, people, or blemishes, then remove them using
              local texture reconstruction.
            </p>
          </div>

          <StudioSlider
            label="Brush Size"
            value={brushConfig.objectBrushSize}
            min={8}
            max={160}
            unit="px"
            onChange={(v) => onUpdateBrushConfig({ objectBrushSize: v })}
            onReset={() => onUpdateBrushConfig({ objectBrushSize: 42 })}
          />

          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              onClick={onRunObjectRemoval}
              disabled={!hasObjectSelection || isProcessingInpaint}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-white py-2.5 px-3 text-xs font-semibold text-zinc-950 hover:bg-zinc-200 disabled:opacity-40 transition-colors min-h-[42px]"
            >
              {isProcessingInpaint ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Reconstructing...</span>
                </>
              ) : (
                <>
                  <Wand2 className="w-3.5 h-3.5" />
                  <span>Remove Object</span>
                </>
              )}
            </button>

            <button
              type="button"
              onClick={onClearObjectSelection}
              disabled={!hasObjectSelection || isProcessingInpaint}
              title="Clear selection mask"
              className="flex items-center justify-center gap-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2.5 text-xs font-medium text-zinc-300 hover:bg-zinc-800 hover:text-white disabled:opacity-35 transition-colors min-h-[42px]"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Clear</span>
            </button>
          </div>
        </div>
      )}

      {/* 2. MANUAL ERASER */}
      {activeTool === 'eraser' && (
        <div className="space-y-3 pt-1">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold text-white">Manual Eraser</h3>
            {hasTransparency && (
              <button
                type="button"
                onClick={onResetAlphaMask}
                className="flex items-center gap-1 text-[11px] text-zinc-400 hover:text-white"
              >
                <RefreshCcw className="w-3 h-3" />
                <span>Reset</span>
              </button>
            )}
          </div>

          <div className="grid grid-cols-2 gap-1.5 p-1 rounded-lg bg-zinc-950 border border-white/[0.06]">
            <button
              type="button"
              onClick={() => onUpdateBrushConfig({ eraserMode: 'erase' })}
              className={`flex items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-medium transition-colors min-h-[34px] ${
                brushConfig.eraserMode === 'erase'
                  ? 'bg-white text-zinc-950 font-semibold'
                  : 'text-zinc-400 hover:text-white'
              }`}
            >
              <Eraser className="w-3.5 h-3.5" />
              <span>Erase</span>
            </button>
            <button
              type="button"
              onClick={() => onUpdateBrushConfig({ eraserMode: 'restore' })}
              className={`flex items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-medium transition-colors min-h-[34px] ${
                brushConfig.eraserMode === 'restore'
                  ? 'bg-white text-zinc-950 font-semibold'
                  : 'text-zinc-400 hover:text-white'
              }`}
            >
              <Paintbrush className="w-3.5 h-3.5" />
              <span>Restore</span>
            </button>
          </div>

          <StudioSlider
            label="Brush Size"
            value={brushConfig.eraserSize}
            min={4}
            max={180}
            unit="px"
            onChange={(v) => onUpdateBrushConfig({ eraserSize: v })}
            onReset={() => onUpdateBrushConfig({ eraserSize: 48 })}
          />
          <StudioSlider
            label="Hardness"
            value={brushConfig.eraserHardness}
            min={0}
            max={100}
            unit="%"
            onChange={(v) => onUpdateBrushConfig({ eraserHardness: v })}
            onReset={() => onUpdateBrushConfig({ eraserHardness: 75 })}
          />
          <StudioSlider
            label="Opacity"
            value={brushConfig.eraserOpacity}
            min={5}
            max={100}
            unit="%"
            onChange={(v) => onUpdateBrushConfig({ eraserOpacity: v })}
            onReset={() => onUpdateBrushConfig({ eraserOpacity: 100 })}
          />

          <label className="flex items-center justify-between rounded-lg border border-white/[0.08] bg-[#16161a] px-3 py-2 cursor-pointer">
            <span className="text-xs font-medium text-zinc-300">Show Erase Mask Overlay</span>
            <input
              type="checkbox"
              checked={brushConfig.eraserShowMask}
              onChange={(e) => onUpdateBrushConfig({ eraserShowMask: e.target.checked })}
              className="h-4 w-4 accent-white rounded"
            />
          </label>
        </div>
      )}

      {/* 3. HEALING BRUSH */}
      {activeTool === 'healing' && (
        <div className="space-y-3 pt-1">
          <div>
            <h3 className="text-xs font-semibold text-white">Healing Brush</h3>
            <p className="mt-0.5 text-[11px] leading-relaxed text-zinc-400">
              Tap or brush over pimples, dust, or spots to blend surrounding clean texture and tone.
            </p>
          </div>

          <StudioSlider
            label="Brush Size"
            value={brushConfig.healingSize}
            min={6}
            max={120}
            unit="px"
            onChange={(v) => onUpdateBrushConfig({ healingSize: v })}
            onReset={() => onUpdateBrushConfig({ healingSize: 28 })}
          />
          <StudioSlider
            label="Blend Softness"
            value={brushConfig.healingSoftness}
            min={0}
            max={100}
            unit="%"
            onChange={(v) => onUpdateBrushConfig({ healingSoftness: v })}
            onReset={() => onUpdateBrushConfig({ healingSoftness: 75 })}
          />
        </div>
      )}

      {/* 4. CLONE STAMP */}
      {activeTool === 'clone' && (
        <div className="space-y-3 pt-1">
          <div>
            <h3 className="text-xs font-semibold text-white">Clone Stamp</h3>
            <p className="mt-0.5 text-[11px] leading-relaxed text-zinc-400">
              Pick a source point (or Alt+Click on desktop), then paint copied pixels onto the target.
            </p>
          </div>

          <button
            type="button"
            onClick={onTogglePickCloneSource}
            className={`flex w-full items-center justify-center gap-2 rounded-lg border py-2.5 px-3 text-xs font-semibold transition-colors min-h-[42px] ${
              isPickingCloneSource
                ? 'border-white bg-white text-zinc-950'
                : 'border-zinc-700 bg-zinc-900 text-zinc-200 hover:bg-zinc-800 hover:text-white'
            }`}
          >
            <Crosshair className="w-3.5 h-3.5" />
            <span>
              {isPickingCloneSource
                ? 'Tap Photo to Set Source...'
                : cloneSource
                  ? `Source Set (${Math.round(cloneSource.x)}, ${Math.round(cloneSource.y)}) · Change`
                  : 'Set Source Point'}
            </span>
          </button>

          <StudioSlider
            label="Brush Size"
            value={brushConfig.cloneSize}
            min={6}
            max={160}
            unit="px"
            onChange={(v) => onUpdateBrushConfig({ cloneSize: v })}
            onReset={() => onUpdateBrushConfig({ cloneSize: 40 })}
          />
          <StudioSlider
            label="Opacity"
            value={brushConfig.cloneOpacity}
            min={10}
            max={100}
            unit="%"
            onChange={(v) => onUpdateBrushConfig({ cloneOpacity: v })}
            onReset={() => onUpdateBrushConfig({ cloneOpacity: 100 })}
          />
          <StudioSlider
            label="Hardness"
            value={brushConfig.cloneHardness}
            min={0}
            max={100}
            unit="%"
            onChange={(v) => onUpdateBrushConfig({ cloneHardness: v })}
            onReset={() => onUpdateBrushConfig({ cloneHardness: 65 })}
          />

          <label className="flex items-center justify-between rounded-lg border border-white/[0.08] bg-[#16161a] px-3 py-2 cursor-pointer">
            <span className="text-xs font-medium text-zinc-300">Aligned Source Offset</span>
            <input
              type="checkbox"
              checked={brushConfig.cloneAligned}
              onChange={(e) => onUpdateBrushConfig({ cloneAligned: e.target.checked })}
              className="h-4 w-4 accent-white rounded"
            />
          </label>
        </div>
      )}

      {/* 5. BACKGROUND REMOVER */}
      {activeTool === 'background' && (
        <div className="space-y-3 pt-1">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold text-white">Background Remover</h3>
            {hasTransparency && (
              <button
                type="button"
                onClick={onResetAlphaMask}
                className="flex items-center gap-1 text-[11px] text-zinc-400 hover:text-white"
              >
                <RefreshCcw className="w-3 h-3" />
                <span>Restore All</span>
              </button>
            )}
          </div>

          {/* 4 Segmentation Modes */}
          <div className="space-y-1.5">
            <span className="block text-[11px] font-medium text-zinc-400">
              Segmentation Mode
            </span>
            <div className="grid grid-cols-4 gap-1 rounded-lg border border-white/[0.06] bg-zinc-950 p-1">
              {(
                [
                  { id: 'portrait', label: 'Portrait', icon: User },
                  { id: 'general', label: 'Object', icon: Layers },
                  { id: 'product', label: 'Product', icon: Box },
                  { id: 'manual', label: 'Manual', icon: MousePointerClick },
                ] as {
                  id: BackgroundRemovalMode;
                  label: string;
                  icon: React.ComponentType<{ className?: string }>;
                }[]
              ).map((m) => {
                const Icon = m.icon;
                const active = bgRefinement.mode === m.id;
                return (
                  <button
                    key={m.id}
                    type="button"
                    disabled={isProcessingBg}
                    onClick={() => {
                      const modeDefaults = getDefaultRefinementForMode(m.id);
                      onChangeBgRefinement(modeDefaults, hasTransparency);
                    }}
                    className={`flex flex-col items-center justify-center gap-0.5 rounded-md py-1.5 text-[10px] font-medium transition-colors min-h-[38px] disabled:opacity-50 ${
                      active
                        ? 'bg-white text-zinc-950 font-semibold shadow-sm'
                        : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100'
                    }`}
                  >
                    <Icon className="w-3 h-3" />
                    <span>{m.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Primary Segmentation Action */}
          {bgRefinement.mode !== 'manual' ? (
            <div className="space-y-1.5">
              <button
                type="button"
                onClick={onAutoRemoveBackground}
                disabled={isProcessingBg}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-white py-2.5 px-3 text-xs font-semibold text-zinc-950 hover:bg-zinc-200 disabled:opacity-60 transition-colors min-h-[42px]"
              >
                {isProcessingBg ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>
                      {bgProgress?.stage === 'loading-model'
                        ? `Downloading Model (${bgProgress.progress}%)...`
                        : 'Removing Background...'}
                    </span>
                  </>
                ) : (
                  <>
                    <Scissors className="w-3.5 h-3.5" />
                    <span>
                      Auto Remove ({bgRefinement.mode === 'portrait'
                        ? 'Portrait Hair AI'
                        : bgRefinement.mode === 'product'
                          ? 'Product Cutout'
                          : 'General Subject'}
                      )
                    </span>
                  </>
                )}
              </button>

              {isProcessingBg && bgProgress && (
                <div className="rounded-lg border border-white/[0.08] bg-zinc-950 px-2.5 py-2 space-y-1.5">
                  <div className="flex items-center justify-between text-[10px] text-zinc-300">
                    <span className="truncate">{bgProgress.message}</span>
                    <span className="font-mono-tabular shrink-0 ml-2">{bgProgress.progress}%</span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
                    <div
                      className="h-full bg-white transition-all duration-200"
                      style={{ width: `${bgProgress.progress}%` }}
                    />
                  </div>
                </div>
              )}

              {!isProcessingBg && (
                <p className="text-[10px] leading-relaxed text-zinc-500">
                  {bgLastModelLabel
                    ? `Active engine: ${bgLastModelLabel} (cached locally in browser).`
                    : 'Runs free in your browser. First run downloads & caches an open-source ONNX model.'}
                </p>
              )}
            </div>
          ) : (
            <div className="rounded-lg border border-white/[0.08] bg-[#16161a] p-2.5 space-y-2">
              <p className="text-[11px] leading-relaxed text-zinc-300">
                Paint <span className="text-white font-medium">Restore</span> over the subject or{' '}
                <span className="text-white font-medium">Erase</span> over background, then snap
                edges cleanly.
              </p>
              <div className="grid grid-cols-3 gap-1.5">
                <button
                  type="button"
                  onClick={onClearAlphaToEmpty}
                  className="rounded-md border border-zinc-700 bg-zinc-900 py-1.5 px-2 text-[10px] font-medium text-zinc-200 hover:bg-zinc-800 transition-colors min-h-[32px]"
                >
                  Clear All
                </button>
                <button
                  type="button"
                  onClick={onResetAlphaMask}
                  className="rounded-md border border-zinc-700 bg-zinc-900 py-1.5 px-2 text-[10px] font-medium text-zinc-200 hover:bg-zinc-800 transition-colors min-h-[32px]"
                >
                  Fill Subject
                </button>
                <button
                  type="button"
                  onClick={onSnapManualSelection}
                  className="rounded-md bg-white py-1.5 px-2 text-[10px] font-semibold text-zinc-950 hover:bg-zinc-200 transition-colors min-h-[32px]"
                >
                  Snap Edges
                </button>
              </div>
            </div>
          )}

          {/* Edge Refinement & Color Decontamination */}
          <div className="border-t border-white/[0.07] pt-2.5 space-y-2">
            <button
              type="button"
              onClick={() => setShowRefinementGroup((s) => !s)}
              className="flex w-full items-center justify-between text-left py-0.5 text-[11px] font-semibold text-zinc-200 hover:text-white"
            >
              <span className="flex items-center gap-1.5">
                <Sliders className="w-3.5 h-3.5 text-zinc-400" />
                <span>Edge Refinement & Hair</span>
              </span>
              {showRefinementGroup ? (
                <ChevronDown className="w-3.5 h-3.5 text-zinc-400" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5 text-zinc-400" />
              )}
            </button>

            {showRefinementGroup && (
              <div className="space-y-2 pt-1">
                <StudioSlider
                  label="Refine Edge"
                  value={bgRefinement.refineEdge}
                  min={0}
                  max={100}
                  unit="%"
                  onChange={(v) => onChangeBgRefinement({ ...bgRefinement, refineEdge: v }, false)}
                  onCommit={() => onChangeBgRefinement(bgRefinement, true)}
                  onReset={() =>
                    onChangeBgRefinement(
                      {
                        ...bgRefinement,
                        refineEdge: getDefaultRefinementForMode(bgRefinement.mode).refineEdge,
                      },
                      true
                    )
                  }
                />
                <StudioSlider
                  label="Hair Refinement"
                  value={bgRefinement.hairRefinement}
                  min={0}
                  max={100}
                  unit="%"
                  onChange={(v) =>
                    onChangeBgRefinement({ ...bgRefinement, hairRefinement: v }, false)
                  }
                  onCommit={() => onChangeBgRefinement(bgRefinement, true)}
                  onReset={() =>
                    onChangeBgRefinement(
                      {
                        ...bgRefinement,
                        hairRefinement: getDefaultRefinementForMode(bgRefinement.mode)
                          .hairRefinement,
                      },
                      true
                    )
                  }
                />
                <StudioSlider
                  label="Edge Feather"
                  value={bgRefinement.feather}
                  min={0}
                  max={40}
                  step={0.5}
                  unit="px"
                  onChange={(v) => onChangeBgRefinement({ ...bgRefinement, feather: v }, false)}
                  onCommit={() => onChangeBgRefinement(bgRefinement, true)}
                  onReset={() =>
                    onChangeBgRefinement(
                      {
                        ...bgRefinement,
                        feather: getDefaultRefinementForMode(bgRefinement.mode).feather,
                      },
                      true
                    )
                  }
                />
                <StudioSlider
                  label="Edge Smooth"
                  value={bgRefinement.smooth}
                  min={0}
                  max={100}
                  unit="%"
                  onChange={(v) => onChangeBgRefinement({ ...bgRefinement, smooth: v }, false)}
                  onCommit={() => onChangeBgRefinement(bgRefinement, true)}
                  onReset={() =>
                    onChangeBgRefinement(
                      {
                        ...bgRefinement,
                        smooth: getDefaultRefinementForMode(bgRefinement.mode).smooth,
                      },
                      true
                    )
                  }
                />
                <StudioSlider
                  label="Edge Contrast"
                  value={bgRefinement.contrast}
                  min={0}
                  max={100}
                  unit="%"
                  onChange={(v) => onChangeBgRefinement({ ...bgRefinement, contrast: v }, false)}
                  onCommit={() => onChangeBgRefinement(bgRefinement, true)}
                  onReset={() =>
                    onChangeBgRefinement(
                      {
                        ...bgRefinement,
                        contrast: getDefaultRefinementForMode(bgRefinement.mode).contrast,
                      },
                      true
                    )
                  }
                />
                <StudioSlider
                  label="Expand / Contract"
                  value={bgRefinement.expandContract}
                  min={-30}
                  max={30}
                  step={0.5}
                  unit="px"
                  onChange={(v) =>
                    onChangeBgRefinement({ ...bgRefinement, expandContract: v }, false)
                  }
                  onCommit={() => onChangeBgRefinement(bgRefinement, true)}
                  onReset={() =>
                    onChangeBgRefinement({ ...bgRefinement, expandContract: 0 }, true)
                  }
                />
                <StudioSlider
                  label="Decontaminate Colors"
                  value={bgRefinement.decontaminateColors}
                  min={0}
                  max={100}
                  unit="%"
                  onChange={(v) =>
                    onChangeBgRefinement({ ...bgRefinement, decontaminateColors: v }, false)
                  }
                  onCommit={() => onChangeBgRefinement(bgRefinement, true)}
                  onReset={() =>
                    onChangeBgRefinement(
                      {
                        ...bgRefinement,
                        decontaminateColors: getDefaultRefinementForMode(bgRefinement.mode)
                          .decontaminateColors,
                      },
                      true
                    )
                  }
                />
                <StudioSlider
                  label="Remove Color Halo"
                  value={bgRefinement.removeColorHalo}
                  min={0}
                  max={100}
                  unit="%"
                  onChange={(v) =>
                    onChangeBgRefinement({ ...bgRefinement, removeColorHalo: v }, false)
                  }
                  onCommit={() => onChangeBgRefinement(bgRefinement, true)}
                  onReset={() =>
                    onChangeBgRefinement(
                      {
                        ...bgRefinement,
                        removeColorHalo: getDefaultRefinementForMode(bgRefinement.mode)
                          .removeColorHalo,
                      },
                      true
                    )
                  }
                />
              </div>
            )}
          </div>

          {/* Manual Mask Correction Brushes */}
          <div className="border-t border-white/[0.07] pt-2.5 space-y-2">
            <span className="block text-[11px] font-medium text-zinc-400">
              Manual Mask Correction
            </span>
            <div className="grid grid-cols-2 gap-1.5 p-1 rounded-lg bg-zinc-950 border border-white/[0.06]">
              <button
                type="button"
                onClick={() => onUpdateBrushConfig({ bgBrushMode: 'restore' })}
                className={`flex items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-medium transition-colors min-h-[34px] ${
                  brushConfig.bgBrushMode === 'restore'
                    ? 'bg-white text-zinc-950 font-semibold'
                    : 'text-zinc-400 hover:text-white'
                }`}
              >
                <Paintbrush className="w-3.5 h-3.5" />
                <span>Restore</span>
              </button>
              <button
                type="button"
                onClick={() => onUpdateBrushConfig({ bgBrushMode: 'erase' })}
                className={`flex items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-medium transition-colors min-h-[34px] ${
                  brushConfig.bgBrushMode === 'erase'
                    ? 'bg-white text-zinc-950 font-semibold'
                    : 'text-zinc-400 hover:text-white'
                }`}
              >
                <Eraser className="w-3.5 h-3.5" />
                <span>Erase</span>
              </button>
            </div>

            <StudioSlider
              label="Brush Size"
              value={brushConfig.bgBrushSize}
              min={4}
              max={200}
              unit="px"
              onChange={(v) => onUpdateBrushConfig({ bgBrushSize: v })}
              onReset={() => onUpdateBrushConfig({ bgBrushSize: 48 })}
            />
            <StudioSlider
              label="Brush Hardness"
              value={brushConfig.bgBrushHardness}
              min={0}
              max={100}
              unit="%"
              onChange={(v) => onUpdateBrushConfig({ bgBrushHardness: v })}
              onReset={() => onUpdateBrushConfig({ bgBrushHardness: 75 })}
            />
            <StudioSlider
              label="Brush Feather"
              value={brushConfig.bgBrushFeather}
              min={0}
              max={100}
              unit="%"
              onChange={(v) => onUpdateBrushConfig({ bgBrushFeather: v })}
              onReset={() => onUpdateBrushConfig({ bgBrushFeather: 25 })}
            />

            <div className="rounded-lg border border-white/[0.08] bg-[#16161a] px-3 py-2 space-y-2">
              <label className="flex items-center justify-between cursor-pointer">
                <span className="text-xs font-medium text-zinc-300">Show Mask Overlay</span>
                <input
                  type="checkbox"
                  checked={brushConfig.bgShowMask}
                  onChange={(e) => onUpdateBrushConfig({ bgShowMask: e.target.checked })}
                  className="h-4 w-4 accent-white rounded"
                />
              </label>

              {brushConfig.bgShowMask && (
                <div className="flex items-center justify-between border-t border-white/[0.06] pt-2">
                  <span className="text-[11px] text-zinc-400">Overlay Color</span>
                  <div className="flex items-center gap-1.5">
                    {MASK_OVERLAY_COLORS.map((c) => (
                      <button
                        key={c.color}
                        type="button"
                        title={c.label}
                        onClick={() => onUpdateBrushConfig({ bgMaskOverlayColor: c.color })}
                        className={`h-5 w-5 rounded-full border transition-transform ${
                          brushConfig.bgMaskOverlayColor.toLowerCase() === c.color
                            ? 'border-white scale-115 ring-1 ring-white/50'
                            : 'border-white/25 hover:scale-105'
                        }`}
                        style={{ backgroundColor: c.color }}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Background Replacement */}
          <div className="border-t border-white/[0.07] pt-2.5 space-y-2">
            <span className="block text-[11px] font-medium text-zinc-400">
              Background Replacement
            </span>
            <div className="grid grid-cols-3 gap-1 p-1 rounded-lg bg-zinc-950 border border-white/[0.06]">
              {(
                [
                  { id: 'transparent', label: 'Transparent' },
                  { id: 'solid', label: 'Color' },
                  { id: 'image', label: 'Image' },
                ] as { id: BackgroundMode; label: string }[]
              ).map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => {
                    if (m.id === 'image' && !bgSettings.imageSrc) {
                      bgFileInputRef.current?.click();
                    } else {
                      onChangeBgSettings({ ...bgSettings, mode: m.id });
                    }
                  }}
                  className={`rounded-md py-1.5 text-[11px] font-medium transition-colors min-h-[32px] ${
                    bgSettings.mode === m.id
                      ? 'bg-white text-zinc-950 font-semibold'
                      : 'text-zinc-400 hover:text-white'
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>

            {bgSettings.mode === 'solid' && (
              <div className="flex items-center justify-between gap-2 pt-1">
                <div className="flex items-center gap-1.5">
                  {SOLID_BG_SWATCHES.map((sw) => (
                    <button
                      key={sw.color}
                      type="button"
                      onClick={() =>
                        onChangeBgSettings({ ...bgSettings, mode: 'solid', color: sw.color })
                      }
                      title={sw.label}
                      className={`h-7 w-7 rounded-md border transition-transform ${
                        bgSettings.color.toLowerCase() === sw.color
                          ? 'border-white scale-110'
                          : 'border-white/20 hover:scale-105'
                      }`}
                      style={{ backgroundColor: sw.color }}
                    />
                  ))}
                </div>
                <label className="flex items-center gap-1.5 text-[11px] text-zinc-300 cursor-pointer">
                  <span>Custom</span>
                  <input
                    type="color"
                    value={bgSettings.color}
                    onChange={(e) =>
                      onChangeBgSettings({ ...bgSettings, mode: 'solid', color: e.target.value })
                    }
                    className="h-7 w-9 cursor-pointer rounded border border-white/20 bg-transparent p-0"
                  />
                </label>
              </div>
            )}

            {bgSettings.mode === 'image' && (
              <button
                type="button"
                onClick={() => bgFileInputRef.current?.click()}
                className="flex w-full items-center justify-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs font-medium text-zinc-200 hover:bg-zinc-800 hover:text-white transition-colors min-h-[38px]"
              >
                <ImageIcon className="w-3.5 h-3.5" />
                <span className="truncate">
                  {bgSettings.imageName ? `BG: ${bgSettings.imageName}` : 'Upload Background Image'}
                </span>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export const RetouchPanel = memo(RetouchPanelComponent);
