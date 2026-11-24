import React, { useState } from 'react';
import { Copy, Edit3, FolderOpen, Check, Trash2, X } from 'lucide-react';
import { SavedProjectSummary } from '../types/editor';
import { formatStorageBytes } from '../engine/projectStorage';

interface SavedProjectCardProps {
  project: SavedProjectSummary;
  isActive?: boolean;
  isOpening?: boolean;
  onOpen: (projectId: string) => void;
  onRename: (projectId: string, newName: string) => Promise<void> | void;
  onDuplicate: (projectId: string) => Promise<void> | void;
  onDelete: (projectId: string) => Promise<void> | void;
}

function formatRelativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const diffSec = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (diffSec < 15) return 'Just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return new Date(t).toLocaleDateString();
}

export const SavedProjectCard: React.FC<SavedProjectCardProps> = ({
  project,
  isActive = false,
  isOpening = false,
  onOpen,
  onRename,
  onDuplicate,
  onDelete,
}) => {
  const [isRenaming, setIsRenaming] = useState(false);
  const [draftName, setDraftName] = useState(project.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [isBusy, setIsBusy] = useState(false);

  const handleSaveRename = async () => {
    const clean = draftName.trim();
    if (!clean) return;
    setIsBusy(true);
    try {
      await onRename(project.id, clean);
      setIsRenaming(false);
    } finally {
      setIsBusy(false);
    }
  };

  const handleDuplicate = async () => {
    setIsBusy(true);
    try {
      await onDuplicate(project.id);
    } finally {
      setIsBusy(false);
    }
  };

  const handleDelete = async () => {
    setIsBusy(true);
    try {
      await onDelete(project.id);
      setConfirmDelete(false);
    } finally {
      setIsBusy(false);
    }
  };

  const detailSegments: string[] = [
    `${project.width} × ${project.height}`,
    formatRelativeTime(project.updatedAt),
  ];
  if (project.maskCount > 0) {
    detailSegments.push(`${project.maskCount} Mask${project.maskCount > 1 ? 's' : ''}`);
  }
  if (project.retouchCount > 0) {
    detailSegments.push(`${project.retouchCount} Retouch`);
  }
  if (project.hasTransparency) {
    detailSegments.push('Cutout');
  }
  if (project.activePresetName) {
    detailSegments.push(project.activePresetName);
  }
  if (project.estimatedBytes > 0) {
    detailSegments.push(formatStorageBytes(project.estimatedBytes));
  }

  return (
    <div
      className={`group flex flex-col overflow-hidden rounded-xl border transition-colors bg-[#151519] ${
        isActive
          ? 'border-white/70 ring-1 ring-white/25'
          : 'border-white/[0.08] hover:border-white/25'
      }`}
    >
      {/* Preview Thumbnail */}
      <button
        type="button"
        onClick={() => onOpen(project.id)}
        disabled={isOpening || isBusy}
        className="relative aspect-[16/10] w-full overflow-hidden bg-zinc-950 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
        aria-label={`Open project ${project.name}`}
      >
        {project.thumbnailDataUrl ? (
          <img
            src={project.thumbnailDataUrl}
            alt={project.name}
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-xs text-zinc-500">
            No Preview
          </div>
        )}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-black/75 to-transparent" />
        {isActive && (
          <span className="pointer-events-none absolute top-2.5 left-2.5 text-[11px] font-semibold tracking-wide text-white drop-shadow">
            Active Session
          </span>
        )}
      </button>

      {/* Body */}
      <div className="flex flex-1 flex-col justify-between p-3.5 gap-3">
        <div>
          {isRenaming ? (
            <div className="flex items-center gap-1.5">
              <input
                type="text"
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSaveRename();
                  if (e.key === 'Escape') {
                    setDraftName(project.name);
                    setIsRenaming(false);
                  }
                }}
                autoFocus
                maxLength={80}
                aria-label="Rename project"
                className="min-w-0 flex-1 rounded-md border border-white/30 bg-zinc-950 px-2.5 py-1 text-xs font-medium text-white focus:border-white focus:outline-none"
              />
              <button
                type="button"
                onClick={handleSaveRename}
                disabled={isBusy || !draftName.trim()}
                title="Save name"
                aria-label="Save name"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-white text-zinc-950 hover:bg-zinc-200 disabled:opacity-40"
              >
                <Check className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => {
                  setDraftName(project.name);
                  setIsRenaming(false);
                }}
                title="Cancel rename"
                aria-label="Cancel rename"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-white/10 text-zinc-400 hover:bg-zinc-800 hover:text-white"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : (
            <h3
              className="truncate text-sm font-semibold text-zinc-100"
              title={project.name}
            >
              {project.name}
            </h3>
          )}

          {/* Clean unboxed typographic metadata */}
          <p className="mt-1 truncate text-[11px] text-zinc-400">
            {detailSegments.join(' · ')}
          </p>
        </div>

        {/* Action Row */}
        {confirmDelete ? (
          <div className="flex items-center justify-between gap-2 border-t border-white/[0.06] pt-2.5">
            <span className="text-[11px] text-red-300">Delete permanently?</span>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                disabled={isBusy}
                className="rounded-md border border-white/10 px-2.5 py-1 text-[11px] font-medium text-zinc-300 hover:bg-zinc-800"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDelete}
                disabled={isBusy}
                className="rounded-md bg-red-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-red-500 disabled:opacity-50"
              >
                Delete
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2 border-t border-white/[0.06] pt-2.5">
            <button
              type="button"
              onClick={() => onOpen(project.id)}
              disabled={isOpening || isBusy}
              className="flex items-center gap-1.5 rounded-md bg-white px-3 py-1.5 text-xs font-semibold text-zinc-950 hover:bg-zinc-200 disabled:opacity-50 transition-colors min-h-[32px]"
            >
              <FolderOpen className="h-3.5 w-3.5" />
              <span>{isActive ? 'Resume' : 'Open'}</span>
            </button>

            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => {
                  setDraftName(project.name);
                  setIsRenaming(true);
                }}
                disabled={isBusy}
                title="Rename Project"
                aria-label={`Rename ${project.name}`}
                className="flex h-8 w-8 items-center justify-center rounded-md text-zinc-400 hover:bg-zinc-800 hover:text-white transition-colors"
              >
                <Edit3 className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={handleDuplicate}
                disabled={isBusy}
                title="Duplicate Project"
                aria-label={`Duplicate ${project.name}`}
                className="flex h-8 w-8 items-center justify-center rounded-md text-zinc-400 hover:bg-zinc-800 hover:text-white transition-colors"
              >
                <Copy className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                disabled={isBusy}
                title="Delete Project"
                aria-label={`Delete ${project.name}`}
                className="flex h-8 w-8 items-center justify-center rounded-md text-zinc-400 hover:bg-red-950/60 hover:text-red-300 transition-colors"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
