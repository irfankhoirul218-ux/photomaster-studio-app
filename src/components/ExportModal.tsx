import React, { useState } from 'react';
import { Download, X, Loader2 } from 'lucide-react';
import { exportEditedImage, getOutputDimensions } from '../engine/imageProcessor';
import {
  BackgroundSettings,
  BgRefinementSettings,
  EditState,
  LoadedImageMeta,
  MaskLayer,
  RetouchOperation,
} from '../types/editor';

interface ExportModalProps {
  sourceImage: HTMLImageElement;
  imageMeta: LoadedImageMeta;
  editState: EditState;
  hasTransparency: boolean;
  retouchCanvas: HTMLCanvasElement | null;
  alphaCanvas: HTMLCanvasElement | null;
  bgSettings: BackgroundSettings;
  bgImage: HTMLImageElement | null;
  bgRefinement?: BgRefinementSettings;
  hasRetouchEdits: boolean;
  retouchOps?: RetouchOperation[];
  maskLayers?: MaskLayer[];
  onClose: () => void;
}

export const ExportModal: React.FC<ExportModalProps> = ({
  sourceImage,
  imageMeta,
  editState,
  hasTransparency,
  retouchCanvas,
  alphaCanvas,
  bgSettings,
  bgImage,
  bgRefinement,
  hasRetouchEdits,
  retouchOps,
  maskLayers,
  onClose,
}) => {
  const needsTransparentPng = hasTransparency && bgSettings.mode === 'transparent';
  const [format, setFormat] = useState<'jpeg' | 'png'>(needsTransparentPng ? 'png' : 'jpeg');
  const [quality, setQuality] = useState<number>(92);
  const [isExporting, setIsExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const baseName = imageMeta.name.replace(/\.[^.]+$/, '') || 'photomaster-edit';
  const [fileName, setFileName] = useState(`${baseName}-edited`);

  const outputDims = getOutputDimensions(
    sourceImage.naturalWidth,
    sourceImage.naturalHeight,
    editState.transform
  );

  const handleDownload = async () => {
    setIsExporting(true);
    setError(null);
    await new Promise((r) => setTimeout(r, 30));

    try {
      const { blob } = await exportEditedImage(sourceImage, editState, format, quality, {
        retouchCanvas,
        alphaCanvas,
        bgSettings,
        bgImage,
        bgRefinement,
        hasRetouchEdits,
        retouchOps,
        maskLayers,
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      const ext = format === 'png' ? 'png' : 'jpg';
      link.href = url;
      link.download = `${fileName.trim() || 'photomaster-edit'}.${ext}`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="export-dialog-title"
    >
      <div className="w-full max-w-md rounded-xl border border-zinc-800 bg-[#111114] shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between border-b border-white/[0.08] px-5 py-4">
          <h2 id="export-dialog-title" className="text-base font-semibold text-white">
            Export Photo
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-white transition-colors"
            aria-label="Close export modal"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-5">
          {/* File Name */}
          <div>
            <label className="block text-xs font-medium text-zinc-400 mb-1.5">
              File Name
            </label>
            <div className="flex items-center rounded-lg border border-zinc-700 bg-zinc-950 px-3 focus-within:border-white">
              <input
                type="text"
                value={fileName}
                onChange={(e) => setFileName(e.target.value)}
                className="w-full bg-transparent py-2 text-sm text-white focus:outline-none"
              />
              <span className="font-mono-tabular text-xs text-zinc-500 pl-2">
                .{format === 'png' ? 'png' : 'jpg'}
              </span>
            </div>
          </div>

          {/* Format Selector */}
          <div>
            <span className="block text-xs font-medium text-zinc-400 mb-1.5">Format</span>
            <div className="grid grid-cols-2 gap-2 p-1 rounded-lg bg-zinc-950 border border-white/[0.06]">
              <button
                type="button"
                onClick={() => setFormat('jpeg')}
                className={`rounded-md py-2 text-xs font-semibold transition-colors ${
                  format === 'jpeg'
                    ? 'bg-white text-zinc-950 shadow-sm'
                    : 'text-zinc-400 hover:text-white'
                }`}
              >
                JPG (High Efficiency)
              </button>
              <button
                type="button"
                onClick={() => setFormat('png')}
                className={`rounded-md py-2 text-xs font-semibold transition-colors ${
                  format === 'png'
                    ? 'bg-white text-zinc-950 shadow-sm'
                    : 'text-zinc-400 hover:text-white'
                }`}
              >
                PNG {needsTransparentPng ? '(Transparent)' : '(Lossless)'}
              </button>
            </div>
          </div>

          {/* Quality Slider (for JPG) */}
          {format === 'jpeg' ? (
            <div className="space-y-2">
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs font-medium text-zinc-400">JPG Quality</span>
                  <span className="font-mono-tabular text-xs font-semibold text-white">
                    {quality}%
                  </span>
                </div>
                <input
                  type="range"
                  min={10}
                  max={100}
                  step={1}
                  value={quality}
                  onChange={(e) => setQuality(Number(e.target.value))}
                  className="studio-slider"
                  style={{
                    background: `linear-gradient(to right, rgba(255,255,255,0.85) 0%, rgba(255,255,255,0.85) ${
                      ((quality - 10) / 90) * 100
                    }%, rgba(255,255,255,0.14) ${((quality - 10) / 90) * 100}%, rgba(255,255,255,0.14) 100%)`,
                    height: '3px',
                    borderRadius: '9999px',
                  }}
                />
                <div className="flex justify-between text-[11px] text-zinc-500 mt-1">
                  <span>Smaller file</span>
                  <span>Maximum detail</span>
                </div>
              </div>
              {needsTransparentPng && (
                <div className="rounded-lg border border-amber-500/30 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
                  JPG does not support transparency. Switch to PNG to preserve your transparent cutout.
                </div>
              )}
            </div>
          ) : (
            <div className="rounded-lg border border-white/[0.06] bg-zinc-950 px-3 py-2.5 text-xs text-zinc-400">
              {needsTransparentPng
                ? 'PNG exports with full alpha transparency preserved at native resolution.'
                : 'PNG exports with zero compression artifacts at full native bit-depth.'}
            </div>
          )}

          {/* Output Resolution Readout */}
          <div className="flex items-center justify-between border-t border-white/[0.06] pt-4 text-xs">
            <span className="text-zinc-400">Output Resolution</span>
            <span className="font-mono-tabular font-medium text-zinc-200">
              {outputDims.width} × {outputDims.height} px
            </span>
          </div>

          {error && (
            <div className="rounded-lg border border-red-500/30 bg-red-950/40 px-3 py-2 text-xs text-red-200">
              {error}
            </div>
          )}

          <div className="flex items-center justify-end gap-2.5 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-zinc-700 px-4 py-2 text-xs font-medium text-zinc-300 hover:bg-zinc-800 hover:text-white transition-colors min-h-[40px]"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleDownload}
              disabled={isExporting}
              className="flex items-center gap-2 rounded-lg bg-white px-5 py-2 text-xs font-semibold text-zinc-950 hover:bg-zinc-200 disabled:opacity-60 transition-colors min-h-[40px]"
            >
              {isExporting ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Rendering Full Res...
                </>
              ) : (
                <>
                  <Download className="w-3.5 h-3.5" />
                  Download {format.toUpperCase()}
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
