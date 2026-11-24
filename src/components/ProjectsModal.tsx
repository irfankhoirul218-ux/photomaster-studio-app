import React from 'react';
import { AlertTriangle, HardDrive, Loader2, Upload, X } from 'lucide-react';
import { SavedProjectSummary, StorageQuotaStatus } from '../types/editor';
import { formatStorageBytes } from '../engine/projectStorage';
import { SavedProjectCard } from './SavedProjectCard';

interface ProjectsModalProps {
  projects: SavedProjectSummary[];
  activeProjectId: string | null;
  storageQuota: StorageQuotaStatus | null;
  isLoadingProjects: boolean;
  openingProjectId: string | null;
  errorMessage: string | null;
  onOpenProject: (projectId: string) => void;
  onRenameProject: (projectId: string, newName: string) => Promise<void>;
  onDuplicateProject: (projectId: string) => Promise<void>;
  onDeleteProject: (projectId: string) => Promise<void>;
  onNewPhoto: () => void;
  onClose: () => void;
}

export const ProjectsModal: React.FC<ProjectsModalProps> = ({
  projects,
  activeProjectId,
  storageQuota,
  isLoadingProjects,
  openingProjectId,
  errorMessage,
  onOpenProject,
  onRenameProject,
  onDuplicateProject,
  onDeleteProject,
  onNewPhoto,
  onClose,
}) => {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="projects-modal-title"
    >
      <div className="flex max-h-[88vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-zinc-800 bg-[#111114] shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/[0.08] px-5 py-4">
          <div>
            <h2 id="projects-modal-title" className="text-base font-semibold text-white">
              Saved Projects
            </h2>
            <p className="mt-0.5 text-xs text-zinc-400">
              Stored locally in browser IndexedDB · Original photos, masks, retouching, and settings stay private on this device
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onNewPhoto}
              className="flex items-center gap-1.5 rounded-lg bg-white px-3.5 py-2 text-xs font-semibold text-zinc-950 hover:bg-zinc-200 transition-colors min-h-[36px]"
            >
              <Upload className="h-3.5 w-3.5" />
              <span>Open New Photo</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close projects manager"
              className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-white transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Storage Quota & Warnings */}
        <div className="border-b border-white/[0.06] bg-zinc-950/60 px-5 py-3 space-y-2.5">
          {storageQuota?.supported && (
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
              <div className="flex items-center gap-2 text-zinc-300">
                <HardDrive className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
                <span>
                  Local Storage: {formatStorageBytes(storageQuota.usageBytes)} used of{' '}
                  {formatStorageBytes(storageQuota.quotaBytes)} ({storageQuota.percentUsed.toFixed(1)}%)
                </span>
              </div>
              <div className="h-1.5 w-full sm:w-48 overflow-hidden rounded-full bg-zinc-800">
                <div
                  className={`h-full transition-all ${
                    storageQuota.isNearLimit ? 'bg-amber-400' : 'bg-white'
                  }`}
                  style={{ width: `${Math.max(2, Math.min(100, storageQuota.percentUsed))}%` }}
                />
              </div>
            </div>
          )}

          {storageQuota?.isNearLimit && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/35 bg-amber-950/35 px-3 py-2 text-xs text-amber-200">
              <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400 mt-0.5" />
              <span>
                Local browser storage is nearly full ({formatStorageBytes(storageQuota.remainingBytes)}{' '}
                remaining). Delete old projects or export finished photos to prevent save failures.
              </span>
            </div>
          )}

          {errorMessage && (
            <div className="rounded-lg border border-red-500/35 bg-red-950/40 px-3 py-2 text-xs text-red-200">
              {errorMessage}
            </div>
          )}
        </div>

        {/* Project Grid */}
        <div className="flex-1 overflow-y-auto p-5 studio-scroll">
          {isLoadingProjects ? (
            <div className="flex h-48 items-center justify-center gap-2 text-xs text-zinc-400">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Loading local projects from IndexedDB...</span>
            </div>
          ) : projects.length === 0 ? (
            <div className="flex h-48 flex-col items-center justify-center text-center">
              <p className="text-sm font-medium text-zinc-300">No saved projects yet</p>
              <p className="mt-1 max-w-sm text-xs text-zinc-500">
                Open any photo to create a project automatically. Every edit is saved locally in your browser.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {projects.map((proj) => (
                <SavedProjectCard
                  key={proj.id}
                  project={proj}
                  isActive={proj.id === activeProjectId}
                  isOpening={openingProjectId === proj.id}
                  onOpen={onOpenProject}
                  onRename={onRenameProject}
                  onDuplicate={onDuplicateProject}
                  onDelete={onDeleteProject}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
