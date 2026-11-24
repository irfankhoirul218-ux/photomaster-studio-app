import React, { memo, useState } from 'react';
import {
  BoxSelect,
  Check,
  CircleDot,
  CloudSun,
  Contrast,
  Copy,
  Eye,
  EyeOff,
  FlipHorizontal,
  Layers,
  Minus,
  Paintbrush,
  Pencil,
  Pipette,
  Plus,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  UserCheck,
} from 'lucide-react';
import {
  DEFAULT_LOCAL_ADJUSTMENTS,
  LocalAdjustments,
  MaskBrushSettings,
  MaskComponent,
  MaskCreationTool,
  MaskLayer,
  MaskOperation,
} from '../types/editor';
import { ActiveMaskPointerTool } from './MaskCanvasOverlay';
import { StudioSlider } from './StudioSlider';

const LinearIcon = Contrast;
const RadialIcon = CircleDot;

interface MaskingPanelProps {
  masks: MaskLayer[];
  activeMaskId: string | null;
  onSelectMask: (id: string) => void;
  pointerTool: ActiveMaskPointerTool;
  brushSettings: MaskBrushSettings;
  isSegmenting: boolean;
  showRedMask: boolean;
  onToggleShowRedMask: () => void;
  onUpdateBrushSettings: (patch: Partial<MaskBrushSettings>) => void;
  onCreateMaskWithTool: (tool: MaskCreationTool, op?: MaskOperation) => void;
  onEditWithBrush: (maskId: string, op?: 'add' | 'subtract') => void;
  onIntersectWithMask: (targetMaskId: string, sourceMaskId: string) => void;
  onUpdateMaskLayer: (
    maskId: string,
    updater: (prev: MaskLayer) => MaskLayer,
    commit?: boolean
  ) => void;
  onInvertMask: (maskId: string) => void;
  onDuplicateMask: (maskId: string) => void;
  onDeleteMask: (maskId: string) => void;
  onRemoveComponent: (maskId: string, compId: string) => void;
  onSetPointerTool: (tool: ActiveMaskPointerTool) => void;
  onStartPhotoEditing: () => void;
}

const OVERLAY_SWATCHES = ['#ef4444', '#3b82f6', '#22c55e', '#f59e0b', '#ffffff'];

const CREATE_TOOLS: {
  id: MaskCreationTool;
  label: string;
  sublabel: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  { id: 'subject', label: 'Subject', sublabel: 'Local AI heuristic', icon: UserCheck },
  { id: 'sky', label: 'Sky', sublabel: 'Horizon + tone', icon: CloudSun },
  { id: 'background', label: 'Background', sublabel: 'Inverse subject', icon: Layers },
  { id: 'brush', label: 'Brush', sublabel: 'Manual paint', icon: Paintbrush },
  { id: 'linear', label: 'Linear', sublabel: 'Graduated filter', icon: LinearIcon },
  { id: 'radial', label: 'Radial', sublabel: 'Elliptical vignette', icon: RadialIcon },
  { id: 'color-range', label: 'Color', sublabel: 'Sample color hue', icon: Pipette },
  { id: 'luminance-range', label: 'Luma', sublabel: 'Tone brightness', icon: SlidersHorizontal },
  { id: 'object', label: 'Object', sublabel: 'Drag box cut', icon: BoxSelect },
];

const MaskingPanelComponent: React.FC<MaskingPanelProps> = ({
  masks,
  activeMaskId,
  onSelectMask,
  pointerTool,
  brushSettings,
  isSegmenting,
  showRedMask,
  onToggleShowRedMask,
  onUpdateBrushSettings,
  onCreateMaskWithTool,
  onEditWithBrush,
  onIntersectWithMask,
  onUpdateMaskLayer,
  onInvertMask,
  onDuplicateMask,
  onDeleteMask,
  onRemoveComponent,
  onSetPointerTool,
  onStartPhotoEditing,
}) => {
  const [composeOp, setComposeOp] = useState<'new' | MaskOperation>('new');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState('');
  const [showIntersectPicker, setShowIntersectPicker] = useState(false);

  const activeMask = masks.find((m) => m.id === activeMaskId) ?? null;

  const triggerTool = (toolId: MaskCreationTool) => {
    if (
      toolId === 'brush' &&
      composeOp === 'new' &&
      activeMask &&
      pointerTool.mode === 'idle' &&
      activeMask.components.some((c) => c.kind === 'brush')
    ) {
      onEditWithBrush(activeMask.id, 'add');
      return;
    }
    const op: MaskOperation | undefined =
      composeOp === 'new' || !activeMask ? undefined : composeOp;
    onCreateMaskWithTool(toolId, op);
    setComposeOp('new');
  };

  const updateLocalAdj = (
    key: keyof LocalAdjustments,
    val: number,
    commit = false
  ) => {
    if (!activeMask) return;
    onStartPhotoEditing();
    onUpdateMaskLayer(
      activeMask.id,
      (prev) => ({
        ...prev,
        showOverlay: false,
        adjustments: { ...prev.adjustments, [key]: val },
      }),
      commit
    );
  };

  const resetLocalAdj = (key?: keyof LocalAdjustments) => {
    if (!activeMask) return;
    onStartPhotoEditing();
    onUpdateMaskLayer(
      activeMask.id,
      (prev) => ({
        ...prev,
        showOverlay: false,
        adjustments: key
          ? { ...prev.adjustments, [key]: DEFAULT_LOCAL_ADJUSTMENTS[key] }
          : { ...DEFAULT_LOCAL_ADJUSTMENTS },
      }),
      true
    );
  };

  const activeColorRange = activeMask?.components.find((c) => c.kind === 'color-range');
  const activeLumaRange = activeMask?.components.find((c) => c.kind === 'luminance-range');
  const activeRadial = activeMask?.components.find((c) => c.kind === 'radial');

  return (
    <div className="space-y-3">
      {/* Create / Boolean Tool Mode */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-zinc-200">
            {composeOp === 'new' || !activeMask
              ? 'Create New Mask'
              : composeOp === 'add'
                ? `Add to "${activeMask.name}"`
                : composeOp === 'subtract'
                  ? `Subtract from "${activeMask.name}"`
                  : `Intersect with "${activeMask.name}"`}
          </span>
          {composeOp !== 'new' && (
            <button
              type="button"
              onClick={() => setComposeOp('new')}
              className="text-[11px] text-zinc-400 hover:text-white underline"
            >
              Cancel
            </button>
          )}
        </div>

        <div className="grid grid-cols-3 gap-1.5">
          {CREATE_TOOLS.map((tool) => {
            const Icon = tool.icon;
            const isHighlighted =
              (tool.id === 'brush' && pointerTool.mode === 'brush') ||
              (tool.id === 'linear' && pointerTool.mode === 'create-linear') ||
              (tool.id === 'radial' && pointerTool.mode === 'create-radial') ||
              (tool.id === 'object' && pointerTool.mode === 'create-object');
            return (
              <button
                key={tool.id}
                type="button"
                disabled={isSegmenting}
                onClick={() => triggerTool(tool.id)}
                title={`${tool.label}: ${tool.sublabel}`}
                className={`flex flex-col items-center justify-center rounded-lg border px-1.5 py-2 text-center transition-colors min-h-[48px] disabled:opacity-45 ${
                  isHighlighted
                    ? 'border-white bg-white text-zinc-950'
                    : 'border-white/[0.08] bg-[#16161a] text-zinc-200 hover:border-white/30 hover:text-white'
                }`}
              >
                <Icon className="w-3.5 h-3.5 mb-0.5" />
                <span className="text-[10px] font-medium leading-tight">{tool.label}</span>
              </button>
            );
          })}
        </div>

        <p className="text-[10px] leading-relaxed text-zinc-500">
          Subject, Sky, Background, and Object Selection run locally in-browser via edge &amp; color
          heuristics. Refine any cutout with Add/Subtract Brush or Edge Refinement.
        </p>
      </div>

      {/* Mask Layers List */}
      <div className="border-t border-white/[0.07] pt-2.5 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold text-zinc-200">
            Mask Layers ({masks.length})
          </span>
          {pointerTool.mode !== 'idle' && activeMask && (
            <button
              type="button"
              onClick={() => {
                onSetPointerTool({ mode: 'idle' });
                onStartPhotoEditing();
                onUpdateMaskLayer(
                  activeMask.id,
                  (prev) => ({ ...prev, showOverlay: false }),
                  false
                );
              }}
              className="rounded border border-white/15 bg-zinc-900 px-2 py-0.5 text-[10px] font-medium text-zinc-200 hover:bg-zinc-800 hover:text-white"
            >
              Done
            </button>
          )}
        </div>

        {/* Manual Overlay & Transparent Red Mask Preview Controls */}
        {activeMask && (
          <div className="grid grid-cols-3 gap-1.5">
            <button
              type="button"
              onClick={() => {
                const nextShow = !activeMask.showOverlay;
                if (nextShow && showRedMask) {
                  onToggleShowRedMask();
                }
                onUpdateMaskLayer(
                  activeMask.id,
                  (prev) => ({ ...prev, showOverlay: nextShow }),
                  false
                );
              }}
              title={
                activeMask.showOverlay
                  ? 'Hide colored mask overlay'
                  : 'Show colored mask overlay'
              }
              className={`flex items-center justify-center gap-1 rounded-md border px-2 py-1.5 text-[10px] font-medium transition-colors ${
                activeMask.showOverlay && !showRedMask
                  ? 'border-white bg-white text-zinc-950'
                  : 'border-white/[0.1] bg-[#16161a] text-zinc-200 hover:border-white/30 hover:text-white'
              }`}
            >
              {activeMask.showOverlay && !showRedMask ? (
                <>
                  <Eye className="w-3 h-3 shrink-0" />
                  <span className="truncate">Hide Overlay</span>
                </>
              ) : (
                <>
                  <EyeOff className="w-3 h-3 shrink-0" />
                  <span className="truncate">Show Overlay</span>
                </>
              )}
            </button>

            <button
              type="button"
              onClick={onToggleShowRedMask}
              title="Preview active mask area in transparent red"
              className={`flex items-center justify-center gap-1 rounded-md border px-2 py-1.5 text-[10px] font-medium transition-colors ${
                showRedMask
                  ? 'border-red-400 bg-red-600 text-white'
                  : 'border-white/[0.1] bg-[#16161a] text-zinc-200 hover:border-red-400/50 hover:text-white'
              }`}
            >
              <span
                className={`h-2 w-2 rounded-full shrink-0 ${
                  showRedMask ? 'bg-white' : 'bg-red-500'
                }`}
              />
              <span className="truncate">Show Mask</span>
            </button>

            <button
              type="button"
              onClick={() => onEditWithBrush(activeMask.id, 'add')}
              title="Activate Brush tool on active mask and show brush outline"
              className={`flex items-center justify-center gap-1 rounded-md border px-2 py-1.5 text-[10px] font-medium transition-colors ${
                pointerTool.mode === 'brush'
                  ? 'border-white bg-white text-zinc-950'
                  : 'border-white/[0.1] bg-[#16161a] text-zinc-200 hover:border-white/30 hover:text-white'
              }`}
            >
              <Paintbrush className="w-3 h-3 shrink-0" />
              <span className="truncate">Edit Brush</span>
            </button>
          </div>
        )}

        {masks.length === 0 ? (
          <div className="rounded-lg border border-dashed border-white/[0.1] bg-[#0b0b0e] px-3 py-3 text-center text-[11px] text-zinc-400">
            Select any tool above (Subject, Sky, Brush, Gradient, Color, Luminance, or Object) to
            create your first editable mask.
          </div>
        ) : (
          <div className="space-y-1.5 max-h-40 overflow-y-auto studio-scroll pr-0.5">
            {masks.map((m) => {
              const isSelected = m.id === activeMaskId;
              const isRenaming = renamingId === m.id;
              return (
                <div
                  key={m.id}
                  className={`rounded-lg border px-2 py-1.5 transition-colors ${
                    isSelected
                      ? 'border-white bg-zinc-800/80'
                      : 'border-white/[0.08] bg-[#16161a] hover:border-white/25'
                  }`}
                >
                  {isRenaming ? (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        const trimmed = renameVal.trim();
                        if (trimmed) {
                          onUpdateMaskLayer(m.id, (prev) => ({ ...prev, name: trimmed }), true);
                        }
                        setRenamingId(null);
                      }}
                      className="flex items-center gap-1"
                    >
                      <input
                        type="text"
                        value={renameVal}
                        onChange={(e) => setRenameVal(e.target.value)}
                        autoFocus
                        maxLength={32}
                        className="flex-1 min-w-0 rounded border border-zinc-600 bg-zinc-950 px-1.5 py-0.5 text-xs text-white focus:border-white focus:outline-none"
                      />
                      <button
                        type="submit"
                        className="rounded bg-white p-1 text-zinc-950"
                        aria-label="Save name"
                      >
                        <Check className="w-3 h-3" />
                      </button>
                    </form>
                  ) : (
                    <div className="flex items-center justify-between gap-1.5">
                      <button
                        type="button"
                        onClick={() => onSelectMask(m.id)}
                        className="flex flex-1 min-w-0 items-center gap-2 text-left"
                      >
                        <span
                          className="h-2.5 w-2.5 rounded-full shrink-0 border border-white/25"
                          style={{ backgroundColor: m.overlayColor }}
                        />
                        <span
                          className={`truncate text-xs font-medium ${
                            m.enabled ? 'text-white' : 'text-zinc-500 line-through'
                          }`}
                        >
                          {m.name}
                          {m.inverted ? ' (Inv)' : ''}
                        </span>
                      </button>

                      <div className="flex items-center gap-0.5 shrink-0">
                        <button
                          type="button"
                          onClick={() =>
                            onUpdateMaskLayer(m.id, (p) => ({ ...p, enabled: !p.enabled }), true)
                          }
                          title={m.enabled ? 'Disable mask' : 'Enable mask'}
                          className="rounded p-1 text-zinc-400 hover:bg-zinc-700 hover:text-white"
                        >
                          {m.enabled ? (
                            <Eye className="w-3 h-3" />
                          ) : (
                            <EyeOff className="w-3 h-3" />
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setRenamingId(m.id);
                            setRenameVal(m.name);
                          }}
                          title="Rename mask"
                          className="rounded p-1 text-zinc-400 hover:bg-zinc-700 hover:text-white"
                        >
                          <Pencil className="w-3 h-3" />
                        </button>
                        <button
                          type="button"
                          onClick={() => onInvertMask(m.id)}
                          title="Invert mask"
                          className="rounded p-1 text-zinc-400 hover:bg-zinc-700 hover:text-white"
                        >
                          <FlipHorizontal className="w-3 h-3" />
                        </button>
                        <button
                          type="button"
                          onClick={() => onDuplicateMask(m.id)}
                          title="Duplicate mask"
                          className="rounded p-1 text-zinc-400 hover:bg-zinc-700 hover:text-white"
                        >
                          <Copy className="w-3 h-3" />
                        </button>
                        <button
                          type="button"
                          onClick={() => onDeleteMask(m.id)}
                          title="Delete mask"
                          className="rounded p-1 text-zinc-400 hover:bg-red-950/70 hover:text-red-300"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Active mask components chips & Add / Subtract / Intersect actions */}
                  {isSelected && (
                    <div className="mt-1.5 pt-1.5 border-t border-white/[0.06] space-y-1.5">
                      <div className="flex flex-wrap gap-1">
                        {m.components.map((c) => (
                          <span
                            key={c.id}
                            className="inline-flex items-center gap-1 rounded bg-zinc-900 px-1.5 py-0.5 text-[10px] text-zinc-300 border border-white/[0.06]"
                          >
                            <span className="text-zinc-500">
                              {c.op === 'add' ? '+' : c.op === 'subtract' ? '-' : '∩'}
                            </span>
                            <span>
                              {c.kind === 'brush'
                                ? 'Brush'
                                : c.kind === 'linear'
                                  ? 'Linear'
                                  : c.kind === 'radial'
                                    ? 'Radial'
                                    : c.kind === 'color-range'
                                      ? 'Color'
                                      : c.kind === 'luminance-range'
                                        ? 'Luma'
                                        : c.label}
                            </span>
                            {c.kind === 'brush' && (
                              <button
                                type="button"
                                onClick={() => {
                                  onUpdateMaskLayer(m.id, (prev) => ({ ...prev, showOverlay: true }));
                                  onSetPointerTool({
                                    mode: 'brush',
                                    op: c.op === 'subtract' ? 'subtract' : 'add',
                                    componentId: c.id,
                                  });
                                }}
                                title="Continue painting this brush stroke"
                                className="text-white hover:underline ml-0.5"
                              >
                                Paint
                              </button>
                            )}
                            {(c.kind === 'linear' || c.kind === 'radial') && (
                              <button
                                type="button"
                                onClick={() => {
                                  onUpdateMaskLayer(m.id, (prev) => ({ ...prev, showOverlay: true }));
                                  onSetPointerTool({ mode: 'edit-handles' });
                                }}
                                title="Show and adjust gradient handles"
                                className="text-white hover:underline ml-0.5"
                              >
                                Handles
                              </button>
                            )}
                            {m.components.length > 1 && (
                              <button
                                type="button"
                                onClick={() => onRemoveComponent(m.id, c.id)}
                                className="text-zinc-500 hover:text-red-300 ml-0.5"
                                title="Remove component"
                              >
                                ×
                              </button>
                            )}
                          </span>
                        ))}
                      </div>

                      <div className="grid grid-cols-5 gap-1">
                        <button
                          type="button"
                          onClick={() => setComposeOp('add')}
                          title="Add selection to mask"
                          className={`flex items-center justify-center gap-0.5 rounded py-1 text-[10px] font-medium border transition-colors ${
                            composeOp === 'add'
                              ? 'border-white bg-white text-zinc-950'
                              : 'border-white/[0.08] bg-zinc-950 text-zinc-300 hover:text-white'
                          }`}
                        >
                          <Plus className="w-2.5 h-2.5" />
                          <span>Add</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => setComposeOp('subtract')}
                          title="Subtract selection from mask"
                          className={`flex items-center justify-center gap-0.5 rounded py-1 text-[10px] font-medium border transition-colors ${
                            composeOp === 'subtract'
                              ? 'border-white bg-white text-zinc-950'
                              : 'border-white/[0.08] bg-zinc-950 text-zinc-300 hover:text-white'
                          }`}
                        >
                          <Minus className="w-2.5 h-2.5" />
                          <span>Subtract</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            if (masks.length > 1) {
                              setShowIntersectPicker((s) => !s);
                            } else {
                              setComposeOp('intersect');
                            }
                          }}
                          title="Intersect mask"
                          className={`flex items-center justify-center gap-0.5 rounded py-1 text-[10px] font-medium border transition-colors ${
                            composeOp === 'intersect' || showIntersectPicker
                              ? 'border-white bg-white text-zinc-950'
                              : 'border-white/[0.08] bg-zinc-950 text-zinc-300 hover:text-white'
                          }`}
                        >
                          <Sparkles className="w-2.5 h-2.5" />
                          <span>Intersect</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => onInvertMask(m.id)}
                          title="Invert mask selection"
                          className={`flex items-center justify-center gap-0.5 rounded py-1 text-[10px] font-medium border transition-colors ${
                            m.inverted
                              ? 'border-white bg-white text-zinc-950'
                              : 'border-white/[0.08] bg-zinc-950 text-zinc-300 hover:text-white'
                          }`}
                        >
                          <FlipHorizontal className="w-2.5 h-2.5" />
                          <span>Invert</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => onDeleteMask(m.id)}
                          title="Delete active mask"
                          className="flex items-center justify-center gap-0.5 rounded py-1 text-[10px] font-medium border border-white/[0.08] bg-zinc-950 text-zinc-300 hover:border-red-500/50 hover:bg-red-950/60 hover:text-red-200 transition-colors"
                        >
                          <Trash2 className="w-2.5 h-2.5" />
                          <span>Delete</span>
                        </button>
                      </div>

                      {showIntersectPicker && masks.length > 1 && (
                        <div className="rounded border border-white/15 bg-zinc-950 p-1.5 space-y-1">
                          <div className="text-[10px] text-zinc-400">
                            Intersect with existing mask or pick new tool:
                          </div>
                          <div className="flex flex-wrap gap-1">
                            {masks
                              .filter((other) => other.id !== m.id)
                              .map((other) => (
                                <button
                                  key={other.id}
                                  type="button"
                                  onClick={() => {
                                    onIntersectWithMask(m.id, other.id);
                                    setShowIntersectPicker(false);
                                  }}
                                  className="rounded bg-zinc-800 px-2 py-0.5 text-[10px] text-zinc-200 hover:bg-zinc-700"
                                >
                                  ∩ {other.name}
                                </button>
                              ))}
                            <button
                              type="button"
                              onClick={() => {
                                setComposeOp('intersect');
                                setShowIntersectPicker(false);
                              }}
                              className="rounded border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-300 hover:text-white"
                            >
                              New Tool ∩
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Active Mask Controls & Refinement */}
      {activeMask && (
        <>
          {/* Brush Controls (when Brush active) */}
          {pointerTool.mode === 'brush' && (
            <div className="border-t border-white/[0.07] pt-2.5 space-y-0.5">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-semibold text-zinc-200">Brush Mask Settings</span>
                <button
                  type="button"
                  onClick={() => {
                    onSetPointerTool({ mode: 'idle' });
                    onUpdateMaskLayer(
                      activeMask.id,
                      (prev) => ({ ...prev, showOverlay: false }),
                      false
                    );
                  }}
                  className="text-[11px] text-zinc-400 hover:text-white underline"
                >
                  Done Painting
                </button>
              </div>
              <StudioSlider
                label="Brush Size"
                value={brushSettings.size}
                min={8}
                max={200}
                unit="px"
                onChange={(v) => onUpdateBrushSettings({ size: v })}
                onReset={() => onUpdateBrushSettings({ size: 56 })}
              />
              <StudioSlider
                label="Brush Feather"
                value={brushSettings.feather}
                min={0}
                max={100}
                unit="%"
                onChange={(v) => onUpdateBrushSettings({ feather: v })}
                onReset={() => onUpdateBrushSettings({ feather: 60 })}
              />
              <StudioSlider
                label="Flow"
                value={brushSettings.flow}
                min={5}
                max={100}
                unit="%"
                onChange={(v) => onUpdateBrushSettings({ flow: v })}
                onReset={() => onUpdateBrushSettings({ flow: 100 })}
              />
              <StudioSlider
                label="Brush Density"
                value={brushSettings.density}
                min={5}
                max={100}
                unit="%"
                onChange={(v) => onUpdateBrushSettings({ density: v })}
                onReset={() => onUpdateBrushSettings({ density: 100 })}
              />
            </div>
          )}

          {/* Color Range Controls */}
          {activeColorRange && activeColorRange.kind === 'color-range' && (
            <div className="border-t border-white/[0.07] pt-2.5 space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-zinc-200">Color Range</span>
                <button
                  type="button"
                  onClick={() =>
                    onSetPointerTool({ mode: 'pick-color', componentId: activeColorRange.id })
                  }
                  className={`flex items-center gap-1 rounded px-2 py-1 text-[10px] font-medium border ${
                    pointerTool.mode === 'pick-color'
                      ? 'border-white bg-white text-zinc-950'
                      : 'border-zinc-700 bg-zinc-900 text-zinc-200 hover:text-white'
                  }`}
                >
                  <Pipette className="w-3 h-3" />
                  <span>Sample on Photo</span>
                </button>
              </div>
              <StudioSlider
                label="Tolerance"
                value={activeColorRange.tolerance}
                min={1}
                max={100}
                unit="%"
                onChange={(v) =>
                  onUpdateMaskLayer(activeMask.id, (prev) => ({
                    ...prev,
                    components: prev.components.map((c) =>
                      c.id === activeColorRange.id && c.kind === 'color-range'
                        ? { ...c, tolerance: v }
                        : c
                    ),
                  }))
                }
                onCommit={() => onUpdateMaskLayer(activeMask.id, (p) => p, true)}
              />
              <StudioSlider
                label="Smoothness"
                value={activeColorRange.smoothness}
                min={0}
                max={100}
                unit="%"
                onChange={(v) =>
                  onUpdateMaskLayer(activeMask.id, (prev) => ({
                    ...prev,
                    components: prev.components.map((c) =>
                      c.id === activeColorRange.id && c.kind === 'color-range'
                        ? { ...c, smoothness: v }
                        : c
                    ),
                  }))
                }
                onCommit={() => onUpdateMaskLayer(activeMask.id, (p) => p, true)}
              />
            </div>
          )}

          {/* Luminance Range Controls */}
          {activeLumaRange && activeLumaRange.kind === 'luminance-range' && (
            <div className="border-t border-white/[0.07] pt-2.5 space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-zinc-200">Luminance Range</span>
                <button
                  type="button"
                  onClick={() =>
                    onSetPointerTool({ mode: 'pick-luminance', componentId: activeLumaRange.id })
                  }
                  className={`flex items-center gap-1 rounded px-2 py-1 text-[10px] font-medium border ${
                    pointerTool.mode === 'pick-luminance'
                      ? 'border-white bg-white text-zinc-950'
                      : 'border-zinc-700 bg-zinc-900 text-zinc-200 hover:text-white'
                  }`}
                >
                  <Pipette className="w-3 h-3" />
                  <span>Sample Tone</span>
                </button>
              </div>
              <StudioSlider
                label="Min Luminance"
                value={activeLumaRange.minLum}
                min={0}
                max={100}
                unit="%"
                onChange={(v) =>
                  onUpdateMaskLayer(activeMask.id, (prev) => ({
                    ...prev,
                    components: prev.components.map((c) =>
                      c.id === activeLumaRange.id && c.kind === 'luminance-range'
                        ? { ...c, minLum: v }
                        : c
                    ),
                  }))
                }
                onCommit={() => onUpdateMaskLayer(activeMask.id, (p) => p, true)}
              />
              <StudioSlider
                label="Max Luminance"
                value={activeLumaRange.maxLum}
                min={0}
                max={100}
                unit="%"
                onChange={(v) =>
                  onUpdateMaskLayer(activeMask.id, (prev) => ({
                    ...prev,
                    components: prev.components.map((c) =>
                      c.id === activeLumaRange.id && c.kind === 'luminance-range'
                        ? { ...c, maxLum: v }
                        : c
                    ),
                  }))
                }
                onCommit={() => onUpdateMaskLayer(activeMask.id, (p) => p, true)}
              />
              <StudioSlider
                label="Range Smoothness"
                value={activeLumaRange.smoothness}
                min={0}
                max={100}
                unit="%"
                onChange={(v) =>
                  onUpdateMaskLayer(activeMask.id, (prev) => ({
                    ...prev,
                    components: prev.components.map((c) =>
                      c.id === activeLumaRange.id && c.kind === 'luminance-range'
                        ? { ...c, smoothness: v }
                        : c
                    ),
                  }))
                }
                onCommit={() => onUpdateMaskLayer(activeMask.id, (p) => p, true)}
              />
            </div>
          )}

          {/* Radial Gradient Feather */}
          {activeRadial && activeRadial.kind === 'radial' && (
            <div className="border-t border-white/[0.07] pt-2.5">
              <StudioSlider
                label="Radial Feather"
                value={activeRadial.feather}
                min={0}
                max={100}
                unit="%"
                onChange={(v) =>
                  onUpdateMaskLayer(activeMask.id, (prev) => ({
                    ...prev,
                    components: prev.components.map((c) =>
                      c.id === activeRadial.id && c.kind === 'radial'
                        ? { ...c, feather: v }
                        : c
                    ),
                  }))
                }
                onCommit={() => onUpdateMaskLayer(activeMask.id, (p) => p, true)}
              />
            </div>
          )}

          {/* Mask Controls (Feather, Density, Edge Refinement, Overlay Color) */}
          <div className="border-t border-white/[0.07] pt-2.5 space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-zinc-200">Mask Refinement</span>
              <div className="flex items-center gap-1">
                {OVERLAY_SWATCHES.map((col) => (
                  <button
                    key={col}
                    type="button"
                    onClick={() =>
                      onUpdateMaskLayer(
                        activeMask.id,
                        (prev) => ({ ...prev, overlayColor: col }),
                        true
                      )
                    }
                    title={`Overlay color ${col}`}
                    className={`h-4 w-4 rounded-full border ${
                      activeMask.overlayColor === col ? 'border-white scale-110' : 'border-white/25'
                    }`}
                    style={{ backgroundColor: col }}
                  />
                ))}
              </div>
            </div>

            <StudioSlider
              label="Mask Feather"
              value={activeMask.feather}
              min={0}
              max={100}
              unit="%"
              onChange={(v) =>
                onUpdateMaskLayer(activeMask.id, (prev) => ({ ...prev, feather: v }))
              }
              onCommit={() => onUpdateMaskLayer(activeMask.id, (p) => p, true)}
              onReset={() =>
                onUpdateMaskLayer(activeMask.id, (prev) => ({ ...prev, feather: 0 }), true)
              }
            />
            <StudioSlider
              label="Mask Density"
              value={activeMask.density}
              min={0}
              max={100}
              unit="%"
              onChange={(v) =>
                onUpdateMaskLayer(activeMask.id, (prev) => ({ ...prev, density: v }))
              }
              onCommit={() => onUpdateMaskLayer(activeMask.id, (p) => p, true)}
              onReset={() =>
                onUpdateMaskLayer(activeMask.id, (prev) => ({ ...prev, density: 100 }), true)
              }
            />
            <StudioSlider
              label="Edge Refinement"
              value={activeMask.edgeRefinement}
              min={0}
              max={100}
              unit="%"
              onChange={(v) =>
                onUpdateMaskLayer(activeMask.id, (prev) => ({ ...prev, edgeRefinement: v }))
              }
              onCommit={() => onUpdateMaskLayer(activeMask.id, (p) => p, true)}
              onReset={() =>
                onUpdateMaskLayer(
                  activeMask.id,
                  (prev) => ({ ...prev, edgeRefinement: 15 }),
                  true
                )
              }
            />
          </div>

          {/* 15 Local Mask Adjustments */}
          <div className="border-t border-white/[0.07] pt-2.5 space-y-0.5">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-semibold text-zinc-200">
                Local Mask Adjustments
              </span>
              <button
                type="button"
                onClick={() => resetLocalAdj()}
                className="text-[11px] text-zinc-400 hover:text-white"
              >
                Reset Local
              </button>
            </div>

            <StudioSlider
              label="Exposure"
              value={activeMask.adjustments.exposure}
              onChange={(v) => updateLocalAdj('exposure', v)}
              onCommit={() => onUpdateMaskLayer(activeMask.id, (p) => p, true)}
              onReset={() => resetLocalAdj('exposure')}
            />
            <StudioSlider
              label="Brightness"
              value={activeMask.adjustments.brightness}
              onChange={(v) => updateLocalAdj('brightness', v)}
              onCommit={() => onUpdateMaskLayer(activeMask.id, (p) => p, true)}
              onReset={() => resetLocalAdj('brightness')}
            />
            <StudioSlider
              label="Contrast"
              value={activeMask.adjustments.contrast}
              onChange={(v) => updateLocalAdj('contrast', v)}
              onCommit={() => onUpdateMaskLayer(activeMask.id, (p) => p, true)}
              onReset={() => resetLocalAdj('contrast')}
            />
            <StudioSlider
              label="Highlights"
              value={activeMask.adjustments.highlights}
              onChange={(v) => updateLocalAdj('highlights', v)}
              onCommit={() => onUpdateMaskLayer(activeMask.id, (p) => p, true)}
              onReset={() => resetLocalAdj('highlights')}
            />
            <StudioSlider
              label="Shadows"
              value={activeMask.adjustments.shadows}
              onChange={(v) => updateLocalAdj('shadows', v)}
              onCommit={() => onUpdateMaskLayer(activeMask.id, (p) => p, true)}
              onReset={() => resetLocalAdj('shadows')}
            />
            <StudioSlider
              label="Whites"
              value={activeMask.adjustments.whites}
              onChange={(v) => updateLocalAdj('whites', v)}
              onCommit={() => onUpdateMaskLayer(activeMask.id, (p) => p, true)}
              onReset={() => resetLocalAdj('whites')}
            />
            <StudioSlider
              label="Blacks"
              value={activeMask.adjustments.blacks}
              onChange={(v) => updateLocalAdj('blacks', v)}
              onCommit={() => onUpdateMaskLayer(activeMask.id, (p) => p, true)}
              onReset={() => resetLocalAdj('blacks')}
            />
            <StudioSlider
              label="Temperature"
              value={activeMask.adjustments.temperature}
              gradientTrack="linear-gradient(to right, #3b82f6, #52525b 50%, #f59e0b)"
              onChange={(v) => updateLocalAdj('temperature', v)}
              onCommit={() => onUpdateMaskLayer(activeMask.id, (p) => p, true)}
              onReset={() => resetLocalAdj('temperature')}
            />
            <StudioSlider
              label="Tint"
              value={activeMask.adjustments.tint}
              gradientTrack="linear-gradient(to right, #22c55e, #52525b 50%, #d946ef)"
              onChange={(v) => updateLocalAdj('tint', v)}
              onCommit={() => onUpdateMaskLayer(activeMask.id, (p) => p, true)}
              onReset={() => resetLocalAdj('tint')}
            />
            <StudioSlider
              label="Saturation"
              value={activeMask.adjustments.saturation}
              onChange={(v) => updateLocalAdj('saturation', v)}
              onCommit={() => onUpdateMaskLayer(activeMask.id, (p) => p, true)}
              onReset={() => resetLocalAdj('saturation')}
            />
            <StudioSlider
              label="Texture"
              value={activeMask.adjustments.texture}
              onChange={(v) => updateLocalAdj('texture', v)}
              onCommit={() => onUpdateMaskLayer(activeMask.id, (p) => p, true)}
              onReset={() => resetLocalAdj('texture')}
            />
            <StudioSlider
              label="Clarity"
              value={activeMask.adjustments.clarity}
              onChange={(v) => updateLocalAdj('clarity', v)}
              onCommit={() => onUpdateMaskLayer(activeMask.id, (p) => p, true)}
              onReset={() => resetLocalAdj('clarity')}
            />
            <StudioSlider
              label="Dehaze"
              value={activeMask.adjustments.dehaze}
              onChange={(v) => updateLocalAdj('dehaze', v)}
              onCommit={() => onUpdateMaskLayer(activeMask.id, (p) => p, true)}
              onReset={() => resetLocalAdj('dehaze')}
            />
            <StudioSlider
              label="Sharpness"
              value={activeMask.adjustments.sharpness}
              min={0}
              max={100}
              onChange={(v) => updateLocalAdj('sharpness', v)}
              onCommit={() => onUpdateMaskLayer(activeMask.id, (p) => p, true)}
              onReset={() => resetLocalAdj('sharpness')}
            />
            <StudioSlider
              label="Noise Reduction"
              value={activeMask.adjustments.noiseReduction}
              min={0}
              max={100}
              onChange={(v) => updateLocalAdj('noiseReduction', v)}
              onCommit={() => onUpdateMaskLayer(activeMask.id, (p) => p, true)}
              onReset={() => resetLocalAdj('noiseReduction')}
            />
          </div>
        </>
      )}
    </div>
  );
};

export const MaskingPanel = memo(MaskingPanelComponent);
