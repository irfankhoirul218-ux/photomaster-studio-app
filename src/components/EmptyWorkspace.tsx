import React from 'react';
import { AlertTriangle, HardDrive, ImagePlus, Loader2, Upload } from 'lucide-react';
import { SAMPLE_PHOTOS, SamplePhoto } from '../data/presets';
import { formatStorageBytes } from '../engine/projectStorage';
import { SavedProjectSummary, StorageQuotaStatus } from '../types/editor';
import { SavedProjectCard } from './SavedProjectCard';

interface EmptyWorkspaceProps {
  onTriggerUpload: () => void;
  onSelectSample: (sample: SamplePhoto) => void;
  isDraggingFile: boolean;
  savedProjects: SavedProjectSummary[];
  isLoadingProjects: boolean;
  openingProjectId: string | null;
  storageQuota: StorageQuotaStatus | null;
  storageError: string | null;
  onOpenProject: (projectId: string) => void;
  onRenameProject: (projectId: string, newName: string) => Promise<void>;
  onDuplicateProject: (projectId: string) => Promise<void>;
  onDeleteProject: (projectId: string) => Promise<void>;
}

export const EmptyWorkspace: React.FC<EmptyWorkspaceProps> = ({
  onTriggerUpload,
  onSelectSample,
  isDraggingFile,
  savedProjects,
  isLoadingProjects,
  openingProjectId,
  storageQuota,
  storageError,
  onOpenProject,
  onRenameProject,
  onDuplicateProject,
  onDeleteProject,
}) => {
  return (
    <div className="flex h-full w-full flex-col items-center p-4 sm:p-8 overflow-y-auto studio-scroll">
      <div className="my-auto w-full max-w-4xl space-y-6">
        {/* Primary Upload / Drop Zone */}
        <div
          className={`w-full rounded-2xl border border-dashed p-6 sm:p-8 text-center transition-colors ${
            isDraggingFile
              ? 'border-white bg-zinc-900/80'
              : 'border-zinc-700/80 bg-[#111114]/90 hover:border-zinc-500'
          }`}
        >
          <div className="mx-auto mb-3.5 flex h-12 w-12 items-center justify-center rounded-full border border-white/15 bg-zinc-900 text-white">
            <ImagePlus className="w-5 h-5" />
          </div>

          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-white">
            Open a photo to start editing
          </h1>
          <p className="mx-auto mt-1.5 max-w-md text-sm text-zinc-400 leading-relaxed">
            Drag and drop a JPG, PNG, or WebP image anywhere, or choose a file from your device.
            All edits are auto-saved locally in your browser.
          </p>

          <div className="mt-5 flex justify-center">
            <button
              type="button"
              onClick={onTriggerUpload}
              className="flex items-center gap-2 rounded-lg bg-white px-6 py-2.5 text-sm font-semibold text-zinc-950 hover:bg-zinc-200 transition-colors min-h-[44px] shadow-lg"
            >
              <Upload className="w-4 h-4" />
              <span>Upload from Device</span>
            </button>
          </div>
        </div>

        {/* Storage Alerts */}
        {storageQuota?.isNearLimit && (
          <div className="flex items-start gap-2.5 rounded-xl border border-amber-500/35 bg-amber-950/35 px-4 py-3 text-xs text-amber-200">
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400 mt-0.5" />
            <span>
              Local browser storage is nearly full ({storageQuota.percentUsed.toFixed(1)}% used ·{' '}
              {formatStorageBytes(storageQuota.remainingBytes)} remaining). Consider deleting old projects.
            </span>
          </div>
        )}

        {storageError && (
          <div className="rounded-xl border border-red-500/35 bg-red-950/40 px-4 py-3 text-xs text-red-200">
            {storageError}
          </div>
        )}

        {/* Saved Projects List (Displayed when reopening / refreshing app) */}
        {(isLoadingProjects || savedProjects.length > 0) && (
          <section className="rounded-2xl border border-white/[0.08] bg-[#111114]/90 p-5 sm:p-6">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold text-white">
                  Saved Projects
                </h2>
                <p className="mt-0.5 text-xs text-zinc-400">
                  {savedProjects.length} {savedProjects.length === 1 ? 'project' : 'projects'} saved locally in IndexedDB
                </p>
              </div>
              {storageQuota?.supported && (
                <div className="flex items-center gap-1.5 text-xs text-zinc-400">
                  <HardDrive className="h-3.5 w-3.5" />
                  <span>
                    {formatStorageBytes(storageQuota.usageBytes)} / {formatStorageBytes(storageQuota.quotaBytes)}
                  </span>
                </div>
              )}
            </div>

            {isLoadingProjects ? (
              <div className="flex h-28 items-center justify-center gap-2 text-xs text-zinc-400">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Loading saved projects...</span>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {savedProjects.map((project) => (
                  <SavedProjectCard
                    key={project.id}
                    project={project}
                    isOpening={openingProjectId === project.id}
                    onOpen={onOpenProject}
                    onRename={onRenameProject}
                    onDuplicate={onDuplicateProject}
                    onDelete={onDeleteProject}
                  />
                ))}
              </div>
            )}
          </section>
        )}

        {/* Quick-Start Sample Photos */}
        <section className="rounded-2xl border border-white/[0.08] bg-[#111114]/70 p-5 sm:p-6">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-xs font-medium text-zinc-400">
              Or try with a sample studio photograph
            </span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {SAMPLE_PHOTOS.map((sample) => (
              <button
                key={sample.id}
                type="button"
                onClick={() => onSelectSample(sample)}
                className="group overflow-hidden rounded-xl border border-white/[0.08] bg-[#16161a] text-left hover:border-white/40 transition-colors"
              >
                <div className="aspect-[4/3] w-full overflow-hidden bg-zinc-900">
                  <img
                    src={sample.src}
                    alt={sample.title}
                    className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.04]"
                  />
                </div>
                <div className="px-3 py-2">
                  <div className="text-xs font-medium text-zinc-100 truncate">{sample.title}</div>
                  <div className="text-[11px] text-zinc-500">{sample.category}</div>
                </div>
              </button>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
};
