import React, { memo, useEffect, useRef, useState } from 'react';
import {
  Check,
  Download,
  FileUp,
  Pencil,
  Plus,
  Trash2,
  X,
  AlertCircle,
} from 'lucide-react';
import { BUILT_IN_PRESETS } from '../data/presets';
import { applyAdjustmentsToCanvas, renderGeometryCanvas } from '../engine/imageProcessor';
import { exportPresetToJsonString, parsePresetFile } from '../engine/presetParser';
import {
  Adjustments,
  DEFAULT_ADJUSTMENTS,
  Preset,
  PresetCategory,
  TransformState,
} from '../types/editor';
import { StudioSlider } from './StudioSlider';

interface PresetStripProps {
  sourceImage: HTMLImageElement | null;
  transform: TransformState;
  currentAdjustments: Adjustments;
  activePresetId: string | null;
  customPresets: Preset[];
  onApplyPreset: (preset: Preset) => void;
  onSaveCustomPreset: (
    name: string,
    category?: Exclude<PresetCategory, 'All' | 'My Presets'>
  ) => void;
  onImportPreset: (preset: Preset) => void;
  onRenameCustomPreset: (id: string, newName: string) => void;
  onDeleteCustomPreset: (id: string) => void;
  onLutIntensityChange: (intensity: number) => void;
  onLutIntensityCommit: () => void;
  onClearLut: () => void;
  compactHorizontal?: boolean;
}

const PRESET_CATEGORIES: PresetCategory[] = [
  'All',
  'My Presets',
  'Landscape',
  'Portrait',
  'Cinematic',
  'Monochrome',
  'Vintage',
];

const SAVE_CATEGORY_OPTIONS: Exclude<PresetCategory, 'All' | 'My Presets'>[] = [
  'Landscape',
  'Portrait',
  'Cinematic',
  'Monochrome',
  'Vintage',
];

function formatBadgeLabel(preset: Preset): string {
  switch (preset.sourceFormat) {
    case 'xmp':
      return 'XMP';
    case 'cube':
      return 'CUBE LUT';
    case 'lrtemplate':
      return 'LRT';
    case 'json':
      return 'JSON';
    default:
      return 'Saved';
  }
}

function triggerJsonDownload(preset: Preset) {
  const json = exportPresetToJsonString(preset);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const safeName = preset.name
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '');
  a.href = url;
  a.download = `${safeName || 'photomaster-preset'}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const PresetStripComponent: React.FC<PresetStripProps> = ({
  sourceImage,
  transform,
  currentAdjustments,
  activePresetId,
  customPresets,
  onApplyPreset,
  onSaveCustomPreset,
  onImportPreset,
  onRenameCustomPreset,
  onDeleteCustomPreset,
  onLutIntensityChange,
  onLutIntensityCommit,
  onClearLut,
  compactHorizontal = false,
}) => {
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const [selectedCategory, setSelectedCategory] = useState<PresetCategory>('All');
  const [isSaving, setIsSaving] = useState(false);
  const [presetName, setPresetName] = useState('');
  const [saveCategory, setSaveCategory] = useState<
    Exclude<PresetCategory, 'All' | 'My Presets'> | ''
  >('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [importError, setImportError] = useState<string | null>(null);
  const [importNotice, setImportNotice] = useState<string | null>(null);
  const [isParsing, setIsParsing] = useState(false);

  const importInputRef = useRef<HTMLInputElement>(null);

  const allPresets = [...customPresets, ...BUILT_IN_PRESETS];
  const filteredCustomPresets = customPresets.filter((p) => {
    if (selectedCategory === 'All' || selectedCategory === 'My Presets') return true;
    return p.category === selectedCategory;
  });
  const filteredBuiltInPresets =
    selectedCategory === 'My Presets'
      ? []
      : BUILT_IN_PRESETS.filter((p) => {
          if (selectedCategory === 'All') return true;
          return p.category === selectedCategory;
        });

  // Key string to re-render thumbnails when custom presets list changes (added, renamed, or imported)
  const customPresetSignature = customPresets.map((p) => p.id).join(',');

  // Generate real mini canvas thumbnails incrementally across animation frames to keep UI responsive
  useEffect(() => {
    if (!sourceImage) {
      setThumbnails({});
      return;
    }

    let cancelled = false;
    let rafId: number | null = null;
    const baseCanvas = renderGeometryCanvas(sourceImage, transform, 120, true);
    const thumbCanvas = document.createElement('canvas');
    thumbCanvas.width = baseCanvas.width;
    thumbCanvas.height = baseCanvas.height;
    const ctx = thumbCanvas.getContext('2d');
    const queue = [...customPresets, ...BUILT_IN_PRESETS];
    let index = 0;
    const CHUNK_SIZE = 3;

    setThumbnails({});

    const processChunk = () => {
      if (cancelled || !ctx) {
        thumbCanvas.width = 0;
        thumbCanvas.height = 0;
        return;
      }

      const end = Math.min(queue.length, index + CHUNK_SIZE);
      const batch: Record<string, string> = {};
      for (; index < end; index++) {
        const preset = queue[index];
        ctx.clearRect(0, 0, thumbCanvas.width, thumbCanvas.height);
        ctx.drawImage(baseCanvas, 0, 0);
        const merged: Adjustments = { ...DEFAULT_ADJUSTMENTS, ...preset.adjustments };
        applyAdjustmentsToCanvas(thumbCanvas, merged, false);
        batch[preset.id] = thumbCanvas.toDataURL('image/jpeg', 0.76);
      }

      if (!cancelled && Object.keys(batch).length > 0) {
        setThumbnails((prev) => ({ ...prev, ...batch }));
      }

      if (!cancelled && index < queue.length) {
        rafId = requestAnimationFrame(processChunk);
      } else {
        thumbCanvas.width = 0;
        thumbCanvas.height = 0;
      }
    };

    const timer = window.setTimeout(() => {
      if (!cancelled) {
        rafId = requestAnimationFrame(processChunk);
      }
    }, 50);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      if (rafId !== null) cancelAnimationFrame(rafId);
      thumbCanvas.width = 0;
      thumbCanvas.height = 0;
    };
  }, [sourceImage, transform.rotate90, transform.flipH, transform.flipV, customPresetSignature]);

  const handleSaveSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = presetName.trim();
    if (!trimmed) return;
    onSaveCustomPreset(trimmed, saveCategory || undefined);
    setPresetName('');
    setSaveCategory('');
    setIsSaving(false);
  };

  const handleRenameSubmit = (e: React.FormEvent, id: string) => {
    e.preventDefault();
    const trimmed = renameValue.trim();
    if (!trimmed) return;
    onRenameCustomPreset(id, trimmed);
    setRenamingId(null);
    setRenameValue('');
  };

  const handlePresetFilesSelected = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setImportError(null);
    setImportNotice(null);
    setIsParsing(true);

    const importedNames: string[] = [];
    const warningList: string[] = [];
    const errorList: string[] = [];

    for (const file of Array.from(files)) {
      try {
        const result = await parsePresetFile(file);
        onImportPreset(result.preset);
        importedNames.push(result.preset.name);
        if (result.warnings.length > 0) {
          warningList.push(...result.warnings);
        }
      } catch (err) {
        errorList.push(err instanceof Error ? err.message : `Failed to import ${file.name}.`);
      }
    }

    setIsParsing(false);

    if (errorList.length > 0) {
      setImportError(errorList.join(' '));
    }
    if (importedNames.length > 0) {
      const warnSuffix = warningList.length > 0 ? ` (${warningList[0]})` : '';
      setImportNotice(
        importedNames.length === 1
          ? `Imported & applied "${importedNames[0]}"${warnSuffix}`
          : `Imported ${importedNames.length} presets; applied "${importedNames[importedNames.length - 1]}"`
      );
    }
  };

  const handleExportCurrentAsJson = () => {
    const activeObj = allPresets.find((p) => p.id === activePresetId);
    const presetToExport: Preset = activeObj
      ? { ...activeObj, adjustments: { ...currentAdjustments } }
      : {
          id: `export-${Date.now()}`,
          name: 'PhotoMaster Look',
          sourceFormat: 'custom',
          createdAt: new Date().toISOString(),
          adjustments: { ...currentAdjustments },
        };
    triggerJsonDownload(presetToExport);
  };

  return (
    <div className="space-y-3">
      {/* Hidden Preset File Input */}
      <input
        ref={importInputRef}
        type="file"
        multiple
        accept=".xmp,.cube,.json,.lrtemplate,application/json,text/xml,application/xml"
        className="hidden"
        onChange={(e) => {
          handlePresetFilesSelected(e.target.files);
          e.target.value = '';
        }}
      />

      {/* Action Toolbar: Import Preset · Save · Export */}
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => importInputRef.current?.click()}
          disabled={isParsing}
          title="Import .XMP, .CUBE, .JSON, or .LRTEMPLATE preset"
          className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-white px-2.5 py-1.5 text-xs font-semibold text-zinc-950 hover:bg-zinc-200 disabled:opacity-50 transition-colors min-h-[36px] whitespace-nowrap"
        >
          <FileUp className="w-3.5 h-3.5" />
          <span>{isParsing ? 'Importing...' : 'Import Preset'}</span>
        </button>

        <button
          type="button"
          onClick={() => {
            setIsSaving((s) => !s);
            setImportError(null);
          }}
          title="Save current edits to My Presets"
          className="flex items-center justify-center gap-1 rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-800 hover:text-white transition-colors min-h-[36px] whitespace-nowrap"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>Save</span>
        </button>

        <button
          type="button"
          onClick={handleExportCurrentAsJson}
          title="Export current look as PhotoMaster .JSON preset"
          className="flex items-center justify-center gap-1 rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-800 hover:text-white transition-colors min-h-[36px] whitespace-nowrap"
        >
          <Download className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">Export</span>
        </button>
      </div>

      {/* Supported Formats Micro-Caption */}
      <div className="text-[11px] text-zinc-500 flex items-center justify-between gap-2">
        <span>Supports .XMP · .CUBE · .JSON · .LRTEMPLATE</span>
      </div>

      {/* Preset Category Filter Tabs */}
      <div className="flex gap-1 overflow-x-auto pb-1 studio-scroll">
        {PRESET_CATEGORIES.map((cat) => (
          <button
            key={cat}
            type="button"
            onClick={() => setSelectedCategory(cat)}
            className={`shrink-0 rounded-md px-2 py-1 text-[11px] font-medium transition-colors whitespace-nowrap ${
              selectedCategory === cat
                ? 'bg-white text-zinc-950 font-semibold'
                : 'border border-white/[0.08] bg-zinc-950 text-zinc-400 hover:text-zinc-200'
            }`}
          >
            {cat}
          </button>
        ))}
      </div>

      {/* Error Message for Unsupported / Corrupted Files */}
      {importError && (
        <div
          role="alert"
          className="rounded-lg border border-red-500/40 bg-red-950/45 p-2.5 text-xs text-red-200 flex items-start gap-2"
        >
          <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
          <div className="flex-1 leading-relaxed">{importError}</div>
          <button
            type="button"
            onClick={() => setImportError(null)}
            aria-label="Dismiss error"
            className="rounded p-0.5 text-red-300 hover:bg-red-900/50 hover:text-white"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Success / Import Notice */}
      {importNotice && !importError && (
        <div className="rounded-lg border border-white/15 bg-zinc-900/90 px-2.5 py-2 text-xs text-zinc-200 flex items-center justify-between gap-2">
          <span className="truncate">{importNotice}</span>
          <button
            type="button"
            onClick={() => setImportNotice(null)}
            aria-label="Dismiss notice"
            className="text-zinc-400 hover:text-white shrink-0"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Active 3D LUT Strength Slider (shown whenever a .CUBE LUT is active) */}
      {currentAdjustments.lut && (
        <div className="rounded-lg border border-white/15 bg-[#0b0b0e] p-2.5">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[11px] font-medium text-zinc-300 truncate max-w-[180px]">
              Active LUT{currentAdjustments.lut.title ? `: ${currentAdjustments.lut.title}` : ''}
            </span>
            <button
              type="button"
              onClick={onClearLut}
              className="text-[11px] text-zinc-400 hover:text-white underline"
            >
              Remove LUT
            </button>
          </div>
          <StudioSlider
            label="LUT Intensity"
            value={currentAdjustments.lutIntensity}
            min={0}
            max={100}
            unit="%"
            onChange={onLutIntensityChange}
            onCommit={onLutIntensityCommit}
            onReset={() => {
              onLutIntensityChange(100);
              onLutIntensityCommit();
            }}
          />
        </div>
      )}

      {/* Save Current Look Form */}
      {isSaving && (
        <form
          onSubmit={handleSaveSubmit}
          className="rounded-lg border border-zinc-700/80 bg-[#0b0b0e] p-2.5 space-y-2"
        >
          <label className="block text-[11px] font-medium text-zinc-400">
            Save Current Edits to My Presets
          </label>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={presetName}
              onChange={(e) => setPresetName(e.target.value)}
              placeholder="e.g. Monochrome Contrast"
              maxLength={36}
              autoFocus
              className="flex-1 min-w-0 rounded-md border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-xs text-white placeholder-zinc-600 focus:border-white focus:outline-none"
            />
            <select
              value={saveCategory}
              onChange={(e) =>
                setSaveCategory(
                  e.target.value as Exclude<PresetCategory, 'All' | 'My Presets'> | ''
                )
              }
              aria-label="Preset category"
              className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-[11px] text-zinc-200 focus:border-white focus:outline-none"
            >
              <option value="">No Category</option>
              {SAVE_CATEGORY_OPTIONS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setIsSaving(false);
                setPresetName('');
                setSaveCategory('');
              }}
              className="rounded-md border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-400 hover:text-white transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!presetName.trim()}
              className="rounded-md bg-white px-3 py-1.5 text-xs font-semibold text-zinc-950 hover:bg-zinc-200 disabled:opacity-40 transition-colors"
            >
              Save
            </button>
          </div>
        </form>
      )}

      {/* MY PRESETS PANEL (Imported + User Saved) */}
      {(selectedCategory === 'All' ||
        selectedCategory === 'My Presets' ||
        filteredCustomPresets.length > 0) && (
      <div className="border-t border-white/[0.07] pt-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-semibold text-zinc-200">My Presets</span>
          <span className="font-mono-tabular text-[11px] text-zinc-500">
            {filteredCustomPresets.length}
          </span>
        </div>

        {filteredCustomPresets.length === 0 ? (
          <div className="rounded-lg border border-dashed border-white/[0.1] bg-[#0b0b0e] px-3 py-4 text-center">
            <p className="text-xs text-zinc-400">
              No imported or saved presets yet.
            </p>
            <p className="mt-1 text-[11px] text-zinc-500">
              Import .XMP, .CUBE, .JSON, or .LRTEMPLATE files, or save your own edits.
            </p>
          </div>
        ) : (
          <div
            className={
              compactHorizontal
                ? 'flex gap-2.5 overflow-x-auto pb-2 studio-scroll'
                : 'grid grid-cols-2 gap-2.5'
            }
          >
            {filteredCustomPresets.map((preset) => {
              const isActive = activePresetId === preset.id;
              const isRenaming = renamingId === preset.id;
              return (
                <div
                  key={preset.id}
                  className={`group relative rounded-lg border overflow-hidden transition-colors shrink-0 ${
                    compactHorizontal ? 'w-36' : 'w-full'
                  } ${
                    isActive
                      ? 'border-white bg-zinc-800/80'
                      : 'border-white/[0.08] bg-[#16161a] hover:border-white/30'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => onApplyPreset(preset)}
                    className="w-full text-left focus-visible:outline-none"
                  >
                    <div className="aspect-[4/3] w-full bg-zinc-900 overflow-hidden relative">
                      {thumbnails[preset.id] ? (
                        <img
                          src={thumbnails[preset.id]}
                          alt={preset.name}
                          className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.03]"
                        />
                      ) : (
                        <div className="h-full w-full bg-zinc-900" />
                      )}
                      {isActive && (
                        <span className="absolute top-1.5 left-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-white text-zinc-950 shadow">
                          <Check className="w-3 h-3 stroke-[2.5]" />
                        </span>
                      )}
                    </div>
                  </button>

                  {isRenaming ? (
                    <form
                      onSubmit={(e) => handleRenameSubmit(e, preset.id)}
                      className="p-1.5 space-y-1 bg-zinc-950"
                    >
                      <input
                        type="text"
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        maxLength={36}
                        autoFocus
                        className="w-full rounded border border-zinc-600 bg-zinc-900 px-1.5 py-1 text-[11px] text-white focus:border-white focus:outline-none"
                      />
                      <div className="flex justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => setRenamingId(null)}
                          className="rounded px-1.5 py-0.5 text-[10px] text-zinc-400 hover:text-white"
                        >
                          Cancel
                        </button>
                        <button
                          type="submit"
                          className="rounded bg-white px-2 py-0.5 text-[10px] font-semibold text-zinc-950"
                        >
                          Save
                        </button>
                      </div>
                    </form>
                  ) : (
                    <div className="px-2 py-1.5">
                      <button
                        type="button"
                        onClick={() => onApplyPreset(preset)}
                        className="block w-full text-left truncate text-xs font-medium text-zinc-100"
                        title={preset.name}
                      >
                        {preset.name}
                      </button>
                      <div className="mt-1 flex items-center justify-between gap-1">
                        <span className="text-[10px] text-zinc-500 truncate">
                          {formatBadgeLabel(preset)}
                        </span>
                        <div className="flex items-center gap-0.5 shrink-0">
                          <button
                            type="button"
                            onClick={() => {
                              setRenamingId(preset.id);
                              setRenameValue(preset.name);
                            }}
                            title="Rename preset"
                            aria-label={`Rename ${preset.name}`}
                            className="rounded p-1 text-zinc-400 hover:bg-zinc-700/70 hover:text-white transition-colors"
                          >
                            <Pencil className="w-3 h-3" />
                          </button>
                          <button
                            type="button"
                            onClick={() => triggerJsonDownload(preset)}
                            title="Export preset as .JSON"
                            aria-label={`Export ${preset.name}`}
                            className="rounded p-1 text-zinc-400 hover:bg-zinc-700/70 hover:text-white transition-colors"
                          >
                            <Download className="w-3 h-3" />
                          </button>
                          <button
                            type="button"
                            onClick={() => onDeleteCustomPreset(preset.id)}
                            title="Delete preset"
                            aria-label={`Delete ${preset.name}`}
                            className="rounded p-1 text-zinc-400 hover:bg-red-950/70 hover:text-red-300 transition-colors"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
      )}

      {/* STUDIO BUILT-IN PRESETS */}
      {filteredBuiltInPresets.length > 0 && (
      <div className="border-t border-white/[0.07] pt-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-semibold text-zinc-200">Studio Presets</span>
          <span className="font-mono-tabular text-[11px] text-zinc-500">
            {filteredBuiltInPresets.length}
          </span>
        </div>
        <div
          className={
            compactHorizontal
              ? 'flex gap-2.5 overflow-x-auto pb-2 studio-scroll'
              : 'grid grid-cols-2 gap-2.5'
          }
        >
          {filteredBuiltInPresets.map((preset) => {
            const isActive = activePresetId === preset.id;
            return (
              <button
                key={preset.id}
                type="button"
                onClick={() => onApplyPreset(preset)}
                className={`group text-left rounded-lg border overflow-hidden transition-colors shrink-0 ${
                  compactHorizontal ? 'w-28' : 'w-full'
                } ${
                  isActive
                    ? 'border-white bg-zinc-800/80'
                    : 'border-white/[0.08] bg-[#16161a] hover:border-white/30'
                }`}
              >
                <div className="aspect-[4/3] w-full bg-zinc-900 overflow-hidden relative">
                  {thumbnails[preset.id] ? (
                    <img
                      src={thumbnails[preset.id]}
                      alt={preset.name}
                      className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.03]"
                    />
                  ) : (
                    <div className="h-full w-full bg-zinc-900" />
                  )}
                  {isActive && (
                    <span className="absolute top-1.5 left-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-white text-zinc-950 shadow">
                      <Check className="w-3 h-3 stroke-[2.5]" />
                    </span>
                  )}
                </div>
                <div className="px-2 py-1.5 flex items-center justify-between gap-1">
                  <span className="block truncate text-xs font-medium text-zinc-100">
                    {preset.name}
                  </span>
                  {preset.category && (
                    <span className="shrink-0 text-[9px] text-zinc-500">
                      {preset.category}
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </div>
      )}
    </div>
  );
};

export const PresetStrip = memo(PresetStripComponent);
