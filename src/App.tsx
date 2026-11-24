import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Bandage,
  Check,
  Crop,
  Download,
  Eye,
  FolderKanban,
  FolderOpen,
  Hand,
  Images,
  Layers,
  Loader2,
  Maximize2,
  Redo2,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
  SplitSquareHorizontal,
  Undo2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { AdjustmentControls } from './components/AdjustmentSections';
import { CompareOverlay } from './components/CompareOverlay';
import { CropOverlay, fitCropToAspect, getTargetAspectRatio } from './components/CropOverlay';
import { CropPanel } from './components/CropPanel';
import { EmptyWorkspace } from './components/EmptyWorkspace';
import { ExportModal } from './components/ExportModal';
import { Histogram } from './components/Histogram';
import { ActiveMaskPointerTool, MaskCanvasOverlay } from './components/MaskCanvasOverlay';
import { MaskingPanel } from './components/MaskingPanel';
import { OfflineIndicator } from './components/OfflineIndicator';
import { PresetStrip } from './components/PresetStrip';
import { ProjectsModal } from './components/ProjectsModal';
import { PWAInstallButton } from './components/PWAInstallButton';
import { CloneSourcePoint, RetouchCanvasOverlay } from './components/RetouchCanvasOverlay';
import { RetouchPanel } from './components/RetouchPanel';
import { BUILT_IN_PRESETS, SAMPLE_PHOTOS, SamplePhoto } from './data/presets';
import { refineBackgroundAlphaMask } from './engine/backgroundSegmentation';
import {
  alphaMaskHasTransparency,
  applyAdjustmentsToCanvas,
  applyMaskLayersToCanvas,
  composeRetouchLayer,
  computeHistogram,
  getOutputDimensions,
  getRotatedDimensions,
  hasHeavySpatialAdjustments,
  hasNonZeroAdjustments,
  renderGeometryCanvas,
} from './engine/imageProcessor';
import {
  cloneMaskLayers,
  computeBackgroundRasterMask,
  computeObjectSelectionRasterMask,
  computeSkyRasterMask,
  computeSubjectRasterMask,
  evaluateMaskLayerBaseAlpha,
  getMaskRasterDimensions,
  hasNonZeroLocalAdjustments,
  invalidateMaskBasePixelCache,
} from './engine/maskEngine';
import {
  getDevicePerformanceProfile,
  getOptimalPreviewMaxDim,
} from './engine/performanceProfile';
import { parsePresetFile } from './engine/presetParser';
import { loadStoredPresets, saveStoredPresets } from './engine/presetStorage';
import {
  checkStorageQuota,
  createProjectThumbnailDataUrl,
  deleteProjectFromIdb,
  drawBlobOntoCanvas,
  duplicateProjectInIdb,
  formatIndexedDbError,
  listSavedProjects,
  loadProjectFromIdb,
  pngBlobToGrayscaleBytes,
  renameProjectInIdb,
  resolveSourceImageBlob,
  saveProjectToIdb,
  serializeEditStateForStorage,
  serializeMaskLayersForStorage,
  serializeRetouchOpsForStorage,
  setLastActiveProjectId,
  uint8ToGrayscalePngBlob,
} from './engine/projectStorage';
import {
  applyManualSelectionSnap,
  applyRefinementToAlphaBuffer,
  autoRemoveBackgroundAsync,
  createRetouchBuffers,
  extractAlphaRect,
  extractObjectMaskPatch,
  fillAlphaCanvasUniform,
  hasObjectMaskPixels,
  inpaintObjectRemovalAsync,
  putAlphaRect,
  replayRetouchOperationsOnCanvas,
  RetouchBuffers,
  syncManualAlphaDeltaRect,
} from './engine/retouchEngine';
import { cloneToneCurves } from './engine/toneCurve';
import {
  Adjustments,
  AspectRatioOption,
  AutoSaveStatus,
  BackgroundSettings,
  BgRefinementSettings,
  BgSegmentationProgress,
  CompareMode,
  CropRect,
  DEFAULT_ADJUSTMENTS,
  DEFAULT_BACKGROUND_SETTINGS,
  DEFAULT_BG_REFINEMENT_SETTINGS,
  DEFAULT_COLOR_GRADING,
  DEFAULT_EDIT_STATE,
  DEFAULT_HSL_MIXER,
  DEFAULT_LOCAL_ADJUSTMENTS,
  DEFAULT_MASK_BRUSH_SETTINGS,
  DEFAULT_RETOUCH_BRUSH_CONFIG,
  DEFAULT_TONE_CURVE,
  DEFAULT_TRANSFORM,
  DirtyRect,
  EditState,
  EditorTab,
  EditSubSection,
  HistogramData,
  LoadedImageMeta,
  MaskBrushSettings,
  MaskComponent,
  MaskCreationTool,
  MaskLayer,
  MaskOperation,
  MobileSubTab,
  Preset,
  PresetCategory,
  RetouchBrushConfig,
  RetouchOperation,
  RetouchTool,
  SavedProjectAssetsPayload,
  SavedProjectStatePayload,
  SavedProjectSummary,
  SerializedHistoryEntry,
  StorageQuotaStatus,
  TransformState,
} from './types/editor';

function imageDataAlphaToUint8(img: ImageData): Uint8ClampedArray {
  const data = img.data;
  const out = new Uint8ClampedArray(img.width * img.height);
  for (let i = 0; i < out.length; i++) {
    out[i] = data[i * 4];
  }
  return out;
}

type HistoryEntry =
  | { kind: 'state'; prev: EditState; next: EditState }
  | {
      kind: 'retouch-rgb';
      rect: DirtyRect;
      before?: ImageData;
      after?: ImageData;
      retouchOp?: RetouchOperation;
    }
  | {
      kind: 'retouch-alpha';
      rect: DirtyRect;
      beforeAlpha?: Uint8ClampedArray;
      afterAlpha?: Uint8ClampedArray;
      before?: ImageData;
      after?: ImageData;
      prevBgRefinement?: BgRefinementSettings;
      nextBgRefinement?: BgRefinementSettings;
    }
  | { kind: 'bg-settings'; prev: BackgroundSettings; next: BackgroundSettings }
  | {
      kind: 'masks';
      prev: MaskLayer[];
      next: MaskLayer[];
      prevActiveId: string | null;
      nextActiveId: string | null;
    };

function cloneAdjustments(adj: Adjustments): Adjustments {
  return {
    ...adj,
    toneCurve: cloneToneCurves(adj.toneCurve),
    hsl: {
      red: { ...adj.hsl.red },
      orange: { ...adj.hsl.orange },
      yellow: { ...adj.hsl.yellow },
      green: { ...adj.hsl.green },
      aqua: { ...adj.hsl.aqua },
      blue: { ...adj.hsl.blue },
      purple: { ...adj.hsl.purple },
      magenta: { ...adj.hsl.magenta },
    },
    colorGrading: {
      shadows: { ...adj.colorGrading.shadows },
      midtones: { ...adj.colorGrading.midtones },
      highlights: { ...adj.colorGrading.highlights },
      blending: adj.colorGrading.blending,
      balance: adj.colorGrading.balance,
    },
  };
}

function cloneEditState(state: EditState): EditState {
  return {
    adjustments: cloneAdjustments(state.adjustments),
    transform: {
      ...state.transform,
      crop: { ...state.transform.crop },
    },
    activePresetId: state.activePresetId,
  };
}

export default function App() {
  // Original immutable source image
  const [sourceImage, setSourceImage] = useState<HTMLImageElement | null>(null);
  const [imageMeta, setImageMeta] = useState<LoadedImageMeta | null>(null);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Local IndexedDB Project Auto-Save & Restore state
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const activeProjectIdRef = useRef<string | null>(null);
  activeProjectIdRef.current = activeProjectId;
  const [activeProjectName, setActiveProjectName] = useState<string>('Untitled Project');
  const [isEditingHeaderName, setIsEditingHeaderName] = useState(false);
  const [headerNameDraft, setHeaderNameDraft] = useState('');
  const [autoSaveStatus, setAutoSaveStatus] = useState<AutoSaveStatus>('idle');
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [storageQuota, setStorageQuota] = useState<StorageQuotaStatus | null>(null);
  const [savedProjects, setSavedProjects] = useState<SavedProjectSummary[]>([]);
  const [isLoadingProjects, setIsLoadingProjects] = useState<boolean>(true);
  const [openingProjectId, setOpeningProjectId] = useState<string | null>(null);
  const [showProjectsModal, setShowProjectsModal] = useState<boolean>(false);
  const [projectsError, setProjectsError] = useState<string | null>(null);

  const projectCreatedAtRef = useRef<string>(new Date().toISOString());
  const projectSourceBlobRef = useRef<{ projectId: string; blob: Blob } | null>(null);
  const projectBgImageBlobRef = useRef<Blob | null>(null);
  const sourceObjectUrlRef = useRef<string | null>(null);
  const bgObjectUrlRef = useRef<string | null>(null);
  const assetRevisionRef = useRef<number>(1);
  const savedAssetRevisionRef = useRef<number>(0);
  const autoSaveTimerRef = useRef<number | null>(null);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const sessionLoadSeqRef = useRef<number>(0);
  const skipNextAutoSaveRef = useRef<boolean>(false);

  // Non-destructive parameter edit state
  const [draftState, setDraftState] = useState<EditState>(() => cloneEditState(DEFAULT_EDIT_STATE));
  const draftStateRef = useRef<EditState>(draftState);
  draftStateRef.current = draftState;
  const lastCommittedStateRef = useRef<EditState>(cloneEditState(DEFAULT_EDIT_STATE));

  // Unified Undo / Redo history across edits, retouching, and background replacement
  const [history, setHistory] = useState<{
    entries: HistoryEntry[];
    cursor: number;
    archivedRetouchOps: RetouchOperation[];
  }>({
    entries: [],
    cursor: 0,
    archivedRetouchOps: [],
  });

  // Active resolution-independent retouch operations up to current undo cursor
  const activeRetouchOps = useMemo<RetouchOperation[]>(() => {
    const ops: RetouchOperation[] = [...history.archivedRetouchOps];
    const limit = Math.min(history.cursor, history.entries.length);
    for (let i = 0; i < limit; i++) {
      const entry = history.entries[i];
      if (entry.kind === 'retouch-rgb' && entry.retouchOp) {
        ops.push(entry.retouchOp);
      }
    }
    return ops;
  }, [history]);
  const hasRetouchEdits = activeRetouchOps.length > 0;

  // Retouching buffers & state
  const retouchBuffersRef = useRef<RetouchBuffers | null>(null);
  const [retouchRenderTick, setRetouchRenderTick] = useState<number>(0);
  const [maskRenderVersion, setMaskRenderVersion] = useState<number>(0);
  const [hasTransparency, setHasTransparency] = useState<boolean>(false);
  const [hasObjectSelection, setHasObjectSelection] = useState<boolean>(false);
  const hasObjectSelectionRef = useRef<boolean>(false);
  hasObjectSelectionRef.current = hasObjectSelection;
  const [isProcessingInpaint, setIsProcessingInpaint] = useState<boolean>(false);
  const [isProcessingBg, setIsProcessingBg] = useState<boolean>(false);
  const [bgProgress, setBgProgress] = useState<BgSegmentationProgress | null>(null);
  const [bgLastModelLabel, setBgLastModelLabel] = useState<string | null>(null);

  const [retouchTool, setRetouchTool] = useState<RetouchTool>('object-remover');
  const [brushConfig, setBrushConfig] = useState<RetouchBrushConfig>(DEFAULT_RETOUCH_BRUSH_CONFIG);
  const [cloneSource, setCloneSource] = useState<CloneSourcePoint | null>(null);
  const [isPickingCloneSource, setIsPickingCloneSource] = useState<boolean>(false);
  const [bgSettings, setBgSettings] = useState<BackgroundSettings>(DEFAULT_BACKGROUND_SETTINGS);
  const bgSettingsRef = useRef<BackgroundSettings>(bgSettings);
  bgSettingsRef.current = bgSettings;
  const [bgRefinement, setBgRefinement] = useState<BgRefinementSettings>(
    DEFAULT_BG_REFINEMENT_SETTINGS
  );
  const bgRefinementRef = useRef<BgRefinementSettings>(bgRefinement);
  bgRefinementRef.current = bgRefinement;
  const lastCommittedBgRefinementRef = useRef<BgRefinementSettings>(DEFAULT_BG_REFINEMENT_SETTINGS);
  const bgRefinementBeforeAlphaRef = useRef<Uint8ClampedArray | null>(null);
  const [bgImageElement, setBgImageElement] = useState<HTMLImageElement | null>(null);

  // Non-destructive Masking state
  const [maskLayers, setMaskLayers] = useState<MaskLayer[]>([]);
  const maskLayersRef = useRef<MaskLayer[]>([]);
  maskLayersRef.current = maskLayers;
  const lastCommittedMasksRef = useRef<{ masks: MaskLayer[]; activeId: string | null }>({
    masks: [],
    activeId: null,
  });
  const [activeMaskId, setActiveMaskId] = useState<string | null>(null);
  const activeMaskIdRef = useRef<string | null>(null);
  activeMaskIdRef.current = activeMaskId;
  const [maskPointerTool, setMaskPointerTool] = useState<ActiveMaskPointerTool>({
    mode: 'idle',
  });
  const [showRedMask, setShowRedMask] = useState<boolean>(false);
  const [maskBrushSettings, setMaskBrushSettings] = useState<MaskBrushSettings>(
    DEFAULT_MASK_BRUSH_SETTINGS
  );
  const [isSegmentingMask, setIsSegmentingMask] = useState<boolean>(false);

  // Custom & imported user presets in localStorage
  const [customPresets, setCustomPresets] = useState<Preset[]>(() => loadStoredPresets());

  // UI workspace states
  const [isDesktop, setIsDesktop] = useState<boolean>(() =>
    typeof window !== 'undefined' ? window.innerWidth >= 1024 : true
  );
  const [desktopTab, setDesktopTab] = useState<EditorTab>('edit');
  const [mobileSubTab, setMobileSubTab] = useState<MobileSubTab>('adjust');
  const [mobileAdjustSection, setMobileAdjustSection] = useState<EditSubSection>('light');
  const [compareMode, setCompareMode] = useState<CompareMode>('off');
  const [splitPosition, setSplitPosition] = useState<number>(50);
  const [isPanToolActive, setIsPanToolActive] = useState<boolean>(false);
  const [spacePanHeld, setSpacePanHeld] = useState<boolean>(false);
  const [showExportModal, setShowExportModal] = useState(false);
  const [showSamplesDrawer, setShowSamplesDrawer] = useState(false);

  // Zoom & Pan state
  const [zoomFactor, setZoomFactor] = useState<number>(1);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [workspaceSize, setWorkspaceSize] = useState<{ width: number; height: number }>({
    width: 800,
    height: 600,
  });
  const [renderSize, setRenderSize] = useState<{ width: number; height: number }>({
    width: 800,
    height: 600,
  });

  // Adaptive interactive scrubbing state (drops spatial preview cost while dragging, sharpens on rest)
  const [isScrubbing, setIsScrubbing] = useState<boolean>(false);
  const isScrubbingRef = useRef<boolean>(false);
  const scrubIdleTimerRef = useRef<number | null>(null);
  const histogramTimerRef = useRef<number | null>(null);

  const markScrubbingActive = useCallback(() => {
    if (!isScrubbingRef.current) {
      isScrubbingRef.current = true;
      setIsScrubbing(true);
    }
    if (scrubIdleTimerRef.current !== null) {
      window.clearTimeout(scrubIdleTimerRef.current);
    }
    scrubIdleTimerRef.current = window.setTimeout(() => {
      scrubIdleTimerRef.current = null;
      isScrubbingRef.current = false;
      setIsScrubbing(false);
    }, 95);
  }, []);

  const clearScrubbingState = useCallback(() => {
    if (scrubIdleTimerRef.current !== null) {
      window.clearTimeout(scrubIdleTimerRef.current);
      scrubIdleTimerRef.current = null;
    }
    if (isScrubbingRef.current) {
      isScrubbingRef.current = false;
      setIsScrubbing(false);
    }
  }, []);

  useEffect(() => {
    return () => {
      if (scrubIdleTimerRef.current !== null) {
        window.clearTimeout(scrubIdleTimerRef.current);
      }
      if (histogramTimerRef.current !== null) {
        window.clearTimeout(histogramTimerRef.current);
      }
    };
  }, []);

  // Live Histogram
  const [histogram, setHistogram] = useState<HistogramData | null>(null);

  // Refs
  const fileInputRef = useRef<HTMLInputElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const mainCanvasRef = useRef<HTMLCanvasElement>(null);
  const originalCanvasRef = useRef<HTMLCanvasElement>(null);
  const compositedBaseCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const fallbackBaseCanvasRef = useRef<{
    src: HTMLImageElement | null;
    canvas: HTMLCanvasElement;
  } | null>(null);
  const compositedPreviewCacheRef = useRef<{
    sourceImage: HTMLImageElement;
    compareMode: CompareMode;
    retouchRenderTick: number;
    bgSettings: BackgroundSettings;
    bgRefinement: BgRefinementSettings;
    bgImageElement: HTMLImageElement | null;
    hasBuffers: boolean;
    activeSource: HTMLImageElement | HTMLCanvasElement;
  } | null>(null);
  const geoPreviewCacheRef = useRef<{
    activeSource: HTMLImageElement | HTMLCanvasElement;
    transform: TransformState;
    previewMaxDim: number;
    isCropMode: boolean;
    canvas: HTMLCanvasElement;
  } | null>(null);
  const preMaskRenderCacheRef = useRef<{
    sourceImage: HTMLImageElement;
    adjustments: Adjustments;
    transform: TransformState;
    isCropMode: boolean;
    compareMode: CompareMode;
    isDesktop: boolean;
    previewMaxDim: number;
    retouchRenderTick: number;
    bgSettings: BackgroundSettings;
    bgRefinement: BgRefinementSettings;
    bgImageElement: HTMLImageElement | null;
    canvas: HTMLCanvasElement;
    activeSource: HTMLImageElement | HTMLCanvasElement;
  } | null>(null);
  const lastRenderedHasMaskEditsRef = useRef<boolean>(false);
  const rafRef = useRef<number | null>(null);
  const panDragRef = useRef<{
    startX: number;
    startY: number;
    origPanX: number;
    origPanY: number;
  } | null>(null);

  const isCropMode = isDesktop ? desktopTab === 'crop' : mobileSubTab === 'crop';
  const isRetouchMode = isDesktop ? desktopTab === 'retouch' : mobileSubTab === 'retouch';
  const isMaskMode = isDesktop ? desktopTab === 'masking' : mobileSubTab === 'masking';
  const effectivePanMode = isPanToolActive || spacePanHeld;

  // Automatically hide brush outline, selection lines, and mask overlays when switching to photo adjustment tools
  useEffect(() => {
    if (!isMaskMode) {
      setMaskPointerTool({ mode: 'idle' });
      setShowRedMask(false);
      setMaskLayers((prev) =>
        prev.some((m) => m.showOverlay)
          ? prev.map((m) => (m.showOverlay ? { ...m, showOverlay: false } : m))
          : prev
      );
    }
  }, [isMaskMode]);

  // Invalidate mask base pixel cache whenever underlying image/retouch/background changes
  useEffect(() => {
    invalidateMaskBasePixelCache();
  }, [sourceImage, retouchRenderTick, bgSettings, bgRefinement, bgImageElement]);

  // Track responsive breakpoint
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)');
    const update = () => setIsDesktop(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

  // Measure workspace dimensions
  useEffect(() => {
    const el = workspaceRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        setWorkspaceSize({ width, height });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Save custom & imported presets to localStorage
  useEffect(() => {
    const res = saveStoredPresets(customPresets);
    if (!res.ok && res.error) {
      setLoadError(res.error);
    }
  }, [customPresets]);

  // Refresh saved projects list + local storage quota
  const refreshProjectDirectory = useCallback(async () => {
    try {
      const [projects, quota] = await Promise.all([listSavedProjects(), checkStorageQuota()]);
      setSavedProjects(projects);
      setStorageQuota(quota);
      setProjectsError(null);
    } catch (err) {
      setProjectsError(formatIndexedDbError(err));
    } finally {
      setIsLoadingProjects(false);
    }
  }, []);

  useEffect(() => {
    void refreshProjectDirectory();
  }, [refreshProjectDirectory]);

  // Synchronous snapshot capture so project switches never overwrite another project
  const captureCurrentProjectSnapshot = useCallback(() => {
    const projectId = activeProjectIdRef.current;
    if (!projectId || !sourceImage || !imageMeta) return null;

    const currentMasks = serializeMaskLayersForStorage(maskLayersRef.current);
    const currentEditState = serializeEditStateForStorage(draftState);
    const currentRetouchOps = serializeRetouchOpsForStorage(activeRetouchOps);
    const currentArchivedOps = serializeRetouchOpsForStorage(history.archivedRetouchOps);
    const needAssets = savedAssetRevisionRef.current !== assetRevisionRef.current;

    const buf = retouchBuffersRef.current;
    let alphaSnapshot: Uint8ClampedArray | null = null;
    let rawAutoAlphaSnapshot: Uint8ClampedArray | null = null;
    let manualDeltaSnapshot: Int16Array | null = null;
    let bufWidth = 0;
    let bufHeight = 0;

    if (needAssets && buf) {
      bufWidth = buf.width;
      bufHeight = buf.height;
      if (hasTransparency) {
        const aCtx = buf.alphaCanvas.getContext('2d', { willReadFrequently: true });
        if (aCtx) {
          const data = aCtx.getImageData(0, 0, buf.width, buf.height).data;
          alphaSnapshot = new Uint8ClampedArray(buf.width * buf.height);
          for (let i = 0; i < alphaSnapshot.length; i++) {
            alphaSnapshot[i] = data[i * 4];
          }
        }
      }
      if (buf.rawAutoAlpha) {
        rawAutoAlphaSnapshot = new Uint8ClampedArray(buf.rawAutoAlpha);
      }
      if (buf.manualAlphaDelta) {
        let hasDelta = false;
        for (let i = 0; i < buf.manualAlphaDelta.length; i++) {
          if (buf.manualAlphaDelta[i] !== 0) {
            hasDelta = true;
            break;
          }
        }
        if (hasDelta) {
          manualDeltaSnapshot = new Int16Array(buf.manualAlphaDelta);
        }
      }
    }

    const serializedHistory: SerializedHistoryEntry[] = history.entries.map((entry) => {
      if (entry.kind === 'state') {
        return {
          kind: 'state',
          prev: serializeEditStateForStorage(entry.prev),
          next: serializeEditStateForStorage(entry.next),
        };
      }
      if (entry.kind === 'retouch-rgb') {
        return {
          kind: 'retouch-rgb',
          rect: { ...entry.rect },
          retouchOp: entry.retouchOp
            ? serializeRetouchOpsForStorage([entry.retouchOp])[0]
            : undefined,
        };
      }
      if (entry.kind === 'retouch-alpha') {
        return {
          kind: 'retouch-alpha',
          rect: { ...entry.rect },
          prevBgRefinement: entry.prevBgRefinement ? { ...entry.prevBgRefinement } : undefined,
          nextBgRefinement: entry.nextBgRefinement ? { ...entry.nextBgRefinement } : undefined,
        };
      }
      if (entry.kind === 'bg-settings') {
        return {
          kind: 'bg-settings',
          prev: { ...entry.prev },
          next: { ...entry.next },
        };
      }
      return {
        kind: 'masks',
        prev: serializeMaskLayersForStorage(entry.prev),
        next: serializeMaskLayersForStorage(entry.next),
        prevActiveId: entry.prevActiveId,
        nextActiveId: entry.nextActiveId,
      };
    });

    const presetObj = currentEditState.activePresetId
      ? BUILT_IN_PRESETS.find((p) => p.id === currentEditState.activePresetId) ||
        customPresets.find((p) => p.id === currentEditState.activePresetId)
      : null;

    const thumbnailSource =
      mainCanvasRef.current && mainCanvasRef.current.width > 0
        ? mainCanvasRef.current
        : sourceImage;
    const thumbnailDataUrl = createProjectThumbnailDataUrl(thumbnailSource);

    return {
      projectId,
      projectName: activeProjectName,
      createdAt: projectCreatedAtRef.current,
      sourceImage,
      imageMeta: { ...imageMeta },
      existingSourceBlob:
        projectSourceBlobRef.current?.projectId === projectId
          ? projectSourceBlobRef.current.blob
          : null,
      editState: currentEditState,
      maskLayers: currentMasks,
      activeMaskId: activeMaskIdRef.current,
      activeRetouchOps: currentRetouchOps,
      archivedRetouchOps: currentArchivedOps,
      bgSettings: {
        ...bgSettings,
        imageSrc: bgSettings.mode === 'image' && bgSettings.imageName ? 'stored-asset' : null,
      },
      bgRefinement: { ...bgRefinement },
      bgLastModelLabel,
      hasTransparency,
      historyEntries: serializedHistory,
      historyCursor: history.cursor,
      activePresetName: presetObj?.name ?? null,
      thumbnailDataUrl,
      needAssets,
      assetVersion: assetRevisionRef.current,
      bgImageBlob: projectBgImageBlobRef.current,
      alphaSnapshot,
      rawAutoAlphaSnapshot,
      manualDeltaSnapshot,
      bufWidth,
      bufHeight,
    };
  }, [
    sourceImage,
    imageMeta,
    draftState,
    activeRetouchOps,
    history,
    activeProjectName,
    bgSettings,
    bgRefinement,
    bgLastModelLabel,
    hasTransparency,
    customPresets,
  ]);

  type CapturedProjectSnapshot = NonNullable<ReturnType<typeof captureCurrentProjectSnapshot>>;

  const persistCapturedSnapshot = useCallback(
    (snap: CapturedProjectSnapshot): Promise<void> => {
      const task = async () => {
        const isStillActive = activeProjectIdRef.current === snap.projectId;
        if (isStillActive) {
          setAutoSaveStatus('saving');
          setSaveError(null);
        }

        try {
          let assetsPayload: SavedProjectAssetsPayload | null = null;
          let sourceBlob = snap.existingSourceBlob;

          if (snap.needAssets) {
            sourceBlob = await resolveSourceImageBlob(snap.sourceImage, snap.existingSourceBlob);
            projectSourceBlobRef.current =
              activeProjectIdRef.current === snap.projectId || !projectSourceBlobRef.current
                ? { projectId: snap.projectId, blob: sourceBlob }
                : projectSourceBlobRef.current;

            const alphaPngBlob =
              snap.alphaSnapshot && snap.bufWidth > 0 && snap.bufHeight > 0
                ? await uint8ToGrayscalePngBlob(snap.alphaSnapshot, snap.bufWidth, snap.bufHeight)
                : null;
            const rawAutoAlphaPngBlob =
              snap.rawAutoAlphaSnapshot && snap.bufWidth > 0 && snap.bufHeight > 0
                ? await uint8ToGrayscalePngBlob(
                    snap.rawAutoAlphaSnapshot,
                    snap.bufWidth,
                    snap.bufHeight
                  )
                : null;

            assetsPayload = {
              projectId: snap.projectId,
              sourceBlob,
              bgImageBlob: snap.bgImageBlob,
              alphaPngBlob,
              rawAutoAlphaPngBlob,
              manualAlphaDelta: snap.manualDeltaSnapshot,
              assetVersion: snap.assetVersion,
            };
          }

          const now = new Date().toISOString();
          const estimatedBytes =
            (sourceBlob?.size ?? snap.imageMeta.fileSize ?? 0) +
            (assetsPayload?.alphaPngBlob?.size ?? 0) +
            (assetsPayload?.rawAutoAlphaPngBlob?.size ?? 0) +
            (assetsPayload?.bgImageBlob?.size ?? 0) +
            (assetsPayload?.manualAlphaDelta?.byteLength ?? 0) +
            Math.max(4096, snap.thumbnailDataUrl.length);

          const summary: SavedProjectSummary = {
            id: snap.projectId,
            name: snap.projectName,
            createdAt: snap.createdAt,
            updatedAt: now,
            fileName: snap.imageMeta.name,
            width: snap.imageMeta.width,
            height: snap.imageMeta.height,
            fileSize: snap.imageMeta.fileSize,
            mimeType: snap.imageMeta.mimeType,
            thumbnailDataUrl: snap.thumbnailDataUrl,
            activePresetId: snap.editState.activePresetId,
            activePresetName: snap.activePresetName,
            maskCount: snap.maskLayers.length,
            retouchCount: snap.activeRetouchOps.length,
            hasTransparency: snap.hasTransparency,
            estimatedBytes,
          };

          const statePayload: SavedProjectStatePayload = {
            projectId: snap.projectId,
            editState: snap.editState,
            maskLayers: snap.maskLayers,
            activeMaskId: snap.activeMaskId,
            activeRetouchOps: snap.activeRetouchOps,
            archivedRetouchOps: snap.archivedRetouchOps,
            bgSettings: snap.bgSettings,
            bgRefinement: snap.bgRefinement,
            bgLastModelLabel: snap.bgLastModelLabel,
            hasTransparency: snap.hasTransparency,
            historyEntries: snap.historyEntries,
            historyCursor: snap.historyCursor,
            updatedAt: now,
          };

          await saveProjectToIdb(summary, statePayload, assetsPayload);

          if (activeProjectIdRef.current === snap.projectId) {
            if (snap.needAssets) {
              savedAssetRevisionRef.current = Math.max(
                savedAssetRevisionRef.current,
                snap.assetVersion
              );
            }
            setAutoSaveStatus('saved');
            setLastSavedAt(now);
            setSaveError(null);
            setLastActiveProjectId(snap.projectId);
          }

          await refreshProjectDirectory();
        } catch (err) {
          const message = formatIndexedDbError(err);
          if (activeProjectIdRef.current === snap.projectId) {
            setAutoSaveStatus('error');
            setSaveError(message);
          }
          setProjectsError(message);
          void checkStorageQuota().then(setStorageQuota);
        }
      };

      const nextPromise = saveQueueRef.current.then(task, task);
      saveQueueRef.current = nextPromise.catch(() => {});
      return nextPromise;
    },
    [refreshProjectDirectory]
  );

  const flushPendingAutoSave = useCallback(async () => {
    if (autoSaveTimerRef.current !== null) {
      window.clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }
    const snap = captureCurrentProjectSnapshot();
    if (snap) {
      await persistCapturedSnapshot(snap);
    }
  }, [captureCurrentProjectSnapshot, persistCapturedSnapshot]);

  // Debounced auto-save when project edits change
  useEffect(() => {
    if (!activeProjectId || !sourceImage || !imageMeta) return;
    if (skipNextAutoSaveRef.current) {
      skipNextAutoSaveRef.current = false;
      return;
    }

    if (autoSaveTimerRef.current !== null) {
      window.clearTimeout(autoSaveTimerRef.current);
    }

    const isInitialAssetWrite = savedAssetRevisionRef.current !== assetRevisionRef.current;
    const delayMs = isInitialAssetWrite ? 180 : 750;

    setAutoSaveStatus('saving');
    autoSaveTimerRef.current = window.setTimeout(() => {
      autoSaveTimerRef.current = null;
      const snap = captureCurrentProjectSnapshot();
      if (snap) {
        void persistCapturedSnapshot(snap);
      }
    }, delayMs);

    return () => {
      if (autoSaveTimerRef.current !== null) {
        window.clearTimeout(autoSaveTimerRef.current);
        autoSaveTimerRef.current = null;
      }
    };
  }, [
    activeProjectId,
    sourceImage,
    imageMeta,
    activeProjectName,
    draftState,
    maskLayers,
    activeMaskId,
    retouchRenderTick,
    bgSettings,
    bgRefinement,
    hasTransparency,
    history,
    captureCurrentProjectSnapshot,
    persistCapturedSnapshot,
  ]);

  // Flush pending auto-save when tab becomes hidden or browser page unloads
  useEffect(() => {
    const handleVisibilityOrHide = () => {
      if (document.visibilityState === 'hidden' || autoSaveTimerRef.current !== null) {
        if (autoSaveTimerRef.current !== null) {
          window.clearTimeout(autoSaveTimerRef.current);
          autoSaveTimerRef.current = null;
          const snap = captureCurrentProjectSnapshot();
          if (snap) {
            void persistCapturedSnapshot(snap);
          }
        }
      }
    };
    window.addEventListener('pagehide', handleVisibilityOrHide);
    document.addEventListener('visibilitychange', handleVisibilityOrHide);
    return () => {
      window.removeEventListener('pagehide', handleVisibilityOrHide);
      document.removeEventListener('visibilitychange', handleVisibilityOrHide);
    };
  }, [captureCurrentProjectSnapshot, persistCapturedSnapshot]);

  // Unified history push helper
  const pushHistoryEntry = useCallback((entry: HistoryEntry) => {
    const maxHistory = getDevicePerformanceProfile().maxHistoryEntries;
    setHistory((prev) => {
      const sliced = prev.entries.slice(0, prev.cursor);
      const appended = [...sliced, entry];
      let nextArchived = prev.archivedRetouchOps;
      while (appended.length > maxHistory) {
        const evicted = appended.shift();
        if (evicted && evicted.kind === 'retouch-rgb' && evicted.retouchOp) {
          nextArchived = [...nextArchived, evicted.retouchOp];
        }
      }
      return { entries: appended, cursor: appended.length, archivedRetouchOps: nextArchived };
    });
  }, []);

  const commitState = useCallback(
    (nextState: EditState) => {
      clearScrubbingState();
      const snap = cloneEditState(nextState);
      const prevSnap = cloneEditState(lastCommittedStateRef.current);
      draftStateRef.current = snap;
      setDraftState(snap);
      lastCommittedStateRef.current = snap;
      pushHistoryEntry({ kind: 'state', prev: prevSnap, next: snap });
    },
    [clearScrubbingState, pushHistoryEntry]
  );

  const canUndo = history.cursor > 0;
  const canRedo = history.cursor < history.entries.length;

  const refreshTransparencyFlag = useCallback(() => {
    const buf = retouchBuffersRef.current;
    if (!buf) {
      setHasTransparency(false);
      return;
    }
    setHasTransparency(alphaMaskHasTransparency(buf.alphaCanvas));
  }, []);

  const rebuildRetouchRgbFromHistory = useCallback(
    async (targetCursor: number) => {
      const buf = retouchBuffersRef.current;
      if (!buf || !sourceImage) return;
      const rCtx = buf.retouchCanvas.getContext('2d', { willReadFrequently: true });
      if (!rCtx) return;
      rCtx.clearRect(0, 0, buf.width, buf.height);
      rCtx.imageSmoothingEnabled = true;
      rCtx.imageSmoothingQuality = 'high';
      rCtx.drawImage(sourceImage, 0, 0, buf.width, buf.height);

      const ops: RetouchOperation[] = [...history.archivedRetouchOps];
      const limit = Math.min(targetCursor, history.entries.length);
      for (let i = 0; i < limit; i++) {
        const e = history.entries[i];
        if (e.kind === 'retouch-rgb' && e.retouchOp) {
          ops.push(e.retouchOp);
        }
      }
      if (ops.length > 0) {
        await replayRetouchOperationsOnCanvas(buf.retouchCanvas, ops);
      }
      assetRevisionRef.current += 1;
      setRetouchRenderTick((t) => t + 1);
    },
    [history, sourceImage]
  );

  const handleUndo = useCallback(() => {
    if (history.cursor <= 0) return;
    const nextCursor = history.cursor - 1;
    const entry = history.entries[nextCursor];
    const buf = retouchBuffersRef.current;

    if (entry.kind === 'state') {
      const restored = cloneEditState(entry.prev);
      setDraftState(restored);
      lastCommittedStateRef.current = restored;
    } else if (entry.kind === 'retouch-rgb' && buf) {
      assetRevisionRef.current += 1;
      if (entry.before) {
        buf.retouchCanvas.getContext('2d')?.putImageData(entry.before, entry.rect.x, entry.rect.y);
        setRetouchRenderTick((t) => t + 1);
      } else {
        void rebuildRetouchRgbFromHistory(nextCursor);
      }
    } else if (entry.kind === 'retouch-alpha' && buf) {
      assetRevisionRef.current += 1;
      if (entry.beforeAlpha) {
        putAlphaRect(buf.alphaCanvas, entry.rect, entry.beforeAlpha);
        syncManualAlphaDeltaRect(buf, entry.rect);
      } else if (entry.before) {
        buf.alphaCanvas.getContext('2d')?.putImageData(entry.before, entry.rect.x, entry.rect.y);
        syncManualAlphaDeltaRect(buf, entry.rect);
      } else if (entry.prevBgRefinement && buf.rawAutoAlpha) {
        applyRefinementToAlphaBuffer(buf, entry.prevBgRefinement);
      }
      if (entry.prevBgRefinement) {
        setBgRefinement(entry.prevBgRefinement);
        lastCommittedBgRefinementRef.current = entry.prevBgRefinement;
      }
      refreshTransparencyFlag();
      setMaskRenderVersion((v) => v + 1);
      setRetouchRenderTick((t) => t + 1);
    } else if (entry.kind === 'bg-settings') {
      setBgSettings(entry.prev);
    } else if (entry.kind === 'masks') {
      const restored = cloneMaskLayers(entry.prev);
      setMaskLayers(restored);
      setActiveMaskId(entry.prevActiveId);
      lastCommittedMasksRef.current = { masks: restored, activeId: entry.prevActiveId };
    }

    setHistory((prev) => ({ ...prev, cursor: Math.max(0, prev.cursor - 1) }));
  }, [history, refreshTransparencyFlag, rebuildRetouchRgbFromHistory]);

  const handleRedo = useCallback(() => {
    if (history.cursor >= history.entries.length) return;
    const nextCursor = history.cursor + 1;
    const entry = history.entries[history.cursor];
    const buf = retouchBuffersRef.current;

    if (entry.kind === 'state') {
      const restored = cloneEditState(entry.next);
      setDraftState(restored);
      lastCommittedStateRef.current = restored;
    } else if (entry.kind === 'retouch-rgb' && buf) {
      assetRevisionRef.current += 1;
      if (entry.after) {
        buf.retouchCanvas.getContext('2d')?.putImageData(entry.after, entry.rect.x, entry.rect.y);
        setRetouchRenderTick((t) => t + 1);
      } else {
        void rebuildRetouchRgbFromHistory(nextCursor);
      }
    } else if (entry.kind === 'retouch-alpha' && buf) {
      assetRevisionRef.current += 1;
      if (entry.afterAlpha) {
        putAlphaRect(buf.alphaCanvas, entry.rect, entry.afterAlpha);
        syncManualAlphaDeltaRect(buf, entry.rect);
      } else if (entry.after) {
        buf.alphaCanvas.getContext('2d')?.putImageData(entry.after, entry.rect.x, entry.rect.y);
        syncManualAlphaDeltaRect(buf, entry.rect);
      } else if (entry.nextBgRefinement && buf.rawAutoAlpha) {
        applyRefinementToAlphaBuffer(buf, entry.nextBgRefinement);
      }
      if (entry.nextBgRefinement) {
        setBgRefinement(entry.nextBgRefinement);
        lastCommittedBgRefinementRef.current = entry.nextBgRefinement;
      }
      refreshTransparencyFlag();
      setMaskRenderVersion((v) => v + 1);
      setRetouchRenderTick((t) => t + 1);
    } else if (entry.kind === 'bg-settings') {
      setBgSettings(entry.next);
    } else if (entry.kind === 'masks') {
      const restored = cloneMaskLayers(entry.next);
      setMaskLayers(restored);
      setActiveMaskId(entry.nextActiveId);
      lastCommittedMasksRef.current = { masks: restored, activeId: entry.nextActiveId };
    }

    setHistory((prev) => ({
      ...prev,
      cursor: Math.min(prev.entries.length, prev.cursor + 1),
    }));
  }, [history, refreshTransparencyFlag, rebuildRetouchRgbFromHistory]);

  const handleResetAll = useCallback(() => {
    if (!sourceImage) return;
    clearScrubbingState();
    const fresh = cloneEditState(DEFAULT_EDIT_STATE);
    setDraftState(fresh);
    lastCommittedStateRef.current = fresh;
    retouchBuffersRef.current = createRetouchBuffers(sourceImage);
    assetRevisionRef.current += 1;
    projectBgImageBlobRef.current = null;
    if (bgObjectUrlRef.current) {
      URL.revokeObjectURL(bgObjectUrlRef.current);
      bgObjectUrlRef.current = null;
    }
    setBgSettings(DEFAULT_BACKGROUND_SETTINGS);
    setBgRefinement(DEFAULT_BG_REFINEMENT_SETTINGS);
    lastCommittedBgRefinementRef.current = DEFAULT_BG_REFINEMENT_SETTINGS;
    bgRefinementBeforeAlphaRef.current = null;
    setBgImageElement(null);
    setMaskLayers([]);
    maskLayersRef.current = [];
    setActiveMaskId(null);
    activeMaskIdRef.current = null;
    lastCommittedMasksRef.current = { masks: [], activeId: null };
    setMaskPointerTool({ mode: 'idle' });
    setShowRedMask(false);
    preMaskRenderCacheRef.current = null;
    compositedPreviewCacheRef.current = null;
    geoPreviewCacheRef.current = null;
    lastRenderedHasMaskEditsRef.current = false;
    setCloneSource(null);
    setHasTransparency(false);
    setHasObjectSelection(false);
    hasObjectSelectionRef.current = false;
    setHistory({ entries: [], cursor: 0, archivedRetouchOps: [] });
    setCompareMode('off');
    setZoomFactor(1);
    setPan({ x: 0, y: 0 });
    setMaskRenderVersion((v) => v + 1);
    setRetouchRenderTick((t) => t + 1);
  }, [clearScrubbingState, sourceImage]);

  // Load brand-new image source into a brand-new isolated Project ID
  const loadImageSource = useCallback(
    async (
      src: string,
      meta: Omit<LoadedImageMeta, 'width' | 'height'>,
      initialBlob?: Blob
    ) => {
      setLoadError(null);
      await flushPendingAutoSave();
      const loadSeq = ++sessionLoadSeqRef.current;

      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        if (sessionLoadSeqRef.current !== loadSeq) return;

        if (sourceObjectUrlRef.current && sourceObjectUrlRef.current !== src) {
          URL.revokeObjectURL(sourceObjectUrlRef.current);
          sourceObjectUrlRef.current = null;
        }
        if (src.startsWith('blob:')) {
          sourceObjectUrlRef.current = src;
        }
        if (bgObjectUrlRef.current) {
          URL.revokeObjectURL(bgObjectUrlRef.current);
          bgObjectUrlRef.current = null;
        }

        const newProjectId = `proj-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const baseName = meta.name.replace(/\.[^.]+$/, '').trim() || 'Untitled Project';

        projectCreatedAtRef.current = new Date().toISOString();
        projectSourceBlobRef.current = initialBlob
          ? { projectId: newProjectId, blob: initialBlob }
          : null;
        projectBgImageBlobRef.current = null;
        assetRevisionRef.current = 1;
        savedAssetRevisionRef.current = 0;
        skipNextAutoSaveRef.current = false;

        setActiveProjectId(newProjectId);
        activeProjectIdRef.current = newProjectId;
        setActiveProjectName(baseName);
        setAutoSaveStatus('saving');
        setSaveError(null);
        setLastSavedAt(null);
        setShowProjectsModal(false);

        setSourceImage(img);
        setImageMeta({
          ...meta,
          width: img.naturalWidth,
          height: img.naturalHeight,
        });
        retouchBuffersRef.current = createRetouchBuffers(img);
        const fresh = cloneEditState(DEFAULT_EDIT_STATE);
        setDraftState(fresh);
        lastCommittedStateRef.current = fresh;
        setMaskLayers([]);
        maskLayersRef.current = [];
        setActiveMaskId(null);
        activeMaskIdRef.current = null;
        lastCommittedMasksRef.current = { masks: [], activeId: null };
        clearScrubbingState();
        setMaskPointerTool({ mode: 'idle' });
        setShowRedMask(false);
        preMaskRenderCacheRef.current = null;
        compositedPreviewCacheRef.current = null;
        geoPreviewCacheRef.current = null;
        fallbackBaseCanvasRef.current = null;
        lastRenderedHasMaskEditsRef.current = false;
        setHistory({ entries: [], cursor: 0, archivedRetouchOps: [] });
        setBgSettings(DEFAULT_BACKGROUND_SETTINGS);
        setBgRefinement(DEFAULT_BG_REFINEMENT_SETTINGS);
        lastCommittedBgRefinementRef.current = DEFAULT_BG_REFINEMENT_SETTINGS;
        bgRefinementBeforeAlphaRef.current = null;
        setBgLastModelLabel(null);
        setBgImageElement(null);
        setCloneSource(null);
        setIsPickingCloneSource(false);
        setHasTransparency(false);
        setHasObjectSelection(false);
        hasObjectSelectionRef.current = false;
        setCompareMode('off');
        setIsPanToolActive(false);
        setZoomFactor(1);
        setPan({ x: 0, y: 0 });
        setShowSamplesDrawer(false);
        setMaskRenderVersion((v) => v + 1);
        setRetouchRenderTick((t) => t + 1);
      };
      img.onerror = () => {
        if (sessionLoadSeqRef.current !== loadSeq) return;
        setLoadError(
          'Could not load that image file. Please choose a valid JPG, PNG, or WebP photo.'
        );
      };
      img.src = src;
    },
    [clearScrubbingState, flushPendingAutoSave]
  );

  // Restore full saved project from IndexedDB without overwriting any existing projects
  const handleOpenProject = useCallback(
    async (projectId: string) => {
      if (openingProjectId) return;
      setOpeningProjectId(projectId);
      setProjectsError(null);
      setLoadError(null);

      try {
        await flushPendingAutoSave();
        const loadSeq = ++sessionLoadSeqRef.current;
        const { summary, state, assets } = await loadProjectFromIdb(projectId);
        if (sessionLoadSeqRef.current !== loadSeq) return;

        const nextSourceUrl = URL.createObjectURL(assets.sourceBlob);
        const img = new Image();
        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = () => reject(new Error('Could not decode saved original photo.'));
          img.src = nextSourceUrl;
        });

        if (sessionLoadSeqRef.current !== loadSeq) {
          URL.revokeObjectURL(nextSourceUrl);
          return;
        }

        if (sourceObjectUrlRef.current) {
          URL.revokeObjectURL(sourceObjectUrlRef.current);
        }
        sourceObjectUrlRef.current = nextSourceUrl;

        // Reconstruct preview retouch & background removal buffers cleanly
        const buffers = createRetouchBuffers(img);
        if (state.activeRetouchOps.length > 0) {
          await replayRetouchOperationsOnCanvas(buffers.retouchCanvas, state.activeRetouchOps);
        }

        if (assets.alphaPngBlob) {
          await drawBlobOntoCanvas(assets.alphaPngBlob, buffers.alphaCanvas);
        }

        if (assets.rawAutoAlphaPngBlob) {
          const rawAuto = await pngBlobToGrayscaleBytes(
            assets.rawAutoAlphaPngBlob,
            buffers.width,
            buffers.height
          );
          if (rawAuto) {
            buffers.rawAutoAlpha = rawAuto;
            const rCtx = buffers.retouchCanvas.getContext('2d', { willReadFrequently: true });
            const rgba = rCtx?.getImageData(0, 0, buffers.width, buffers.height).data;
            if (rgba) {
              buffers.refinedBaseAlpha = refineBackgroundAlphaMask(
                rgba,
                rawAuto,
                buffers.width,
                buffers.height,
                state.bgRefinement
              );
            }
            buffers.manualAlphaDelta = assets.manualAlphaDelta
              ? new Int16Array(assets.manualAlphaDelta)
              : new Int16Array(buffers.width * buffers.height);
          }
        }

        // Reconstruct replacement background image if present
        let restoredBgImg: HTMLImageElement | null = null;
        if (bgObjectUrlRef.current) {
          URL.revokeObjectURL(bgObjectUrlRef.current);
          bgObjectUrlRef.current = null;
        }
        const restoredBgSettings: BackgroundSettings = { ...state.bgSettings };
        if (assets.bgImageBlob) {
          const bgUrl = URL.createObjectURL(assets.bgImageBlob);
          const bgImg = new Image();
          await new Promise<void>((resolve, reject) => {
            bgImg.onload = () => resolve();
            bgImg.onerror = () => reject(new Error('Could not decode replacement background image.'));
            bgImg.src = bgUrl;
          });
          bgObjectUrlRef.current = bgUrl;
          restoredBgImg = bgImg;
          restoredBgSettings.imageSrc = bgUrl;
        } else if (restoredBgSettings.mode === 'image') {
          restoredBgSettings.mode = 'transparent';
          restoredBgSettings.imageSrc = null;
        }

        // Hydrate restored state into editor atomically
        skipNextAutoSaveRef.current = true;
        projectCreatedAtRef.current = summary.createdAt;
        projectSourceBlobRef.current = { projectId: summary.id, blob: assets.sourceBlob };
        projectBgImageBlobRef.current = assets.bgImageBlob ?? null;
        assetRevisionRef.current = Math.max(1, assets.assetVersion || 1);
        savedAssetRevisionRef.current = assetRevisionRef.current;

        setActiveProjectId(summary.id);
        activeProjectIdRef.current = summary.id;
        setActiveProjectName(summary.name);
        setAutoSaveStatus('saved');
        setLastSavedAt(summary.updatedAt);
        setSaveError(null);
        setLastActiveProjectId(summary.id);
        setShowProjectsModal(false);

        invalidateMaskBasePixelCache();
        retouchBuffersRef.current = buffers;
        setSourceImage(img);
        setImageMeta({
          name: summary.fileName,
          width: img.naturalWidth,
          height: img.naturalHeight,
          fileSize: summary.fileSize,
          mimeType: summary.mimeType,
        });

        const restoredEdit = cloneEditState(state.editState);
        setDraftState(restoredEdit);
        lastCommittedStateRef.current = restoredEdit;

        const restoredMasks = cloneMaskLayers(state.maskLayers);
        setMaskLayers(restoredMasks);
        maskLayersRef.current = restoredMasks;
        setActiveMaskId(state.activeMaskId);
        activeMaskIdRef.current = state.activeMaskId;
        lastCommittedMasksRef.current = { masks: restoredMasks, activeId: state.activeMaskId };

        setBgSettings(restoredBgSettings);
        setBgRefinement({ ...state.bgRefinement });
        lastCommittedBgRefinementRef.current = { ...state.bgRefinement };
        bgRefinementBeforeAlphaRef.current = null;
        setBgLastModelLabel(state.bgLastModelLabel);
        setBgImageElement(restoredBgImg);

        clearScrubbingState();
        const alphaHasTrans = alphaMaskHasTransparency(buffers.alphaCanvas);
        setHasTransparency(state.hasTransparency || alphaHasTrans);
        setHasObjectSelection(false);
        hasObjectSelectionRef.current = false;
        setMaskPointerTool({ mode: 'idle' });
        setShowRedMask(false);
        preMaskRenderCacheRef.current = null;
        compositedPreviewCacheRef.current = null;
        geoPreviewCacheRef.current = null;
        fallbackBaseCanvasRef.current = null;
        lastRenderedHasMaskEditsRef.current = false;
        setCloneSource(null);
        setIsPickingCloneSource(false);
        setCompareMode('off');
        setIsPanToolActive(false);
        setZoomFactor(1);
        setPan({ x: 0, y: 0 });
        setShowSamplesDrawer(false);

        const restoredHistory: HistoryEntry[] = (state.historyEntries ?? []).map((entry) => {
          if (entry.kind === 'state') {
            return {
              kind: 'state',
              prev: cloneEditState(entry.prev),
              next: cloneEditState(entry.next),
            };
          }
          if (entry.kind === 'masks') {
            return {
              kind: 'masks',
              prev: cloneMaskLayers(entry.prev),
              next: cloneMaskLayers(entry.next),
              prevActiveId: entry.prevActiveId,
              nextActiveId: entry.nextActiveId,
            };
          }
          if (entry.kind === 'bg-settings') {
            return {
              kind: 'bg-settings',
              prev: { ...entry.prev },
              next: { ...entry.next },
            };
          }
          if (entry.kind === 'retouch-rgb') {
            return {
              kind: 'retouch-rgb',
              rect: entry.rect,
              retouchOp: entry.retouchOp,
            };
          }
          return {
            kind: 'retouch-alpha',
            rect: entry.rect,
            prevBgRefinement: entry.prevBgRefinement,
            nextBgRefinement: entry.nextBgRefinement,
          };
        });

        setHistory({
          entries: restoredHistory,
          cursor: Math.min(state.historyCursor, restoredHistory.length),
          archivedRetouchOps: state.archivedRetouchOps ?? [],
        });

        setMaskRenderVersion((v) => v + 1);
        setRetouchRenderTick((t) => t + 1);
      } catch (err) {
        const msg = formatIndexedDbError(err);
        setProjectsError(msg);
        setLoadError(`Could not open project: ${msg}`);
      } finally {
        setOpeningProjectId(null);
      }
    },
    [clearScrubbingState, flushPendingAutoSave, openingProjectId]
  );

  const handleRenameProject = useCallback(
    async (projectId: string, newName: string) => {
      try {
        const updated = await renameProjectInIdb(projectId, newName);
        if (activeProjectIdRef.current === projectId) {
          setActiveProjectName(updated.name);
        }
        await refreshProjectDirectory();
      } catch (err) {
        setProjectsError(formatIndexedDbError(err));
      }
    },
    [refreshProjectDirectory]
  );

  const handleDuplicateProject = useCallback(
    async (projectId: string) => {
      try {
        if (activeProjectIdRef.current === projectId) {
          await flushPendingAutoSave();
        }
        await duplicateProjectInIdb(projectId);
        await refreshProjectDirectory();
      } catch (err) {
        setProjectsError(formatIndexedDbError(err));
      }
    },
    [flushPendingAutoSave, refreshProjectDirectory]
  );

  const handleDeleteProject = useCallback(
    async (projectId: string) => {
      try {
        if (autoSaveTimerRef.current !== null && activeProjectIdRef.current === projectId) {
          window.clearTimeout(autoSaveTimerRef.current);
          autoSaveTimerRef.current = null;
        }
        await deleteProjectFromIdb(projectId);
        if (activeProjectIdRef.current === projectId) {
          activeProjectIdRef.current = null;
          setActiveProjectId(null);
          setAutoSaveStatus('idle');
          setSaveError(null);
          setLastSavedAt(null);
          setSourceImage(null);
          setImageMeta(null);
          setShowProjectsModal(false);
        }
        await refreshProjectDirectory();
      } catch (err) {
        setProjectsError(formatIndexedDbError(err));
      }
    },
    [refreshProjectDirectory]
  );

  const handleFileSelected = useCallback(
    (file: File) => {
      if (!file.type.startsWith('image/')) {
        setLoadError('Unsupported file format. Please select a JPG, PNG, or WebP image.');
        return;
      }
      const readerUrl = URL.createObjectURL(file);
      void loadImageSource(
        readerUrl,
        {
          name: file.name,
          fileSize: file.size,
          mimeType: file.type,
        },
        file
      );
    },
    [loadImageSource]
  );

  const handleSelectSample = useCallback(
    (sample: SamplePhoto) => {
      void loadImageSource(sample.src, {
        name: `${sample.title}.jpg`,
        mimeType: 'image/jpeg',
      });
    },
    [loadImageSource]
  );

  // Drag & Drop support for photos & presets
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingFile(true);
  };
  const handleDragLeave = (e: React.DragEvent) => {
    if (e.currentTarget === e.target) {
      setIsDraggingFile(false);
    }
  };
  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingFile(false);
    const file = e.dataTransfer.files?.[0];
    if (!file) return;

    const ext = file.name.toLowerCase().split('.').pop() ?? '';
    if (['xmp', 'cube', 'json', 'lrtemplate'].includes(ext)) {
      setLoadError(null);
      try {
        const result = await parsePresetFile(file);
        handleImportPreset(result.preset);
        if (isDesktop) setDesktopTab('presets');
        else setMobileSubTab('presets');
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : 'Failed to import preset file.');
      }
      return;
    }

    if (ext === 'dng') {
      setLoadError(
        'Unsupported preset format ".dng". PhotoMaster Studio supports .XMP, .CUBE, .JSON, and .LRTEMPLATE preset files.'
      );
      return;
    }

    handleFileSelected(file);
  };

  // Keyboard shortcuts (Undo, Redo, Compare, Zoom, Space-to-Pan)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!sourceImage) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
        return;
      }

      if (e.code === 'Space' && !e.repeat) {
        e.preventDefault();
        setSpacePanHeld(true);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) handleRedo();
        else handleUndo();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        handleRedo();
      } else if (e.key === '\\') {
        e.preventDefault();
        setCompareMode((prev) => (prev === 'hold' ? 'off' : 'hold'));
      } else if (e.key === '=' || e.key === '+') {
        e.preventDefault();
        setZoomFactor((z) => Math.min(8, +(z + (z >= 2 ? 0.5 : 0.25)).toFixed(2)));
      } else if (e.key === '-') {
        e.preventDefault();
        setZoomFactor((z) => {
          const step = z > 2.5 ? 0.5 : 0.25;
          const next = Math.max(0.5, +(z - step).toFixed(2));
          if (next <= 1) setPan({ x: 0, y: 0 });
          return next;
        });
      } else if (e.key === '0') {
        e.preventDefault();
        setZoomFactor(1);
        setPan({ x: 0, y: 0 });
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        setSpacePanHeld(false);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [sourceImage, handleUndo, handleRedo]);

  // Main Canvas Rendering Pipeline (coalesced via requestAnimationFrame + multi-stage caches)
  useEffect(() => {
    if (!sourceImage) return;
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
    }

    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const mainCanvas = mainCanvasRef.current;
      if (!mainCanvas) return;

      const mainCtx = mainCanvas.getContext('2d', { willReadFrequently: true });
      if (!mainCtx) return;

      const hasActiveMaskAdjusts =
        compareMode !== 'hold' &&
        maskLayers.some(
          (m) => m.enabled && m.components.length > 0 && hasNonZeroLocalAdjustments(m.adjustments)
        );
      const hasHeavySpatial =
        hasHeavySpatialAdjustments(draftState.adjustments) || hasActiveMaskAdjusts;
      const previewMaxDim = getOptimalPreviewMaxDim(isDesktop, isScrubbing, hasHeavySpatial);

      const cache = preMaskRenderCacheRef.current;
      const canReusePreMask =
        compareMode !== 'hold' &&
        cache &&
        cache.sourceImage === sourceImage &&
        cache.adjustments === draftState.adjustments &&
        cache.transform === draftState.transform &&
        cache.isCropMode === isCropMode &&
        cache.compareMode === compareMode &&
        cache.isDesktop === isDesktop &&
        cache.previewMaxDim === previewMaxDim &&
        cache.retouchRenderTick === retouchRenderTick &&
        cache.bgSettings === bgSettings &&
        cache.bgRefinement === bgRefinement &&
        cache.bgImageElement === bgImageElement;

      // Fast-path: while painting brush strokes / placing gradients before any local adjustments exist,
      // the main canvas pixels are completely unchanged — avoid copying or recalculating histogram!
      if (
        canReusePreMask &&
        cache &&
        !hasActiveMaskAdjusts &&
        !lastRenderedHasMaskEditsRef.current &&
        compareMode !== 'split' &&
        mainCanvas.width === cache.canvas.width &&
        mainCanvas.height === cache.canvas.height
      ) {
        return;
      }

      let activeSource: HTMLImageElement | HTMLCanvasElement;
      let returnedAdjImageData: ImageData | undefined;

      if (canReusePreMask && cache) {
        if (mainCanvas.width !== cache.canvas.width || mainCanvas.height !== cache.canvas.height) {
          mainCanvas.width = cache.canvas.width;
          mainCanvas.height = cache.canvas.height;
          setRenderSize({ width: cache.canvas.width, height: cache.canvas.height });
        }
        mainCtx.clearRect(0, 0, mainCanvas.width, mainCanvas.height);
        mainCtx.drawImage(cache.canvas, 0, 0);
        activeSource = cache.activeSource;
      } else {
        const applyCrop = !isCropMode;
        const buffers = retouchBuffersRef.current;
        const effectiveCompare = compareMode === 'hold' ? 'hold' : 'off';

        const compCache = compositedPreviewCacheRef.current;
        if (
          compCache &&
          compCache.sourceImage === sourceImage &&
          compCache.compareMode === effectiveCompare &&
          compCache.hasBuffers === Boolean(buffers) &&
          compCache.retouchRenderTick === retouchRenderTick &&
          compCache.bgSettings === bgSettings &&
          compCache.bgRefinement === bgRefinement &&
          compCache.bgImageElement === bgImageElement
        ) {
          activeSource = compCache.activeSource;
        } else {
          activeSource = sourceImage;
          if (buffers && compareMode !== 'hold') {
            activeSource = composeRetouchLayer(
              buffers.retouchCanvas,
              buffers.alphaCanvas,
              bgSettings,
              bgImageElement,
              buffers.width,
              buffers.height,
              bgRefinement
            );
          }
          compositedPreviewCacheRef.current = {
            sourceImage,
            compareMode: effectiveCompare,
            retouchRenderTick,
            bgSettings,
            bgRefinement,
            bgImageElement,
            hasBuffers: Boolean(buffers),
            activeSource,
          };
          geoPreviewCacheRef.current = null;
        }

        if (activeSource instanceof HTMLCanvasElement) {
          compositedBaseCanvasRef.current = activeSource;
        } else {
          let fb = fallbackBaseCanvasRef.current;
          if (!fb || fb.src !== sourceImage) {
            const tmp = document.createElement('canvas');
            tmp.width = sourceImage.naturalWidth;
            tmp.height = sourceImage.naturalHeight;
            tmp.getContext('2d')?.drawImage(sourceImage, 0, 0);
            fb = { src: sourceImage, canvas: tmp };
            fallbackBaseCanvasRef.current = fb;
          }
          compositedBaseCanvasRef.current = fb.canvas;
        }

        let geoCanvas: HTMLCanvasElement;
        const geoCache = geoPreviewCacheRef.current;
        if (
          geoCache &&
          geoCache.activeSource === activeSource &&
          geoCache.transform === draftState.transform &&
          geoCache.previewMaxDim === previewMaxDim &&
          geoCache.isCropMode === isCropMode
        ) {
          geoCanvas = geoCache.canvas;
        } else {
          geoCanvas = renderGeometryCanvas(
            activeSource,
            draftState.transform,
            previewMaxDim,
            applyCrop,
            geoCache?.canvas
          );
          geoPreviewCacheRef.current = {
            activeSource,
            transform: draftState.transform,
            previewMaxDim,
            isCropMode,
            canvas: geoCanvas,
          };
        }

        if (mainCanvas.width !== geoCanvas.width || mainCanvas.height !== geoCanvas.height) {
          mainCanvas.width = geoCanvas.width;
          mainCanvas.height = geoCanvas.height;
          setRenderSize({ width: geoCanvas.width, height: geoCanvas.height });
        }

        mainCtx.clearRect(0, 0, mainCanvas.width, mainCanvas.height);
        mainCtx.drawImage(geoCanvas, 0, 0);

        // Copy unmodified original source onto originalCanvasRef for Before/After Split Compare
        if (compareMode === 'split' && originalCanvasRef.current) {
          const origGeo = renderGeometryCanvas(
            sourceImage,
            draftState.transform,
            previewMaxDim,
            applyCrop,
            originalCanvasRef.current
          );
          const origCanvas = originalCanvasRef.current;
          if (origCanvas !== origGeo) {
            origCanvas.width = origGeo.width;
            origCanvas.height = origGeo.height;
            origCanvas.getContext('2d')?.drawImage(origGeo, 0, 0);
          }
        }

        if (compareMode !== 'hold') {
          const needHistogramNow = !isScrubbing && !hasActiveMaskAdjusts;
          returnedAdjImageData = applyAdjustmentsToCanvas(
            mainCanvas,
            draftState.adjustments,
            needHistogramNow
          );
          const preCanvas = cache?.canvas ?? document.createElement('canvas');
          if (preCanvas.width !== mainCanvas.width || preCanvas.height !== mainCanvas.height) {
            preCanvas.width = mainCanvas.width;
            preCanvas.height = mainCanvas.height;
          }
          preCanvas.getContext('2d')?.drawImage(mainCanvas, 0, 0);
          preMaskRenderCacheRef.current = {
            sourceImage,
            adjustments: draftState.adjustments,
            transform: draftState.transform,
            isCropMode,
            compareMode,
            isDesktop,
            previewMaxDim,
            retouchRenderTick,
            bgSettings,
            bgRefinement,
            bgImageElement,
            canvas: preCanvas,
            activeSource,
          };
        }
      }

      // Apply non-destructive mask layers on top of global pre-mask image unless holding Original
      lastRenderedHasMaskEditsRef.current = hasActiveMaskAdjusts;
      if (hasActiveMaskAdjusts) {
        applyMaskLayersToCanvas(mainCanvas, maskLayers, activeSource, draftState.transform);
      }

      // Update Histogram immediately when idle, or throttle during active scrubbing
      if (!isScrubbing) {
        if (histogramTimerRef.current !== null) {
          window.clearTimeout(histogramTimerRef.current);
          histogramTimerRef.current = null;
        }
        const activeImageData =
          returnedAdjImageData &&
          returnedAdjImageData.width === mainCanvas.width &&
          returnedAdjImageData.height === mainCanvas.height
            ? returnedAdjImageData
            : mainCtx.getImageData(0, 0, mainCanvas.width, mainCanvas.height);
        setHistogram(computeHistogram(activeImageData));
      } else if (histogramTimerRef.current === null) {
        histogramTimerRef.current = window.setTimeout(() => {
          histogramTimerRef.current = null;
          const mc = mainCanvasRef.current;
          const ctx = mc?.getContext('2d', { willReadFrequently: true });
          if (mc && ctx && mc.width > 0 && mc.height > 0) {
            setHistogram(computeHistogram(ctx.getImageData(0, 0, mc.width, mc.height)));
          }
        }, 120);
      }
    });

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, [
    sourceImage,
    draftState,
    maskLayers,
    isCropMode,
    compareMode,
    isDesktop,
    isScrubbing,
    retouchRenderTick,
    bgSettings,
    bgRefinement,
    bgImageElement,
  ]);

  // Adjustment & Optics handlers (ref-stabilized for React.memo children)
  const handleAdjustmentChange = useCallback(
    (key: keyof Adjustments, value: number) => {
      markScrubbingActive();
      setDraftState((prev) => ({
        ...prev,
        activePresetId: null,
        adjustments: {
          ...prev.adjustments,
          [key]: value,
        },
      }));
    },
    [markScrubbingActive]
  );

  const handleChangeAdjustmentsPatch = useCallback(
    (patch: Partial<Adjustments>, commit = false) => {
      const cur = draftStateRef.current;
      const nextState: EditState = {
        ...cur,
        activePresetId: null,
        adjustments: cloneAdjustments({
          ...cur.adjustments,
          ...patch,
        }),
      };
      if (commit) {
        commitState(nextState);
      } else {
        markScrubbingActive();
        setDraftState(nextState);
      }
    },
    [commitState, markScrubbingActive]
  );

  const handleChangeTransformOptics = useCallback(
    (
      patch: Partial<
        Pick<
          TransformState,
          'lensDistortion' | 'chromaticAberration' | 'perspectiveV' | 'perspectiveH'
        >
      >,
      commit = false
    ) => {
      const cur = draftStateRef.current;
      const nextState: EditState = {
        ...cur,
        transform: {
          ...cur.transform,
          ...patch,
        },
      };
      if (commit) {
        commitState(nextState);
      } else {
        markScrubbingActive();
        setDraftState(nextState);
      }
    },
    [commitState, markScrubbingActive]
  );

  const handleAdjustmentCommit = useCallback(() => {
    commitState(draftStateRef.current);
  }, [commitState]);

  const handleResetAdjustmentKeys = useCallback(
    (keys: (keyof Adjustments)[]) => {
      const cur = draftStateRef.current;
      const nextAdj = cloneAdjustments(cur.adjustments);
      for (const k of keys) {
        if (k === 'splitTone') {
          nextAdj.splitTone = 'none';
        } else if (k === 'whiteBalance') {
          nextAdj.whiteBalance = 'as-shot';
        } else if (k === 'lut') {
          nextAdj.lut = null;
        } else if (k === 'lutIntensity') {
          nextAdj.lutIntensity = 100;
        } else if (k === 'toneCurve') {
          nextAdj.toneCurve = cloneToneCurves(DEFAULT_TONE_CURVE);
        } else if (k === 'hsl') {
          nextAdj.hsl = cloneAdjustments({ ...DEFAULT_ADJUSTMENTS, hsl: DEFAULT_HSL_MIXER }).hsl;
        } else if (k === 'colorGrading') {
          nextAdj.colorGrading = cloneAdjustments({
            ...DEFAULT_ADJUSTMENTS,
            colorGrading: DEFAULT_COLOR_GRADING,
          }).colorGrading;
        } else {
          (nextAdj[k] as number) = 0;
        }
      }
      commitState({
        ...cur,
        activePresetId: null,
        adjustments: nextAdj,
      });
    },
    [commitState]
  );

  // Preset handlers
  const handleApplyPreset = useCallback(
    (preset: Preset) => {
      const cur = draftStateRef.current;
      const nextAdj = cloneAdjustments({
        ...DEFAULT_ADJUSTMENTS,
        ...preset.adjustments,
      });
      commitState({
        ...cur,
        activePresetId: preset.id,
        adjustments: nextAdj,
      });
    },
    [commitState]
  );

  const handleSaveCustomPreset = useCallback(
    (name: string, category?: Exclude<PresetCategory, 'All' | 'My Presets'>) => {
      const cur = draftStateRef.current;
      const newPreset: Preset = {
        id: `custom-${Date.now()}`,
        name,
        category,
        isCustom: true,
        sourceFormat: 'custom',
        createdAt: new Date().toISOString(),
        adjustments: cloneAdjustments(cur.adjustments),
      };
      setCustomPresets((prev) => [newPreset, ...prev]);
      setDraftState((prev) => ({ ...prev, activePresetId: newPreset.id }));
    },
    []
  );

  const handleImportPreset = useCallback(
    (preset: Preset) => {
      const cur = draftStateRef.current;
      setCustomPresets((prev) => [preset, ...prev]);
      const nextAdj = cloneAdjustments({
        ...DEFAULT_ADJUSTMENTS,
        ...preset.adjustments,
      });
      commitState({
        ...cur,
        activePresetId: preset.id,
        adjustments: nextAdj,
      });
    },
    [commitState]
  );

  const handleRenameCustomPreset = useCallback((id: string, newName: string) => {
    setCustomPresets((prev) =>
      prev.map((p) => (p.id === id ? { ...p, name: newName } : p))
    );
  }, []);

  const handleDeleteCustomPreset = useCallback((id: string) => {
    setCustomPresets((prev) => prev.filter((p) => p.id !== id));
    if (draftStateRef.current.activePresetId === id) {
      setDraftState((prev) => ({ ...prev, activePresetId: null }));
    }
  }, []);

  const handleLutIntensityChange = useCallback(
    (intensity: number) => {
      markScrubbingActive();
      setDraftState((prev) => ({
        ...prev,
        adjustments: {
          ...prev.adjustments,
          lutIntensity: intensity,
        },
      }));
    },
    [markScrubbingActive]
  );

  const handleClearLut = useCallback(() => {
    const cur = draftStateRef.current;
    commitState({
      ...cur,
      activePresetId: null,
      adjustments: {
        ...cur.adjustments,
        lut: null,
        lutIntensity: 100,
      },
    });
  }, [commitState]);

  // Retouch & Background Remover handlers
  const handleCommitDirtyPatch = useCallback(
    (
      target: 'rgb' | 'alpha',
      rect: DirtyRect,
      before: ImageData,
      after: ImageData,
      retouchOp?: RetouchOperation
    ) => {
      assetRevisionRef.current += 1;
      if (target === 'rgb') {
        pushHistoryEntry({ kind: 'retouch-rgb', rect, before, after, retouchOp });
      } else {
        refreshTransparencyFlag();
        pushHistoryEntry({
          kind: 'retouch-alpha',
          rect,
          beforeAlpha: imageDataAlphaToUint8(before),
          afterAlpha: imageDataAlphaToUint8(after),
        });
      }
      setRetouchRenderTick((t) => t + 1);
    },
    [pushHistoryEntry, refreshTransparencyFlag]
  );

  const handleClearObjectSelection = useCallback(() => {
    const buf = retouchBuffersRef.current;
    if (!buf) return;
    buf.objectMaskCanvas.getContext('2d')?.clearRect(0, 0, buf.width, buf.height);
    hasObjectSelectionRef.current = false;
    setHasObjectSelection(false);
    setMaskRenderVersion((v) => v + 1);
  }, []);

  const handleRunObjectRemoval = useCallback(async () => {
    const buf = retouchBuffersRef.current;
    if (!buf) return;
    setIsProcessingInpaint(true);
    await new Promise((r) => setTimeout(r, 20));

    try {
      const maskPatch = extractObjectMaskPatch(buf.objectMaskCanvas);
      const result = await inpaintObjectRemovalAsync(buf.retouchCanvas, buf.objectMaskCanvas);
      if (result) {
        assetRevisionRef.current += 1;
        const retouchOp: RetouchOperation | undefined = maskPatch
          ? {
              id: `retouch-obj-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
              kind: 'object-removal',
              normRect: maskPatch.normRect,
              maskWidth: maskPatch.maskWidth,
              maskHeight: maskPatch.maskHeight,
              maskBytes: maskPatch.maskBytes,
            }
          : undefined;
        pushHistoryEntry({
          kind: 'retouch-rgb',
          rect: result.rect,
          before: result.before,
          after: result.after,
          retouchOp,
        });
      }
      buf.objectMaskCanvas.getContext('2d')?.clearRect(0, 0, buf.width, buf.height);
      hasObjectSelectionRef.current = false;
      setHasObjectSelection(false);
      setMaskRenderVersion((v) => v + 1);
      setRetouchRenderTick((t) => t + 1);
    } finally {
      setIsProcessingInpaint(false);
    }
  }, [pushHistoryEntry]);

  const handleAutoRemoveBackground = useCallback(async () => {
    const buf = retouchBuffersRef.current;
    if (!buf) return;
    const curRefinement = bgRefinementRef.current;
    setIsProcessingBg(true);
    setBgProgress({
      stage: 'loading-model',
      progress: 5,
      message: 'Initializing segmentation model...',
    });
    await new Promise((r) => setTimeout(r, 20));

    try {
      const outcome = await autoRemoveBackgroundAsync(buf, curRefinement, (p) => {
        setBgProgress(p);
      });
      if (outcome) {
        assetRevisionRef.current += 1;
        const { patch, usedModelId, usedDevice } = outcome;
        const friendlyModel = usedModelId.includes('modnet')
          ? `MODNet Portrait (${usedDevice})`
          : usedModelId.includes('RMBG')
            ? `RMBG-1.4 (${usedDevice})`
            : 'Offline Geodesic Fallback';
        setBgLastModelLabel(friendlyModel);
        pushHistoryEntry({
          kind: 'retouch-alpha',
          rect: patch.rect,
          beforeAlpha: imageDataAlphaToUint8(patch.before),
          afterAlpha: imageDataAlphaToUint8(patch.after),
          prevBgRefinement: lastCommittedBgRefinementRef.current,
          nextBgRefinement: curRefinement,
        });
        lastCommittedBgRefinementRef.current = curRefinement;
        bgRefinementBeforeAlphaRef.current = null;
        refreshTransparencyFlag();
        setMaskRenderVersion((v) => v + 1);
        setRetouchRenderTick((t) => t + 1);
      }
    } finally {
      setIsProcessingBg(false);
      setBgProgress(null);
    }
  }, [pushHistoryEntry, refreshTransparencyFlag]);

  const handleChangeBgRefinement = useCallback(
    (next: BgRefinementSettings, commit = false) => {
      const prev = bgRefinementRef.current;
      bgRefinementRef.current = next;
      setBgRefinement(next);

      const buf = retouchBuffersRef.current;
      if (!buf) return;

      const hasMask = Boolean(buf.rawAutoAlpha) || alphaMaskHasTransparency(buf.alphaCanvas);
      if (!hasMask) {
        if (commit) {
          lastCommittedBgRefinementRef.current = next;
        }
        return;
      }

      const fullRect: DirtyRect = { x: 0, y: 0, width: buf.width, height: buf.height };
      if (!bgRefinementBeforeAlphaRef.current) {
        bgRefinementBeforeAlphaRef.current = extractAlphaRect(buf.alphaCanvas, fullRect);
      }

      const maskShapeChanged =
        prev.mode !== next.mode ||
        prev.refineEdge !== next.refineEdge ||
        prev.feather !== next.feather ||
        prev.smooth !== next.smooth ||
        prev.contrast !== next.contrast ||
        prev.expandContract !== next.expandContract ||
        prev.hairRefinement !== next.hairRefinement;

      if (maskShapeChanged || (commit && buf.rawAutoAlpha)) {
        assetRevisionRef.current += 1;
        applyRefinementToAlphaBuffer(buf, next);
        refreshTransparencyFlag();
        setMaskRenderVersion((v) => v + 1);
      }

      setRetouchRenderTick((t) => t + 1);

      if (commit) {
        assetRevisionRef.current += 1;
        const beforeSnap =
          bgRefinementBeforeAlphaRef.current ?? extractAlphaRect(buf.alphaCanvas, fullRect);
        const afterSnap = extractAlphaRect(buf.alphaCanvas, fullRect);
        bgRefinementBeforeAlphaRef.current = null;

        pushHistoryEntry({
          kind: 'retouch-alpha',
          rect: fullRect,
          beforeAlpha: beforeSnap,
          afterAlpha: afterSnap,
          prevBgRefinement: lastCommittedBgRefinementRef.current,
          nextBgRefinement: next,
        });
        lastCommittedBgRefinementRef.current = next;
      }
    },
    [pushHistoryEntry, refreshTransparencyFlag]
  );

  const handleSnapManualSelection = useCallback(() => {
    const buf = retouchBuffersRef.current;
    if (!buf) return;
    const curRefinement = bgRefinementRef.current;
    const res = applyManualSelectionSnap(buf, curRefinement);
    if (!res) return;
    assetRevisionRef.current += 1;
    pushHistoryEntry({
      kind: 'retouch-alpha',
      rect: res.rect,
      beforeAlpha: imageDataAlphaToUint8(res.before),
      afterAlpha: imageDataAlphaToUint8(res.after),
      prevBgRefinement: lastCommittedBgRefinementRef.current,
      nextBgRefinement: curRefinement,
    });
    lastCommittedBgRefinementRef.current = curRefinement;
    bgRefinementBeforeAlphaRef.current = null;
    refreshTransparencyFlag();
    setMaskRenderVersion((v) => v + 1);
    setRetouchRenderTick((t) => t + 1);
  }, [pushHistoryEntry, refreshTransparencyFlag]);

  const handleClearAlphaToEmpty = useCallback(() => {
    const buf = retouchBuffersRef.current;
    if (!buf) return;
    const res = fillAlphaCanvasUniform(buf, 0);
    if (!res) return;
    assetRevisionRef.current += 1;
    pushHistoryEntry({
      kind: 'retouch-alpha',
      rect: res.rect,
      beforeAlpha: imageDataAlphaToUint8(res.before),
      afterAlpha: imageDataAlphaToUint8(res.after),
    });
    bgRefinementBeforeAlphaRef.current = null;
    setHasTransparency(true);
    setMaskRenderVersion((v) => v + 1);
    setRetouchRenderTick((t) => t + 1);
  }, [pushHistoryEntry]);

  const handleResetAlphaMask = useCallback(() => {
    const buf = retouchBuffersRef.current;
    if (!buf) return;
    const res = fillAlphaCanvasUniform(buf, 255);
    if (!res) return;
    assetRevisionRef.current += 1;
    pushHistoryEntry({
      kind: 'retouch-alpha',
      rect: res.rect,
      beforeAlpha: imageDataAlphaToUint8(res.before),
      afterAlpha: imageDataAlphaToUint8(res.after),
    });
    bgRefinementBeforeAlphaRef.current = null;
    setHasTransparency(false);
    setMaskRenderVersion((v) => v + 1);
    setRetouchRenderTick((t) => t + 1);
  }, [pushHistoryEntry]);

  const handleChangeBgSettings = useCallback(
    (next: BackgroundSettings) => {
      const prev = bgSettingsRef.current;
      bgSettingsRef.current = next;
      setBgSettings(next);
      if (prev.mode !== next.mode || prev.color !== next.color || prev.imageSrc !== next.imageSrc) {
        pushHistoryEntry({ kind: 'bg-settings', prev, next });
      }
    },
    [pushHistoryEntry]
  );

  const handleUploadBgImage = useCallback(
    (file: File) => {
      if (!file.type.startsWith('image/')) {
        setLoadError('Please select a valid image file for the replacement background.');
        return;
      }
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        if (bgObjectUrlRef.current) {
          URL.revokeObjectURL(bgObjectUrlRef.current);
        }
        bgObjectUrlRef.current = url;
        projectBgImageBlobRef.current = file;
        assetRevisionRef.current += 1;
        setBgImageElement(img);
        handleChangeBgSettings({
          ...bgSettingsRef.current,
          mode: 'image',
          imageSrc: url,
          imageName: file.name,
        });
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        setLoadError('Could not load replacement background image.');
      };
      img.src = url;
    },
    [handleChangeBgSettings]
  );

  // ---------- NON-DESTRUCTIVE MASKING HANDLERS ----------
  const commitMaskChange = useCallback(
    (nextMasks: MaskLayer[], nextActiveId: string | null) => {
      const prevSnap = cloneMaskLayers(lastCommittedMasksRef.current.masks);
      const nextSnap = cloneMaskLayers(nextMasks);
      const prevId = lastCommittedMasksRef.current.activeId;
      maskLayersRef.current = nextSnap;
      activeMaskIdRef.current = nextActiveId;
      setMaskLayers(nextSnap);
      setActiveMaskId(nextActiveId);
      lastCommittedMasksRef.current = { masks: nextSnap, activeId: nextActiveId };
      pushHistoryEntry({
        kind: 'masks',
        prev: prevSnap,
        next: nextSnap,
        prevActiveId: prevId,
        nextActiveId,
      });
    },
    [pushHistoryEntry]
  );

  const getBaseSourceCanvasForMasks = useCallback((): HTMLCanvasElement | null => {
    if (compositedBaseCanvasRef.current) return compositedBaseCanvasRef.current;
    if (retouchBuffersRef.current) return retouchBuffersRef.current.retouchCanvas;
    if (!sourceImage) return null;
    let fb = fallbackBaseCanvasRef.current;
    if (!fb || fb.src !== sourceImage) {
      const c = document.createElement('canvas');
      c.width = sourceImage.naturalWidth;
      c.height = sourceImage.naturalHeight;
      c.getContext('2d')?.drawImage(sourceImage, 0, 0);
      fb = { src: sourceImage, canvas: c };
      fallbackBaseCanvasRef.current = fb;
    }
    return fb.canvas;
  }, [sourceImage]);

  const handleUpdateMaskLayer = useCallback(
    (maskId: string, updater: (prev: MaskLayer) => MaskLayer, commit = false) => {
      const nextList = maskLayersRef.current.map((m) => (m.id === maskId ? updater(m) : m));
      if (commit) {
        const prevSnap = cloneMaskLayers(lastCommittedMasksRef.current.masks);
        const nextSnap = cloneMaskLayers(nextList);
        const prevId = lastCommittedMasksRef.current.activeId;
        const curActiveId = activeMaskIdRef.current;
        maskLayersRef.current = nextSnap;
        setMaskLayers(nextSnap);
        lastCommittedMasksRef.current = { masks: nextSnap, activeId: curActiveId };
        pushHistoryEntry({
          kind: 'masks',
          prev: prevSnap,
          next: nextSnap,
          prevActiveId: prevId,
          nextActiveId: curActiveId,
        });
      } else {
        maskLayersRef.current = nextList;
        setMaskLayers(nextList);
      }
    },
    [pushHistoryEntry]
  );

  const handleStartMaskPhotoEditing = useCallback(() => {
    setMaskPointerTool((prev) => (prev.mode === 'idle' ? prev : { mode: 'idle' }));
    setShowRedMask((prev) => (prev ? false : prev));
  }, []);

  const handleEditWithBrush = useCallback(
    (maskId: string, op: 'add' | 'subtract' = 'add') => {
      const target = maskLayersRef.current.find((m) => m.id === maskId);
      if (!target) return;
      const baseCanvas = getBaseSourceCanvasForMasks();
      if (!baseCanvas) return;

      const existingBrush = [...target.components]
        .reverse()
        .find((c) => c.kind === 'brush' && c.op === op);

      setShowRedMask(false);
      setIsPanToolActive(false);

      if (existingBrush) {
        const nextList = maskLayersRef.current.map((m) =>
          m.id === maskId ? { ...m, showOverlay: true } : m
        );
        maskLayersRef.current = nextList;
        setMaskLayers(nextList);
        setActiveMaskId(maskId);
        activeMaskIdRef.current = maskId;
        setMaskPointerTool({ mode: 'brush', op, componentId: existingBrush.id });
        return;
      }

      const { width: baseW, height: baseH } = getMaskRasterDimensions(
        baseCanvas.width,
        baseCanvas.height
      );
      const compId = `comp-brush-${Date.now()}`;
      const comp: MaskComponent = {
        id: compId,
        op,
        kind: 'brush',
        raster: {
          width: baseW,
          height: baseH,
          data: new Uint8Array(baseW * baseH),
        },
      };
      const nextList = maskLayersRef.current.map((m) =>
        m.id === maskId
          ? { ...m, showOverlay: true, components: [...m.components, comp] }
          : m
      );
      commitMaskChange(nextList, maskId);
      setMaskPointerTool({ mode: 'brush', op, componentId: compId });
    },
    [commitMaskChange, getBaseSourceCanvasForMasks]
  );

  const handleCreateMaskWithTool = useCallback(
    async (tool: MaskCreationTool, op?: MaskOperation) => {
      const baseCanvas = getBaseSourceCanvasForMasks();
      if (!baseCanvas) return;

      const curActiveId = activeMaskIdRef.current;
      const curList = maskLayersRef.current;
      const isModifyingActive = Boolean(op && curActiveId);
      const effectiveOp: MaskOperation = op ?? 'add';

      setShowRedMask(false);
      setIsPanToolActive(false);

      const appendOrCreateMask = (
        defaultTitle: string,
        componentsToAdd: MaskComponent[],
        nextPointerTool: ActiveMaskPointerTool
      ) => {
        if (isModifyingActive && curActiveId) {
          const nextList = curList.map((m) =>
            m.id === curActiveId
              ? { ...m, showOverlay: true, components: [...m.components, ...componentsToAdd] }
              : m
          );
          commitMaskChange(nextList, curActiveId);
          setMaskPointerTool(nextPointerTool);
        } else {
          const newId = `mask-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
          const newLayer: MaskLayer = {
            id: newId,
            name: `${defaultTitle} ${curList.length + 1}`,
            enabled: true,
            inverted: false,
            overlayColor: '#ef4444',
            showOverlay: true,
            feather: 0,
            density: 100,
            edgeRefinement: 15,
            components: componentsToAdd,
            adjustments: { ...DEFAULT_LOCAL_ADJUSTMENTS },
          };
          commitMaskChange([newLayer, ...curList], newId);
          setMaskPointerTool(nextPointerTool);
        }
      };

      if (tool === 'subject' || tool === 'sky' || tool === 'background') {
        setIsSegmentingMask(true);
        await new Promise((r) => setTimeout(r, 20));
        try {
          const raster =
            tool === 'subject'
              ? computeSubjectRasterMask(baseCanvas)
              : tool === 'sky'
                ? computeSkyRasterMask(baseCanvas)
                : computeBackgroundRasterMask(baseCanvas);
          const labelMap = {
            subject: 'Select Subject',
            sky: 'Select Sky',
            background: 'Select Background',
          };
          const comp: MaskComponent = {
            id: `comp-${tool}-${Date.now()}`,
            op: effectiveOp,
            kind: tool,
            raster,
            label: labelMap[tool],
          };
          appendOrCreateMask(
            tool === 'subject' ? 'Subject' : tool === 'sky' ? 'Sky' : 'Background',
            [comp],
            { mode: 'idle' }
          );
        } finally {
          setIsSegmentingMask(false);
        }
        return;
      }

      if (tool === 'brush') {
        const { width: baseW, height: baseH } = getMaskRasterDimensions(
          baseCanvas.width,
          baseCanvas.height
        );
        const compId = `comp-brush-${Date.now()}`;
        const comp: MaskComponent = {
          id: compId,
          op: effectiveOp,
          kind: 'brush',
          raster: {
            width: baseW,
            height: baseH,
            data: new Uint8Array(baseW * baseH),
          },
        };
        appendOrCreateMask('Brush Mask', [comp], {
          mode: 'brush',
          op: effectiveOp === 'subtract' ? 'subtract' : 'add',
          componentId: compId,
        });
        return;
      }

      if (tool === 'linear') {
        if (isModifyingActive && curActiveId) {
          handleUpdateMaskLayer(curActiveId, (m) => ({ ...m, showOverlay: true }));
          setMaskPointerTool({ mode: 'create-linear', op: effectiveOp });
        } else {
          appendOrCreateMask('Linear Gradient', [], {
            mode: 'create-linear',
            op: 'add',
          });
        }
        return;
      }

      if (tool === 'radial') {
        if (isModifyingActive && curActiveId) {
          handleUpdateMaskLayer(curActiveId, (m) => ({ ...m, showOverlay: true }));
          setMaskPointerTool({ mode: 'create-radial', op: effectiveOp });
        } else {
          appendOrCreateMask('Radial Gradient', [], {
            mode: 'create-radial',
            op: 'add',
          });
        }
        return;
      }

      if (tool === 'object') {
        if (isModifyingActive && curActiveId) {
          handleUpdateMaskLayer(curActiveId, (m) => ({ ...m, showOverlay: true }));
          setMaskPointerTool({ mode: 'create-object', op: effectiveOp });
        } else {
          appendOrCreateMask('Object', [], {
            mode: 'create-object',
            op: 'add',
          });
        }
        return;
      }

      if (tool === 'color-range') {
        const compId = `comp-col-${Date.now()}`;
        const comp: MaskComponent = {
          id: compId,
          op: effectiveOp,
          kind: 'color-range',
          targetRgb: [128, 148, 180],
          tolerance: 32,
          smoothness: 35,
        };
        appendOrCreateMask('Color Range', [comp], {
          mode: 'pick-color',
          componentId: compId,
        });
        return;
      }

      if (tool === 'luminance-range') {
        const compId = `comp-lum-${Date.now()}`;
        const comp: MaskComponent = {
          id: compId,
          op: effectiveOp,
          kind: 'luminance-range',
          minLum: 35,
          maxLum: 85,
          smoothness: 25,
        };
        appendOrCreateMask('Luminance Range', [comp], { mode: 'idle' });
      }
    },
    [commitMaskChange, getBaseSourceCanvasForMasks, handleUpdateMaskLayer]
  );

  const handleFinishObjectBox = useCallback(
    async (
      box: { x: number; y: number; width: number; height: number },
      op: MaskOperation
    ) => {
      const baseCanvas = getBaseSourceCanvasForMasks();
      const curActiveId = activeMaskIdRef.current;
      if (!baseCanvas || !curActiveId) return;
      setIsSegmentingMask(true);
      await new Promise((r) => setTimeout(r, 15));
      try {
        const raster = computeObjectSelectionRasterMask(baseCanvas, box);
        const comp: MaskComponent = {
          id: `comp-obj-${Date.now()}`,
          op,
          kind: 'object',
          raster,
          label: 'Object Selection',
        };
        const nextList = maskLayersRef.current.map((m) =>
          m.id === curActiveId
            ? { ...m, showOverlay: true, components: [...m.components, comp] }
            : m
        );
        commitMaskChange(nextList, curActiveId);
        setMaskPointerTool({ mode: 'idle' });
      } finally {
        setIsSegmentingMask(false);
      }
    },
    [commitMaskChange, getBaseSourceCanvasForMasks]
  );

  const handleCreateGradientComponent = useCallback((comp: MaskComponent) => {
    const curActiveId = activeMaskIdRef.current;
    if (!curActiveId) return;
    const nextList = maskLayersRef.current.map((m) =>
      m.id === curActiveId ? { ...m, components: [...m.components, comp] } : m
    );
    maskLayersRef.current = nextList;
    setMaskLayers(nextList);
  }, []);

  const handleIntersectWithMask = useCallback(
    (targetMaskId: string, sourceMaskId: string) => {
      const baseCanvas = getBaseSourceCanvasForMasks();
      const sourceLayer = maskLayersRef.current.find((m) => m.id === sourceMaskId);
      if (!baseCanvas || !sourceLayer) return;

      const { width: baseW, height: baseH } = getMaskRasterDimensions(
        baseCanvas.width,
        baseCanvas.height
      );
      const tmp = document.createElement('canvas');
      tmp.width = baseW;
      tmp.height = baseH;
      const tCtx = tmp.getContext('2d', { willReadFrequently: true });
      tCtx?.drawImage(baseCanvas, 0, 0, baseW, baseH);
      const baseRgba = tCtx?.getImageData(0, 0, baseW, baseH).data;

      const alphaF = evaluateMaskLayerBaseAlpha(sourceLayer, baseW, baseH, baseRgba);
      const data = new Uint8Array(baseW * baseH);
      for (let i = 0; i < data.length; i++) {
        data[i] = Math.max(0, Math.min(255, Math.round(alphaF[i] * 255)));
      }

      const comp: MaskComponent = {
        id: `comp-ref-${Date.now()}`,
        op: 'intersect',
        kind: 'mask-ref',
        sourceMaskId,
        sourceRaster: { width: baseW, height: baseH, data },
        label: `Intersect: ${sourceLayer.name}`,
      };
      const nextList = maskLayersRef.current.map((m) =>
        m.id === targetMaskId ? { ...m, components: [...m.components, comp] } : m
      );
      commitMaskChange(nextList, targetMaskId);
    },
    [commitMaskChange, getBaseSourceCanvasForMasks]
  );

  const handleInvertMask = useCallback(
    (maskId: string) => {
      const nextList = maskLayersRef.current.map((m) =>
        m.id === maskId ? { ...m, inverted: !m.inverted } : m
      );
      commitMaskChange(nextList, activeMaskIdRef.current);
    },
    [commitMaskChange]
  );

  const handleDuplicateMask = useCallback(
    (maskId: string) => {
      const curList = maskLayersRef.current;
      const idx = curList.findIndex((m) => m.id === maskId);
      if (idx === -1) return;
      const copy = cloneMaskLayers([curList[idx]])[0];
      copy.id = `mask-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
      copy.name = `${copy.name} Copy`;
      const nextList = [...curList];
      nextList.splice(idx, 0, copy);
      commitMaskChange(nextList, copy.id);
    },
    [commitMaskChange]
  );

  const handleDeleteMask = useCallback(
    (maskId: string) => {
      const nextList = maskLayersRef.current.filter((m) => m.id !== maskId);
      const curActiveId = activeMaskIdRef.current;
      const nextActive =
        curActiveId === maskId ? (nextList[0]?.id ?? null) : curActiveId;
      commitMaskChange(nextList, nextActive);
      setMaskPointerTool({ mode: 'idle' });
      if (nextList.length === 0) setShowRedMask(false);
    },
    [commitMaskChange]
  );

  const handleRemoveMaskComponent = useCallback(
    (maskId: string, compId: string) => {
      const nextList = maskLayersRef.current.map((m) =>
        m.id === maskId
          ? { ...m, components: m.components.filter((c) => c.id !== compId) }
          : m
      );
      commitMaskChange(nextList, activeMaskIdRef.current);
      setMaskPointerTool({ mode: 'idle' });
    },
    [commitMaskChange]
  );

  // Crop & Transform handlers (ref-stabilized for React.memo)
  const handleRotate90 = useCallback(
    (dir: 1 | -1) => {
      const cur = draftStateRef.current;
      const nextRot = (((cur.transform.rotate90 + dir) % 4) + 4) % 4 as 0 | 1 | 2 | 3;
      const nextTransform = {
        ...cur.transform,
        rotate90: nextRot,
      };
      commitState({ ...cur, transform: nextTransform });
    },
    [commitState]
  );

  const handleFlip = useCallback(
    (axis: 'h' | 'v') => {
      const cur = draftStateRef.current;
      const nextTransform = {
        ...cur.transform,
        flipH: axis === 'h' ? !cur.transform.flipH : cur.transform.flipH,
        flipV: axis === 'v' ? !cur.transform.flipV : cur.transform.flipV,
      };
      commitState({ ...cur, transform: nextTransform });
    },
    [commitState]
  );

  const handleStraightenChange = useCallback(
    (angle: number) => {
      markScrubbingActive();
      setDraftState((prev) => ({
        ...prev,
        transform: { ...prev.transform, straighten: angle },
      }));
    },
    [markScrubbingActive]
  );

  const handleAspectChange = useCallback(
    (aspect: AspectRatioOption) => {
      if (!sourceImage) return;
      const cur = draftStateRef.current;
      const { width: rotW, height: rotH } = getRotatedDimensions(
        sourceImage.naturalWidth,
        sourceImage.naturalHeight,
        cur.transform.rotate90
      );
      const target = getTargetAspectRatio(aspect, rotW, rotH);
      const fittedCrop = fitCropToAspect(cur.transform.crop, target, rotW, rotH);
      commitState({
        ...cur,
        transform: {
          ...cur.transform,
          aspectRatio: aspect,
          crop: fittedCrop,
        },
      });
    },
    [commitState, sourceImage]
  );

  const handleCropChange = useCallback(
    (crop: CropRect) => {
      markScrubbingActive();
      setDraftState((prev) => ({
        ...prev,
        transform: { ...prev.transform, crop },
      }));
    },
    [markScrubbingActive]
  );

  const handleResetCrop = useCallback(() => {
    const cur = draftStateRef.current;
    commitState({
      ...cur,
      transform: {
        ...DEFAULT_TRANSFORM,
        crop: { ...DEFAULT_TRANSFORM.crop },
      },
    });
  }, [commitState]);

  const handleCropCommit = useCallback(() => {
    commitState(draftStateRef.current);
  }, [commitState]);

  const handleSwitchBackToHandles = useCallback(() => {
    setMaskPointerTool((prev) =>
      prev.mode === 'create-linear' || prev.mode === 'create-radial'
        ? { mode: 'edit-handles' }
        : { mode: 'idle' }
    );
  }, []);

  const handleSelectMask = useCallback((id: string | null) => {
    setActiveMaskId(id);
    setMaskPointerTool({ mode: 'idle' });
  }, []);

  const handleToggleShowRedMask = useCallback(() => {
    setShowRedMask((v) => !v);
  }, []);

  const handleUpdateMaskBrushSettings = useCallback((patch: Partial<MaskBrushSettings>) => {
    setMaskBrushSettings((prev) => ({ ...prev, ...patch }));
  }, []);

  const handleSetMaskPointerTool = useCallback((tool: ActiveMaskPointerTool) => {
    setMaskPointerTool(tool);
    setIsPanToolActive(false);
  }, []);

  const handleSelectRetouchTool = useCallback((t: RetouchTool) => {
    setRetouchTool(t);
    setIsPanToolActive(false);
  }, []);

  const handleUpdateRetouchBrushConfig = useCallback((patch: Partial<RetouchBrushConfig>) => {
    setBrushConfig((prev) => ({ ...prev, ...patch }));
  }, []);

  const handleTogglePickCloneSource = useCallback(() => {
    setIsPickingCloneSource((v) => !v);
  }, []);

  const handleSetCloneSource = useCallback((pt: CloneSourcePoint) => {
    setCloneSource(pt);
    setIsPickingCloneSource(false);
  }, []);

  const handleRetouchLiveUpdate = useCallback(() => {
    setRetouchRenderTick((t) => t + 1);
  }, []);

  const handleObjectMaskPainted = useCallback(() => {
    if (hasObjectSelectionRef.current) return;
    const buf = retouchBuffersRef.current;
    if (buf && hasObjectMaskPixels(buf.objectMaskCanvas)) {
      hasObjectSelectionRef.current = true;
      setHasObjectSelection(true);
    }
  }, []);

  const handleDoneDesktopCrop = useCallback(() => setDesktopTab('edit'), []);
  const handleDoneMobileCrop = useCallback(() => setMobileSubTab('adjust'), []);

  // Compute display box size inside workspace
  const pad = isDesktop ? 48 : 24;
  const availW = Math.max(120, workspaceSize.width - pad);
  const availH = Math.max(120, workspaceSize.height - pad);
  const fitScale = Math.min(
    availW / Math.max(1, renderSize.width),
    availH / Math.max(1, renderSize.height)
  );
  const displayW = Math.round(renderSize.width * fitScale * zoomFactor);
  const displayH = Math.round(renderSize.height * fitScale * zoomFactor);

  // Canvas zoom/pan handlers
  const handleWheelZoom = (e: React.WheelEvent) => {
    if (!sourceImage || isCropMode) return;
    if (Math.abs(e.deltaY) < 2) return;
    e.preventDefault();
    setZoomFactor((z) => {
      const step = z >= 2.5 ? 0.35 : 0.15;
      const delta = e.deltaY < 0 ? step : -step;
      const next = Math.max(0.5, Math.min(8, +(z + delta).toFixed(2)));
      if (next <= 1) setPan({ x: 0, y: 0 });
      return next;
    });
  };

  const handleCanvasPointerDown = (e: React.PointerEvent) => {
    if (!sourceImage || isCropMode) return;
    const isMiddleButton = e.button === 1;
    if (!isMiddleButton && (isRetouchMode || isMaskMode) && !effectivePanMode && compareMode === 'off') {
      return;
    }
    if (!isMiddleButton && zoomFactor <= 1 && !effectivePanMode) return;
    if (isMiddleButton) {
      e.preventDefault();
    }
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    panDragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      origPanX: pan.x,
      origPanY: pan.y,
    };
  };

  const handleCanvasPointerMove = (e: React.PointerEvent) => {
    if (!panDragRef.current) return;
    setPan({
      x: panDragRef.current.origPanX + (e.clientX - panDragRef.current.startX),
      y: panDragRef.current.origPanY + (e.clientY - panDragRef.current.startY),
    });
  };

  const handleCanvasPointerUp = (e: React.PointerEvent) => {
    if (!panDragRef.current) return;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // Ignore
    }
    panDragRef.current = null;
  };

  const outputDims = sourceImage
    ? getOutputDimensions(
        sourceImage.naturalWidth,
        sourceImage.naturalHeight,
        draftState.transform
      )
    : null;

  const hasEdits =
    hasNonZeroAdjustments(draftState.adjustments) ||
    maskLayers.length > 0 ||
    hasRetouchEdits ||
    hasTransparency ||
    draftState.transform.rotate90 !== 0 ||
    draftState.transform.straighten !== 0 ||
    draftState.transform.flipH ||
    draftState.transform.flipV ||
    draftState.transform.lensDistortion !== 0 ||
    draftState.transform.chromaticAberration !== 0 ||
    draftState.transform.perspectiveV !== 0 ||
    draftState.transform.perspectiveH !== 0 ||
    draftState.transform.crop.width < 0.999 ||
    draftState.transform.crop.height < 0.999;

  return (
    <div
      className="flex h-[100dvh] w-screen flex-col bg-[#09090b] text-zinc-100 overflow-hidden select-none"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Hidden File Input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleFileSelected(file);
          e.target.value = '';
        }}
      />

      {/* TOP STUDIO HEADER */}
      <header className="flex h-12 shrink-0 items-center justify-between gap-2 sm:gap-3 border-b border-white/[0.08] bg-[#111114] px-3 sm:px-4 z-30">
        <div className="flex items-center gap-2.5 min-w-0">
          <img src="/icon.svg" alt="" className="h-6 w-6 rounded shrink-0" />
          <span className="text-sm font-semibold tracking-tight text-white whitespace-nowrap">
            PhotoMaster Studio
          </span>

          {sourceImage && activeProjectId && (
            <>
              <span className="hidden md:inline text-zinc-700" aria-hidden="true">
                /
              </span>
              {isEditingHeaderName ? (
                <input
                  type="text"
                  value={headerNameDraft}
                  onChange={(e) => setHeaderNameDraft(e.target.value)}
                  onBlur={() => {
                    const clean = headerNameDraft.trim();
                    if (clean && clean !== activeProjectName) {
                      void handleRenameProject(activeProjectId, clean);
                    }
                    setIsEditingHeaderName(false);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      const clean = headerNameDraft.trim();
                      if (clean && clean !== activeProjectName) {
                        void handleRenameProject(activeProjectId, clean);
                      }
                      setIsEditingHeaderName(false);
                    } else if (e.key === 'Escape') {
                      setIsEditingHeaderName(false);
                    }
                  }}
                  autoFocus
                  maxLength={80}
                  aria-label="Edit project name"
                  className="hidden md:block w-36 rounded border border-white/30 bg-zinc-950 px-2 py-0.5 text-xs font-medium text-white focus:border-white focus:outline-none"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setHeaderNameDraft(activeProjectName);
                    setIsEditingHeaderName(true);
                  }}
                  title="Click to rename project"
                  className="hidden md:block max-w-[150px] truncate text-xs font-medium text-zinc-300 hover:text-white transition-colors"
                >
                  {activeProjectName}
                </button>
              )}

              {/* Auto-Save Status Indicator (Saving / Saved / Save Failed) */}
              <div className="flex items-center gap-1.5 text-[11px] shrink-0" aria-live="polite">
                {autoSaveStatus === 'saving' && (
                  <span className="flex items-center gap-1 text-zinc-400 whitespace-nowrap">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    <span className="hidden sm:inline">Saving...</span>
                  </span>
                )}
                {autoSaveStatus === 'saved' && (
                  <span
                    className="flex items-center gap-1 text-zinc-400 whitespace-nowrap"
                    title={lastSavedAt ? `Saved locally at ${new Date(lastSavedAt).toLocaleTimeString()}` : 'Saved locally'}
                  >
                    <Check className="h-3 w-3 text-emerald-400" />
                    <span className="hidden sm:inline">Saved</span>
                  </span>
                )}
                {autoSaveStatus === 'error' && (
                  <button
                    type="button"
                    onClick={() => void flushPendingAutoSave()}
                    title={saveError ? `${saveError} Click to retry.` : 'Save failed. Click to retry.'}
                    className="flex items-center gap-1 text-red-400 hover:text-red-300 underline whitespace-nowrap"
                  >
                    <AlertTriangle className="h-3 w-3" />
                    <span>Save Failed · Retry</span>
                  </button>
                )}
              </div>
            </>
          )}
        </div>

        <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
          {storageQuota?.isNearLimit && (
            <button
              type="button"
              onClick={() => setShowProjectsModal(true)}
              title={`Local storage nearly full (${storageQuota.percentUsed.toFixed(0)}% used)`}
              className="hidden lg:flex items-center gap-1 rounded-md border border-amber-500/35 bg-amber-950/35 px-2 py-1 text-[11px] font-medium text-amber-300 hover:bg-amber-950/55 transition-colors min-h-[30px]"
            >
              <AlertTriangle className="h-3 w-3" />
              <span>Storage Low</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => {
              void refreshProjectDirectory();
              setShowProjectsModal(true);
            }}
            title="Saved Projects (IndexedDB)"
            className="flex items-center gap-1.5 rounded-md border border-white/[0.08] bg-zinc-900 px-2.5 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-800 hover:text-white transition-colors min-h-[34px] whitespace-nowrap"
          >
            <FolderKanban className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Projects</span>
            {savedProjects.length > 0 && (
              <span className="text-[11px] text-zinc-400 font-mono-tabular">
                ({savedProjects.length})
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            title="Open photo from device"
            className="flex items-center gap-1.5 rounded-md border border-white/[0.1] bg-zinc-900 px-2.5 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-800 hover:text-white transition-colors min-h-[34px] whitespace-nowrap"
          >
            <FolderOpen className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Open</span>
          </button>

          {sourceImage && (
            <button
              type="button"
              onClick={() => setShowSamplesDrawer((s) => !s)}
              title="Switch sample photo"
              className="hidden xl:flex items-center gap-1.5 rounded-md border border-white/[0.08] bg-transparent px-2.5 py-1.5 text-xs font-medium text-zinc-300 hover:bg-zinc-800 hover:text-white transition-colors min-h-[34px] whitespace-nowrap"
            >
              <Images className="w-3.5 h-3.5" />
              <span>Samples</span>
            </button>
          )}

          {sourceImage && (
            <>
              <div className="h-4 w-[1px] bg-white/[0.1] mx-0.5 hidden sm:block" />

              <button
                type="button"
                onClick={handleUndo}
                disabled={!canUndo}
                title="Undo (Ctrl+Z)"
                aria-label="Undo"
                className="flex items-center justify-center rounded-md p-1.5 text-zinc-300 hover:bg-zinc-800 hover:text-white disabled:opacity-30 disabled:pointer-events-none transition-colors min-h-[34px] min-w-[34px]"
              >
                <Undo2 className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={handleRedo}
                disabled={!canRedo}
                title="Redo (Ctrl+Shift+Z)"
                aria-label="Redo"
                className="flex items-center justify-center rounded-md p-1.5 text-zinc-300 hover:bg-zinc-800 hover:text-white disabled:opacity-30 disabled:pointer-events-none transition-colors min-h-[34px] min-w-[34px]"
              >
                <Redo2 className="w-4 h-4" />
              </button>

              <button
                type="button"
                onClick={() => setCompareMode((m) => (m === 'split' ? 'off' : 'split'))}
                disabled={isCropMode}
                title="Split Before / After Comparison"
                className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors min-h-[34px] whitespace-nowrap disabled:opacity-35 ${
                  compareMode === 'split'
                    ? 'border-white bg-white text-zinc-950'
                    : 'border-white/[0.08] bg-zinc-900 text-zinc-300 hover:text-white hover:bg-zinc-800'
                }`}
              >
                <SplitSquareHorizontal className="w-3.5 h-3.5" />
                <span className="hidden md:inline">Compare</span>
              </button>

              <button
                type="button"
                onClick={handleResetAll}
                disabled={!hasEdits}
                title="Reset all adjustments & retouching"
                className="hidden sm:flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium text-zinc-400 hover:bg-zinc-800 hover:text-white disabled:opacity-30 disabled:pointer-events-none transition-colors min-h-[34px] whitespace-nowrap"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span className="hidden md:inline">Reset</span>
              </button>
            </>
          )}

          <PWAInstallButton />

          {sourceImage && (
            <button
              type="button"
              onClick={() => setShowExportModal(true)}
              className="flex items-center gap-1.5 rounded-md bg-white px-3.5 py-1.5 text-xs font-semibold text-zinc-950 hover:bg-zinc-200 transition-colors min-h-[34px] whitespace-nowrap shadow-sm"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Export</span>
            </button>
          )}
        </div>
      </header>

      {/* Auto-Save Failure Banner */}
      {autoSaveStatus === 'error' && saveError && (
        <div className="bg-red-950/90 border-b border-red-500/40 px-4 py-2 text-xs text-red-200 flex items-center justify-between gap-3">
          <span>Auto-save failed: {saveError}</span>
          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={() => {
                void refreshProjectDirectory();
                setShowProjectsModal(true);
              }}
              className="text-red-200 hover:text-white underline"
            >
              Manage Projects
            </button>
            <button
              type="button"
              onClick={() => void flushPendingAutoSave()}
              className="rounded bg-white/15 px-2.5 py-0.5 text-white hover:bg-white/25"
            >
              Retry Save
            </button>
          </div>
        </div>
      )}

      {/* Error Banner */}
      {loadError && (
        <div className="bg-red-950/90 border-b border-red-500/40 px-4 py-2 text-xs text-red-200 flex items-center justify-between">
          <span>{loadError}</span>
          <button
            type="button"
            onClick={() => setLoadError(null)}
            className="text-red-300 hover:text-white underline ml-4"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* MAIN STUDIO BODY */}
      <div className="flex flex-1 min-h-0 flex-col lg:flex-row overflow-hidden relative">
        {/* CENTER PHOTO WORKSPACE */}
        <main
          ref={workspaceRef}
          onWheel={handleWheelZoom}
          className="relative flex-1 min-h-0 flex items-center justify-center overflow-hidden darkroom-canvas-bg"
        >
          {!sourceImage ? (
            <EmptyWorkspace
              onTriggerUpload={() => fileInputRef.current?.click()}
              onSelectSample={handleSelectSample}
              isDraggingFile={isDraggingFile}
              savedProjects={savedProjects}
              isLoadingProjects={isLoadingProjects}
              openingProjectId={openingProjectId}
              storageQuota={storageQuota}
              storageError={projectsError}
              onOpenProject={(id) => void handleOpenProject(id)}
              onRenameProject={handleRenameProject}
              onDuplicateProject={handleDuplicateProject}
              onDeleteProject={handleDeleteProject}
            />
          ) : (
            <>
              {isDraggingFile && (
                <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center bg-black/70 backdrop-blur-sm border-2 border-dashed border-white m-4 rounded-2xl">
                  <span className="text-sm font-semibold text-white">
                    Drop photo or preset file to open in PhotoMaster Studio
                  </span>
                </div>
              )}

              {showSamplesDrawer && (
                <div className="absolute top-3 left-3 z-40 w-64 rounded-xl border border-zinc-700 bg-[#111114]/95 p-3 shadow-2xl backdrop-blur-md">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-semibold text-white">Sample Studio Photos</span>
                    <button
                      type="button"
                      onClick={() => setShowSamplesDrawer(false)}
                      className="text-[11px] text-zinc-400 hover:text-white"
                    >
                      Close
                    </button>
                  </div>
                  <div className="space-y-1.5">
                    {SAMPLE_PHOTOS.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => handleSelectSample(s)}
                        className="flex w-full items-center gap-2.5 rounded-lg p-1.5 text-left hover:bg-zinc-800 transition-colors"
                      >
                        <img
                          src={s.src}
                          alt={s.title}
                          className="h-10 w-12 rounded object-cover shrink-0 bg-zinc-900"
                        />
                        <div className="min-w-0">
                          <div className="text-xs font-medium text-zinc-100 truncate">{s.title}</div>
                          <div className="text-[11px] text-zinc-500">{s.category}</div>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Canvas Stage */}
              <div
                onPointerDown={handleCanvasPointerDown}
                onPointerMove={handleCanvasPointerMove}
                onPointerUp={handleCanvasPointerUp}
                onPointerCancel={handleCanvasPointerUp}
                onDoubleClick={() => {
                  if (isCropMode || isRetouchMode || isMaskMode || compareMode === 'split') return;
                  if (zoomFactor === 1) {
                    setZoomFactor(2);
                  } else {
                    setZoomFactor(1);
                    setPan({ x: 0, y: 0 });
                  }
                }}
                className={`relative shadow-[0_24px_60px_rgba(0,0,0,0.85)] ring-1 ring-white/[0.08] transition-transform duration-75 ${
                  hasTransparency && bgSettings.mode === 'transparent'
                    ? 'darkroom-alpha-checker'
                    : ''
                } ${
                  (zoomFactor > 1 || effectivePanMode) &&
                  !isCropMode &&
                  ((!isRetouchMode && !isMaskMode) || effectivePanMode)
                    ? 'cursor-grab active:cursor-grabbing'
                    : ''
                }`}
                style={{
                  width: `${displayW}px`,
                  height: `${displayH}px`,
                  transform: `translate3d(${pan.x}px, ${pan.y}px, 0)`,
                }}
              >
                <canvas
  ref={mainCanvasRef}
  className="block max-h-full max-w-full"
/>
                {/* Split Before/After Comparison */}
                {compareMode === 'split' && !isCropMode && (
                  <CompareOverlay
                    originalCanvasRef={originalCanvasRef}
                    splitPosition={splitPosition}
                    onSplitChange={setSplitPosition}
                  />
                )}

                {/* Hold Original indicator */}
                {compareMode === 'hold' && !isCropMode && (
                  <span className="pointer-events-none absolute top-3 left-3 rounded bg-black/80 px-2.5 py-1 text-[11px] font-medium text-white border border-white/15 backdrop-blur-sm">
                    Original (Unedited)
                  </span>
                )}

                {/* Interactive Crop Overlay */}
                {isCropMode && (
                  <CropOverlay
                    crop={draftState.transform.crop}
                    aspectRatio={draftState.transform.aspectRatio}
                    imageWidth={renderSize.width}
                    imageHeight={renderSize.height}
                    onChange={handleCropChange}
                    onCommit={handleCropCommit}
                  />
                )}

                {/* Interactive Mask Overlay & Brushes / Gradients */}
                {isMaskMode &&
                  !isCropMode &&
                  !effectivePanMode &&
                  compareMode === 'off' &&
                  getBaseSourceCanvasForMasks() && (
                    <MaskCanvasOverlay
                      baseSourceCanvas={getBaseSourceCanvasForMasks()!}
                      displayWidth={displayW}
                      displayHeight={displayH}
                      transform={draftState.transform}
                      activeMask={maskLayers.find((m) => m.id === activeMaskId) ?? null}
                      pointerTool={maskPointerTool}
                      brushSettings={maskBrushSettings}
                      forceRedMask={showRedMask}
                      onUpdateMaskLayer={handleUpdateMaskLayer}
                      onFinishObjectBox={handleFinishObjectBox}
                      onCreateGradientComponent={handleCreateGradientComponent}
                      onSwitchBackToHandles={handleSwitchBackToHandles}
                    />
                  )}

                {/* Interactive Retouch Brush & Mask Overlay */}
                {isRetouchMode &&
                  !isCropMode &&
                  !effectivePanMode &&
                  compareMode === 'off' &&
                  retouchBuffersRef.current && (
                    <RetouchCanvasOverlay
                      buffers={retouchBuffersRef.current}
                      transform={draftState.transform}
                      activeTool={retouchTool}
                      brushConfig={brushConfig}
                      cloneSource={cloneSource}
                      isPickingCloneSource={isPickingCloneSource}
                      maskRenderVersion={maskRenderVersion}
                      onSetCloneSource={handleSetCloneSource}
                      onRetouchLiveUpdate={handleRetouchLiveUpdate}
                      onCommitDirtyPatch={handleCommitDirtyPatch}
                      onObjectMaskPainted={handleObjectMaskPainted}
                    />
                  )}
              </div>

              {/* Floating Workspace Bottom HUD (Pan, Zoom, Before/After, Output Dimensions) */}
              <div className="pointer-events-auto absolute bottom-3 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1 rounded-lg border border-white/[0.1] bg-[#111114]/90 px-2 py-1 shadow-xl backdrop-blur-md">
                {(isRetouchMode || isMaskMode) && (
                  <>
                    <button
                      type="button"
                      onClick={() => setIsPanToolActive((p) => !p)}
                      title="Toggle Hand / Pan Mode (or hold Space)"
                      aria-label="Pan Canvas"
                      className={`flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium transition-colors ${
                        effectivePanMode
                          ? 'bg-white text-zinc-950'
                          : 'text-zinc-300 hover:bg-zinc-800 hover:text-white'
                      }`}
                    >
                      <Hand className="w-3.5 h-3.5" />
                      <span className="hidden sm:inline">Pan</span>
                    </button>
                    <div className="h-3.5 w-[1px] bg-white/[0.12] mx-0.5" />
                  </>
                )}

                <button
                  type="button"
                  onClick={() => {
                    setZoomFactor((z) => {
                      const step = z > 2.5 ? 0.5 : 0.25;
                      const next = Math.max(0.5, +(z - step).toFixed(2));
                      if (next <= 1) setPan({ x: 0, y: 0 });
                      return next;
                    });
                  }}
                  title="Zoom Out (-)"
                  aria-label="Zoom Out"
                  className="rounded p-1.5 text-zinc-300 hover:bg-zinc-800 hover:text-white transition-colors"
                >
                  <ZoomOut className="w-3.5 h-3.5" />
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setZoomFactor(1);
                    setPan({ x: 0, y: 0 });
                  }}
                  title="Fit to Screen (0)"
                  className="font-mono-tabular min-w-[46px] rounded px-1.5 py-1 text-[11px] font-medium text-zinc-200 hover:bg-zinc-800 transition-colors"
                >
                  {zoomFactor === 1 ? 'Fit' : `${Math.round(zoomFactor * 100)}%`}
                </button>

                <button
                  type="button"
                  onClick={() =>
                    setZoomFactor((z) => Math.min(8, +(z + (z >= 2 ? 0.5 : 0.25)).toFixed(2)))
                  }
                  title="Zoom In (+)"
                  aria-label="Zoom In"
                  className="rounded p-1.5 text-zinc-300 hover:bg-zinc-800 hover:text-white transition-colors"
                >
                  <ZoomIn className="w-3.5 h-3.5" />
                </button>

                {zoomFactor !== 1 && (
                  <button
                    type="button"
                    onClick={() => {
                      setZoomFactor(1);
                      setPan({ x: 0, y: 0 });
                    }}
                    title="Reset Zoom to Fit"
                    aria-label="Reset Zoom"
                    className="rounded p-1.5 text-zinc-300 hover:bg-zinc-800 hover:text-white transition-colors"
                  >
                    <Maximize2 className="w-3.5 h-3.5" />
                  </button>
                )}

                <div className="h-3.5 w-[1px] bg-white/[0.12] mx-1" />

                <button
                  type="button"
                  onPointerDown={() => {
                    if (!isCropMode) setCompareMode('hold');
                  }}
                  onPointerUp={() => {
                    setCompareMode((m) => (m === 'hold' ? 'off' : m));
                  }}
                  onPointerLeave={() => {
                    setCompareMode((m) => (m === 'hold' ? 'off' : m));
                  }}
                  disabled={isCropMode}
                  title="Hold to view Original (\)"
                  className={`flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium transition-colors whitespace-nowrap disabled:opacity-35 ${
                    compareMode === 'hold'
                      ? 'bg-white text-zinc-950'
                      : 'text-zinc-300 hover:bg-zinc-800 hover:text-white'
                  }`}
                >
                  <Eye className="w-3.5 h-3.5" />
                  <span>Before</span>
                </button>

                {outputDims && (
                  <span className="hidden sm:inline-block font-mono-tabular text-[11px] text-zinc-500 pl-1.5 pr-1 border-l border-white/[0.1] ml-1 whitespace-nowrap">
                    {outputDims.width} × {outputDims.height}
                  </span>
                )}
              </div>
            </>
          )}
        </main>

        {/* DESKTOP RIGHT INSPECTOR PANEL (lg+) */}
        {sourceImage && isDesktop && (
          <aside className="w-[356px] shrink-0 border-l border-white/[0.08] bg-[#111114] flex flex-col min-h-0">
            {/* Live Histogram */}
            <div className="p-3 pb-2 border-b border-white/[0.07]">
              <Histogram data={histogram} />
            </div>

            {/* Module Tabs: Adjust | Mask | Retouch | Presets | Crop */}
            <div className="grid grid-cols-5 gap-1 p-1.5 border-b border-white/[0.07] bg-[#0d0d10]">
              <button
                type="button"
                onClick={() => setDesktopTab('edit')}
                className={`flex flex-col items-center justify-center gap-0.5 rounded-md py-1.5 text-[10px] font-medium transition-colors whitespace-nowrap ${
                  desktopTab === 'edit'
                    ? 'bg-zinc-800 text-white shadow-sm'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <SlidersHorizontal className="w-3.5 h-3.5" />
                <span>Adjust</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setDesktopTab('masking');
                  setIsPanToolActive(false);
                }}
                className={`flex flex-col items-center justify-center gap-0.5 rounded-md py-1.5 text-[10px] font-medium transition-colors whitespace-nowrap relative ${
                  desktopTab === 'masking'
                    ? 'bg-zinc-800 text-white shadow-sm'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <Sparkles className="w-3.5 h-3.5" />
                <span>Mask</span>
                {maskLayers.length > 0 && (
                  <span className="absolute top-1 right-1.5 h-1.5 w-1.5 rounded-full bg-white" />
                )}
              </button>
              <button
                type="button"
                onClick={() => {
                  setDesktopTab('retouch');
                  setIsPanToolActive(false);
                }}
                className={`flex flex-col items-center justify-center gap-0.5 rounded-md py-1.5 text-[10px] font-medium transition-colors whitespace-nowrap ${
                  desktopTab === 'retouch'
                    ? 'bg-zinc-800 text-white shadow-sm'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <Bandage className="w-3.5 h-3.5" />
                <span>Retouch</span>
              </button>
              <button
                type="button"
                onClick={() => setDesktopTab('presets')}
                className={`flex flex-col items-center justify-center gap-0.5 rounded-md py-1.5 text-[10px] font-medium transition-colors whitespace-nowrap ${
                  desktopTab === 'presets'
                    ? 'bg-zinc-800 text-white shadow-sm'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <Layers className="w-3.5 h-3.5" />
                <span>Presets</span>
              </button>
              <button
                type="button"
                onClick={() => setDesktopTab('crop')}
                className={`flex flex-col items-center justify-center gap-0.5 rounded-md py-1.5 text-[10px] font-medium transition-colors whitespace-nowrap ${
                  desktopTab === 'crop'
                    ? 'bg-zinc-800 text-white shadow-sm'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <Crop className="w-3.5 h-3.5" />
                <span>Crop</span>
              </button>
            </div>

            {/* Scrollable Tool Body */}
            <div className="flex-1 overflow-y-auto px-4 py-3 studio-scroll">
              {desktopTab === 'edit' && (
                <AdjustmentControls
                  adjustments={draftState.adjustments}
                  transform={draftState.transform}
                  onChange={handleAdjustmentChange}
                  onChangeAdjustmentsPatch={handleChangeAdjustmentsPatch}
                  onChangeTransformOptics={handleChangeTransformOptics}
                  onCommit={handleAdjustmentCommit}
                  onResetKeys={handleResetAdjustmentKeys}
                  section="all"
                />
              )}

              {desktopTab === 'masking' && (
                <MaskingPanel
                  masks={maskLayers}
                  activeMaskId={activeMaskId}
                  onSelectMask={handleSelectMask}
                  pointerTool={maskPointerTool}
                  brushSettings={maskBrushSettings}
                  isSegmenting={isSegmentingMask}
                  showRedMask={showRedMask}
                  onToggleShowRedMask={handleToggleShowRedMask}
                  onUpdateBrushSettings={handleUpdateMaskBrushSettings}
                  onCreateMaskWithTool={handleCreateMaskWithTool}
                  onEditWithBrush={handleEditWithBrush}
                  onIntersectWithMask={handleIntersectWithMask}
                  onUpdateMaskLayer={handleUpdateMaskLayer}
                  onInvertMask={handleInvertMask}
                  onDuplicateMask={handleDuplicateMask}
                  onDeleteMask={handleDeleteMask}
                  onRemoveComponent={handleRemoveMaskComponent}
                  onSetPointerTool={handleSetMaskPointerTool}
                  onStartPhotoEditing={handleStartMaskPhotoEditing}
                />
              )}

              {desktopTab === 'retouch' && (
                <RetouchPanel
                  activeTool={retouchTool}
                  onSelectTool={handleSelectRetouchTool}
                  brushConfig={brushConfig}
                  onUpdateBrushConfig={handleUpdateRetouchBrushConfig}
                  hasObjectSelection={hasObjectSelection}
                  isProcessingInpaint={isProcessingInpaint}
                  onRunObjectRemoval={handleRunObjectRemoval}
                  onClearObjectSelection={handleClearObjectSelection}
                  cloneSource={cloneSource}
                  isPickingCloneSource={isPickingCloneSource}
                  onTogglePickCloneSource={handleTogglePickCloneSource}
                  isProcessingBg={isProcessingBg}
                  bgProgress={bgProgress}
                  bgLastModelLabel={bgLastModelLabel}
                  hasTransparency={hasTransparency}
                  bgSettings={bgSettings}
                  bgRefinement={bgRefinement}
                  onChangeBgRefinement={handleChangeBgRefinement}
                  onAutoRemoveBackground={handleAutoRemoveBackground}
                  onSnapManualSelection={handleSnapManualSelection}
                  onClearAlphaToEmpty={handleClearAlphaToEmpty}
                  onResetAlphaMask={handleResetAlphaMask}
                  onChangeBgSettings={handleChangeBgSettings}
                  onUploadBgImage={handleUploadBgImage}
                />
              )}

              {desktopTab === 'presets' && (
                <PresetStrip
                  sourceImage={sourceImage}
                  transform={draftState.transform}
                  currentAdjustments={draftState.adjustments}
                  activePresetId={draftState.activePresetId}
                  customPresets={customPresets}
                  onApplyPreset={handleApplyPreset}
                  onSaveCustomPreset={handleSaveCustomPreset}
                  onImportPreset={handleImportPreset}
                  onRenameCustomPreset={handleRenameCustomPreset}
                  onDeleteCustomPreset={handleDeleteCustomPreset}
                  onLutIntensityChange={handleLutIntensityChange}
                  onLutIntensityCommit={handleAdjustmentCommit}
                  onClearLut={handleClearLut}
                />
              )}

              {desktopTab === 'crop' && (
                <CropPanel
                  transform={draftState.transform}
                  onAspectChange={handleAspectChange}
                  onRotate90={handleRotate90}
                  onFlip={handleFlip}
                  onStraightenChange={handleStraightenChange}
                  onStraightenCommit={handleCropCommit}
                  onOpticsChange={handleChangeTransformOptics}
                  onResetCrop={handleResetCrop}
                  onDoneCrop={handleDoneDesktopCrop}
                />
              )}
            </div>

            {/* Footer Metadata */}
            {imageMeta && (
              <div className="border-t border-white/[0.07] px-4 py-2.5 flex items-center justify-between text-[11px] text-zinc-500">
                <span className="truncate max-w-[175px]" title={imageMeta.name}>
                  {imageMeta.name}
                </span>
                <span className="font-mono-tabular shrink-0">
                  {imageMeta.width} × {imageMeta.height}
                </span>
              </div>
            )}
          </aside>
        )}

        {/* MOBILE / ANDROID BOTTOM THUMB DOCK (< 1024px) */}
        {sourceImage && !isDesktop && (
          <section className="shrink-0 border-t border-white/[0.08] bg-[#111114] z-30">
            {/* Active Tool Controls Drawer */}
            <div className="max-h-[38vh] overflow-y-auto px-4 py-2.5 studio-scroll">
              {mobileSubTab === 'adjust' && (
                <div className="space-y-2">
                  <div className="grid grid-cols-4 gap-1 p-1 rounded-lg bg-zinc-950 border border-white/[0.06]">
                    {(
                      [
                        { id: 'light', label: 'Light' },
                        { id: 'color', label: 'Color' },
                        { id: 'detail', label: 'Detail' },
                        { id: 'optics', label: 'Optics' },
                      ] as const
                    ).map((sec) => (
                      <button
                        key={sec.id}
                        type="button"
                        onClick={() => setMobileAdjustSection(sec.id)}
                        className={`rounded-md py-1.5 text-xs font-medium transition-colors min-h-[34px] ${
                          mobileAdjustSection === sec.id
                            ? 'bg-white text-zinc-950 font-semibold'
                            : 'text-zinc-400 hover:text-white'
                        }`}
                      >
                        {sec.label}
                      </button>
                    ))}
                  </div>
                  <AdjustmentControls
                    adjustments={draftState.adjustments}
                    transform={draftState.transform}
                    onChange={handleAdjustmentChange}
                    onChangeAdjustmentsPatch={handleChangeAdjustmentsPatch}
                    onChangeTransformOptics={handleChangeTransformOptics}
                    onCommit={handleAdjustmentCommit}
                    onResetKeys={handleResetAdjustmentKeys}
                    section={mobileAdjustSection}
                  />
                </div>
              )}

              {mobileSubTab === 'masking' && (
                <MaskingPanel
                  masks={maskLayers}
                  activeMaskId={activeMaskId}
                  onSelectMask={handleSelectMask}
                  pointerTool={maskPointerTool}
                  brushSettings={maskBrushSettings}
                  isSegmenting={isSegmentingMask}
                  showRedMask={showRedMask}
                  onToggleShowRedMask={handleToggleShowRedMask}
                  onUpdateBrushSettings={handleUpdateMaskBrushSettings}
                  onCreateMaskWithTool={handleCreateMaskWithTool}
                  onEditWithBrush={handleEditWithBrush}
                  onIntersectWithMask={handleIntersectWithMask}
                  onUpdateMaskLayer={handleUpdateMaskLayer}
                  onInvertMask={handleInvertMask}
                  onDuplicateMask={handleDuplicateMask}
                  onDeleteMask={handleDeleteMask}
                  onRemoveComponent={handleRemoveMaskComponent}
                  onSetPointerTool={handleSetMaskPointerTool}
                  onStartPhotoEditing={handleStartMaskPhotoEditing}
                />
              )}

              {mobileSubTab === 'retouch' && (
                <RetouchPanel
                  activeTool={retouchTool}
                  onSelectTool={handleSelectRetouchTool}
                  brushConfig={brushConfig}
                  onUpdateBrushConfig={handleUpdateRetouchBrushConfig}
                  hasObjectSelection={hasObjectSelection}
                  isProcessingInpaint={isProcessingInpaint}
                  onRunObjectRemoval={handleRunObjectRemoval}
                  onClearObjectSelection={handleClearObjectSelection}
                  cloneSource={cloneSource}
                  isPickingCloneSource={isPickingCloneSource}
                  onTogglePickCloneSource={handleTogglePickCloneSource}
                  isProcessingBg={isProcessingBg}
                  bgProgress={bgProgress}
                  bgLastModelLabel={bgLastModelLabel}
                  hasTransparency={hasTransparency}
                  bgSettings={bgSettings}
                  bgRefinement={bgRefinement}
                  onChangeBgRefinement={handleChangeBgRefinement}
                  onAutoRemoveBackground={handleAutoRemoveBackground}
                  onSnapManualSelection={handleSnapManualSelection}
                  onClearAlphaToEmpty={handleClearAlphaToEmpty}
                  onResetAlphaMask={handleResetAlphaMask}
                  onChangeBgSettings={handleChangeBgSettings}
                  onUploadBgImage={handleUploadBgImage}
                />
              )}

              {mobileSubTab === 'presets' && (
                <PresetStrip
                  sourceImage={sourceImage}
                  transform={draftState.transform}
                  currentAdjustments={draftState.adjustments}
                  activePresetId={draftState.activePresetId}
                  customPresets={customPresets}
                  onApplyPreset={handleApplyPreset}
                  onSaveCustomPreset={handleSaveCustomPreset}
                  onImportPreset={handleImportPreset}
                  onRenameCustomPreset={handleRenameCustomPreset}
                  onDeleteCustomPreset={handleDeleteCustomPreset}
                  onLutIntensityChange={handleLutIntensityChange}
                  onLutIntensityCommit={handleAdjustmentCommit}
                  onClearLut={handleClearLut}
                  compactHorizontal
                />
              )}

              {mobileSubTab === 'crop' && (
                <CropPanel
                  transform={draftState.transform}
                  onAspectChange={handleAspectChange}
                  onRotate90={handleRotate90}
                  onFlip={handleFlip}
                  onStraightenChange={handleStraightenChange}
                  onStraightenCommit={handleCropCommit}
                  onOpticsChange={handleChangeTransformOptics}
                  onResetCrop={handleResetCrop}
                  onDoneCrop={handleDoneMobileCrop}
                />
              )}
            </div>

            {/* Mobile 5-Tab Bottom Bar */}
            <nav
              aria-label="Photo editing modules"
              className="grid grid-cols-5 border-t border-white/[0.08] bg-[#09090b] pb-[env(safe-area-inset-bottom)]"
            >
              {(
                [
                  { id: 'adjust', label: 'Adjust', icon: SlidersHorizontal },
                  { id: 'masking', label: 'Mask', icon: Sparkles },
                  { id: 'retouch', label: 'Retouch', icon: Bandage },
                  { id: 'presets', label: 'Presets', icon: Layers },
                  { id: 'crop', label: 'Crop', icon: Crop },
                ] as const
              ).map((tab) => {
                const Icon = tab.icon;
                const active = mobileSubTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => {
                      setMobileSubTab(tab.id);
                      if (tab.id === 'retouch' || tab.id === 'masking') setIsPanToolActive(false);
                    }}
                    className={`relative flex flex-col items-center justify-center gap-0.5 py-2 min-h-[52px] transition-colors ${
                      active ? 'text-white' : 'text-zinc-500 hover:text-zinc-300'
                    }`}
                  >
                    <Icon className="w-4 h-4" />
                    <span className="text-[10px] font-medium">{tab.label}</span>
                    {tab.id === 'masking' && maskLayers.length > 0 && (
                      <span className="absolute top-1.5 right-4 h-1.5 w-1.5 rounded-full bg-white" />
                    )}
                  </button>
                );
              })}
            </nav>
          </section>
        )}
      </div>

      {/* Saved Projects Manager Modal */}
      {showProjectsModal && (
        <ProjectsModal
          projects={savedProjects}
          activeProjectId={activeProjectId}
          storageQuota={storageQuota}
          isLoadingProjects={isLoadingProjects}
          openingProjectId={openingProjectId}
          errorMessage={projectsError}
          onOpenProject={(id) => void handleOpenProject(id)}
          onRenameProject={handleRenameProject}
          onDuplicateProject={handleDuplicateProject}
          onDeleteProject={handleDeleteProject}
          onNewPhoto={() => {
            setShowProjectsModal(false);
            fileInputRef.current?.click();
          }}
          onClose={() => setShowProjectsModal(false)}
        />
      )}

      {/* Export Dialog */}
      {showExportModal && sourceImage && imageMeta && (
        <ExportModal
          sourceImage={sourceImage}
          imageMeta={imageMeta}
          editState={draftState}
          hasTransparency={hasTransparency}
          retouchCanvas={retouchBuffersRef.current?.retouchCanvas ?? null}
          alphaCanvas={retouchBuffersRef.current?.alphaCanvas ?? null}
          bgSettings={bgSettings}
          bgImage={bgImageElement}
          bgRefinement={bgRefinement}
          hasRetouchEdits={hasRetouchEdits}
          retouchOps={activeRetouchOps}
          maskLayers={maskLayers}
          onClose={() => setShowExportModal(false)}
        />
      )}

      {/* Offline PWA Indicator */}
      <OfflineIndicator />
    </div>
  );
}
