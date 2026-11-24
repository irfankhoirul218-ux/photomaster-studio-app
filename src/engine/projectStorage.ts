import {
  DEFAULT_ADJUSTMENTS,
  DEFAULT_BACKGROUND_SETTINGS,
  DEFAULT_BG_REFINEMENT_SETTINGS,
  DEFAULT_COLOR_GRADING,
  DEFAULT_HSL_MIXER,
  DEFAULT_LOCAL_ADJUSTMENTS,
  DEFAULT_TONE_CURVE,
  DEFAULT_TRANSFORM,
  EditState,
  Lut3DData,
  MaskComponent,
  MaskLayer,
  RetouchOperation,
  SavedProjectAssetsPayload,
  SavedProjectStatePayload,
  SavedProjectSummary,
  StorageQuotaStatus,
} from '../types/editor';
import { cloneToneCurves } from './toneCurve';

const DB_NAME = 'photomaster_studio_projects_v1';
const DB_VERSION = 1;
const STORE_PROJECTS = 'projects';
const STORE_STATES = 'projectStates';
const STORE_ASSETS = 'projectAssets';
const LAST_ACTIVE_PROJECT_KEY = 'photomaster_last_active_project_v1';

const NEAR_LIMIT_PERCENT = 80;
const NEAR_LIMIT_REMAINING_BYTES = 50 * 1024 * 1024; // 50 MB

let dbPromise: Promise<IDBDatabase> | null = null;

export function getLastActiveProjectId(): string | null {
  try {
    return localStorage.getItem(LAST_ACTIVE_PROJECT_KEY);
  } catch {
    return null;
  }
}

export function setLastActiveProjectId(projectId: string | null): void {
  try {
    if (projectId) {
      localStorage.setItem(LAST_ACTIVE_PROJECT_KEY, projectId);
    } else {
      localStorage.removeItem(LAST_ACTIVE_PROJECT_KEY);
    }
  } catch {
    // Ignore localStorage failures in restricted environments
  }
}

export function formatStorageBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb >= 100 ? 0 : 1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(2)} GB`;
}

export function formatIndexedDbError(err: unknown): string {
  if (err && typeof err === 'object') {
    const domErr = err as { name?: string; message?: string };
    const name = domErr.name ?? '';
    const msg = domErr.message ?? '';

    if (
      name === 'QuotaExceededError' ||
      name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
      /quota/i.test(msg)
    ) {
      return 'Local browser storage is full (QuotaExceeded). Delete unused projects or export your work to free up space.';
    }
    if (name === 'SecurityError' || /indexeddb/i.test(msg)) {
      return 'Local IndexedDB storage is blocked or unavailable in this browser session (e.g., private browsing mode).';
    }
    if (name === 'DataCloneError') {
      return 'Could not serialize project data for local storage.';
    }
    if (name === 'AbortError') {
      return 'Local storage write was interrupted. Please click Retry Save.';
    }
    if (msg) return msg;
  }
  return 'Failed to access local IndexedDB project storage.';
}

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(
      new Error('IndexedDB is not supported or unavailable in this browser.')
    );
  }
  if (dbPromise) return dbPromise;

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      dbPromise = null;
      reject(new Error(formatIndexedDbError(err)));
      return;
    }

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_PROJECTS)) {
        const store = db.createObjectStore(STORE_PROJECTS, { keyPath: 'id' });
        store.createIndex('updatedAt', 'updatedAt', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_STATES)) {
        db.createObjectStore(STORE_STATES, { keyPath: 'projectId' });
      }
      if (!db.objectStoreNames.contains(STORE_ASSETS)) {
        db.createObjectStore(STORE_ASSETS, { keyPath: 'projectId' });
      }
    };

    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      db.onclose = () => {
        dbPromise = null;
      };
      resolve(db);
    };

    req.onerror = () => {
      dbPromise = null;
      reject(new Error(formatIndexedDbError(req.error)));
    };

    req.onblocked = () => {
      dbPromise = null;
      reject(
        new Error('Local project database upgrade is blocked by another open tab.')
      );
    };
  });

  return dbPromise;
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(new Error(formatIndexedDbError(tx.error)));
    tx.onabort = () =>
      reject(new Error(formatIndexedDbError(tx.error ?? new DOMException('Aborted', 'AbortError'))));
  });
}

function reqPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new Error(formatIndexedDbError(req.error)));
  });
}

export async function checkStorageQuota(): Promise<StorageQuotaStatus> {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) {
    return {
      supported: false,
      usageBytes: 0,
      quotaBytes: 0,
      percentUsed: 0,
      remainingBytes: Number.MAX_SAFE_INTEGER,
      isNearLimit: false,
    };
  }

  try {
    const est = await navigator.storage.estimate();
    const usage = Math.max(0, est.usage ?? 0);
    const quota = Math.max(0, est.quota ?? 0);
    if (quota <= 0) {
      return {
        supported: false,
        usageBytes: usage,
        quotaBytes: 0,
        percentUsed: 0,
        remainingBytes: Number.MAX_SAFE_INTEGER,
        isNearLimit: false,
      };
    }
    const percentUsed = Math.min(100, (usage / quota) * 100);
    const remainingBytes = Math.max(0, quota - usage);
    const isNearLimit =
      percentUsed >= NEAR_LIMIT_PERCENT || remainingBytes < NEAR_LIMIT_REMAINING_BYTES;

    return {
      supported: true,
      usageBytes: usage,
      quotaBytes: quota,
      percentUsed,
      remainingBytes,
      isNearLimit,
    };
  } catch {
    return {
      supported: false,
      usageBytes: 0,
      quotaBytes: 0,
      percentUsed: 0,
      remainingBytes: Number.MAX_SAFE_INTEGER,
      isNearLimit: false,
    };
  }
}

// ---------- Serialization / Deserialization Helpers ----------

function cloneLutForStorage(lut: Lut3DData | null): Lut3DData | null {
  if (!lut) return null;
  const rawTable = lut.table instanceof Float32Array ? lut.table : new Float32Array(lut.table);
  return {
    size: lut.size,
    domainMin: [...lut.domainMin] as [number, number, number],
    domainMax: [...lut.domainMax] as [number, number, number],
    table: new Float32Array(rawTable),
    title: lut.title,
  };
}

export function serializeEditStateForStorage(state: EditState): EditState {
  const adj = state.adjustments;
  return {
    activePresetId: state.activePresetId,
    transform: {
      ...DEFAULT_TRANSFORM,
      ...state.transform,
      crop: {
        ...DEFAULT_TRANSFORM.crop,
        ...state.transform.crop,
      },
    },
    adjustments: {
      ...DEFAULT_ADJUSTMENTS,
      ...adj,
      toneCurve: cloneToneCurves(adj.toneCurve ?? DEFAULT_TONE_CURVE),
      hsl: {
        red: { ...DEFAULT_HSL_MIXER.red, ...adj.hsl?.red },
        orange: { ...DEFAULT_HSL_MIXER.orange, ...adj.hsl?.orange },
        yellow: { ...DEFAULT_HSL_MIXER.yellow, ...adj.hsl?.yellow },
        green: { ...DEFAULT_HSL_MIXER.green, ...adj.hsl?.green },
        aqua: { ...DEFAULT_HSL_MIXER.aqua, ...adj.hsl?.aqua },
        blue: { ...DEFAULT_HSL_MIXER.blue, ...adj.hsl?.blue },
        purple: { ...DEFAULT_HSL_MIXER.purple, ...adj.hsl?.purple },
        magenta: { ...DEFAULT_HSL_MIXER.magenta, ...adj.hsl?.magenta },
      },
      colorGrading: {
        shadows: { ...DEFAULT_COLOR_GRADING.shadows, ...adj.colorGrading?.shadows },
        midtones: { ...DEFAULT_COLOR_GRADING.midtones, ...adj.colorGrading?.midtones },
        highlights: { ...DEFAULT_COLOR_GRADING.highlights, ...adj.colorGrading?.highlights },
        blending: adj.colorGrading?.blending ?? DEFAULT_COLOR_GRADING.blending,
        balance: adj.colorGrading?.balance ?? DEFAULT_COLOR_GRADING.balance,
      },
      lut: cloneLutForStorage(adj.lut ?? null),
    },
  };
}

export function deserializeEditStateFromStorage(raw: EditState): EditState {
  return serializeEditStateForStorage(raw);
}

function toUint8Array(raw: Uint8Array | ArrayLike<number>): Uint8Array {
  if (raw instanceof Uint8Array) return new Uint8Array(raw);
  return Uint8Array.from(raw);
}

function serializeMaskComponent(c: MaskComponent): MaskComponent {
  if (
    c.kind === 'subject' ||
    c.kind === 'sky' ||
    c.kind === 'background' ||
    c.kind === 'object' ||
    c.kind === 'brush'
  ) {
    return {
      ...c,
      raster: {
        width: c.raster.width,
        height: c.raster.height,
        data: toUint8Array(c.raster.data),
      },
    };
  }
  if (c.kind === 'mask-ref') {
    return {
      ...c,
      sourceRaster: {
        width: c.sourceRaster.width,
        height: c.sourceRaster.height,
        data: toUint8Array(c.sourceRaster.data),
      },
    };
  }
  if (c.kind === 'color-range') {
    return {
      ...c,
      targetRgb: [...c.targetRgb] as [number, number, number],
    };
  }
  return { ...c };
}

export function serializeMaskLayersForStorage(layers: MaskLayer[]): MaskLayer[] {
  return (layers ?? []).map((layer) => ({
    ...layer,
    showOverlay: false,
    adjustments: {
      ...DEFAULT_LOCAL_ADJUSTMENTS,
      ...layer.adjustments,
    },
    components: (layer.components ?? []).map(serializeMaskComponent),
  }));
}

export function serializeRetouchOpsForStorage(ops: RetouchOperation[]): RetouchOperation[] {
  return (ops ?? []).map((op) => {
    if (op.kind === 'object-removal') {
      return {
        ...op,
        normRect: { ...op.normRect },
        maskBytes: toUint8Array(op.maskBytes),
      };
    }
    return {
      ...op,
      points: op.points.map((p) => ({ nx: p.nx, ny: p.ny })),
    };
  });
}

// ---------- Canvas & Blob Compression Utilities ----------

export async function resolveSourceImageBlob(
  sourceImage: HTMLImageElement,
  preferredBlob?: Blob | null
): Promise<Blob> {
  if (preferredBlob && preferredBlob.size > 0) {
    return preferredBlob;
  }

  const src = sourceImage.currentSrc || sourceImage.src;
  if (src && (src.startsWith('blob:') || src.startsWith('data:') || src.startsWith('/') || src.startsWith('http'))) {
    try {
      const resp = await fetch(src);
      if (resp.ok) {
        const fetched = await resp.blob();
        if (fetched.size > 0) return fetched;
      }
    } catch {
      // Fall back to encoding from native HTMLImageElement canvas below
    }
  }

  const c = document.createElement('canvas');
  c.width = sourceImage.naturalWidth;
  c.height = sourceImage.naturalHeight;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('Could not initialize canvas to save original image.');
  ctx.drawImage(sourceImage, 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => c.toBlob(resolve, 'image/png'));
  c.width = 0;
  c.height = 0;
  if (!blob) throw new Error('Failed to encode original image for local storage.');
  return blob;
}

export async function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'));
}

export async function uint8ToGrayscalePngBlob(
  bytes: Uint8ClampedArray,
  width: number,
  height: number
): Promise<Blob | null> {
  if (bytes.length < width * height) return null;
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  const imgData = ctx.createImageData(width, height);
  const d = imgData.data;
  const len = width * height;
  for (let i = 0; i < len; i++) {
    const v = bytes[i];
    const i4 = i * 4;
    d[i4] = v;
    d[i4 + 1] = v;
    d[i4 + 2] = v;
    d[i4 + 3] = 255;
  }
  ctx.putImageData(imgData, 0, 0);
  const blob = await canvasToPngBlob(c);
  c.width = 0;
  c.height = 0;
  return blob;
}

export async function pngBlobToGrayscaleBytes(
  blob: Blob,
  expectedW: number,
  expectedH: number
): Promise<Uint8ClampedArray | null> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Failed to decode alpha mask blob.'));
      img.src = url;
    });
    const c = document.createElement('canvas');
    c.width = expectedW;
    c.height = expectedH;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, expectedW, expectedH);
    const data = ctx.getImageData(0, 0, expectedW, expectedH).data;
    const out = new Uint8ClampedArray(expectedW * expectedH);
    for (let i = 0; i < out.length; i++) {
      out[i] = data[i * 4];
    }
    c.width = 0;
    c.height = 0;
    return out;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function drawBlobOntoCanvas(
  blob: Blob,
  targetCanvas: HTMLCanvasElement
): Promise<boolean> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Failed to decode stored image mask.'));
      img.src = url;
    });
    const ctx = targetCanvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return false;
    ctx.clearRect(0, 0, targetCanvas.width, targetCanvas.height);
    ctx.drawImage(img, 0, 0, targetCanvas.width, targetCanvas.height);
    return true;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function createProjectThumbnailDataUrl(
  source: HTMLCanvasElement | HTMLImageElement | null
): string {
  if (!source) return '';
  const srcW = source instanceof HTMLImageElement ? source.naturalWidth : source.width;
  const srcH = source instanceof HTMLImageElement ? source.naturalHeight : source.height;
  if (srcW <= 0 || srcH <= 0) return '';

  const maxDim = 280;
  const scale = Math.min(1, maxDim / Math.max(srcW, srcH));
  const w = Math.max(1, Math.round(srcW * scale));
  const h = Math.max(1, Math.round(srcH * scale));

  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) return '';
  ctx.fillStyle = '#09090b';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(source, 0, 0, w, h);
  const url = c.toDataURL('image/jpeg', 0.78);
  c.width = 0;
  c.height = 0;
  return url;
}

// ---------- IndexedDB CRUD Operations ----------

export async function listSavedProjects(): Promise<SavedProjectSummary[]> {
  const db = await openDatabase();
  const tx = db.transaction([STORE_PROJECTS], 'readonly');
  const store = tx.objectStore(STORE_PROJECTS);
  const items = await reqPromise<SavedProjectSummary[]>(store.getAll());
  await txDone(tx);
  return items.sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
}

export async function saveProjectToIdb(
  summary: SavedProjectSummary,
  state: SavedProjectStatePayload,
  assets: SavedProjectAssetsPayload | null
): Promise<void> {
  const db = await openDatabase();
  const stores = assets
    ? [STORE_PROJECTS, STORE_STATES, STORE_ASSETS]
    : [STORE_PROJECTS, STORE_STATES];

  const tx = db.transaction(stores, 'readwrite');
  tx.objectStore(STORE_PROJECTS).put(summary);
  tx.objectStore(STORE_STATES).put(state);
  if (assets) {
    tx.objectStore(STORE_ASSETS).put(assets);
  }
  await txDone(tx);
}

export async function hasStoredProjectAssets(projectId: string): Promise<boolean> {
  const db = await openDatabase();
  const tx = db.transaction([STORE_ASSETS], 'readonly');
  const asset = await reqPromise<SavedProjectAssetsPayload | undefined>(
    tx.objectStore(STORE_ASSETS).get(projectId)
  );
  await txDone(tx);
  return Boolean(asset && asset.sourceBlob && asset.sourceBlob.size > 0);
}

export async function loadProjectFromIdb(projectId: string): Promise<{
  summary: SavedProjectSummary;
  state: SavedProjectStatePayload;
  assets: SavedProjectAssetsPayload;
}> {
  const db = await openDatabase();
  const tx = db.transaction([STORE_PROJECTS, STORE_STATES, STORE_ASSETS], 'readonly');
  const [summary, rawState, assets] = await Promise.all([
    reqPromise<SavedProjectSummary | undefined>(tx.objectStore(STORE_PROJECTS).get(projectId)),
    reqPromise<SavedProjectStatePayload | undefined>(tx.objectStore(STORE_STATES).get(projectId)),
    reqPromise<SavedProjectAssetsPayload | undefined>(tx.objectStore(STORE_ASSETS).get(projectId)),
  ]);
  await txDone(tx);

  if (!summary || !rawState || !assets || !assets.sourceBlob) {
    throw new Error('Project data or original photo is missing or corrupted in IndexedDB.');
  }

  const state: SavedProjectStatePayload = {
    ...rawState,
    editState: deserializeEditStateFromStorage(rawState.editState),
    maskLayers: serializeMaskLayersForStorage(rawState.maskLayers ?? []),
    activeRetouchOps: serializeRetouchOpsForStorage(rawState.activeRetouchOps ?? []),
    archivedRetouchOps: serializeRetouchOpsForStorage(rawState.archivedRetouchOps ?? []),
    bgSettings: {
      ...DEFAULT_BACKGROUND_SETTINGS,
      ...rawState.bgSettings,
    },
    bgRefinement: {
      ...DEFAULT_BG_REFINEMENT_SETTINGS,
      ...rawState.bgRefinement,
    },
    historyEntries: (rawState.historyEntries ?? []).map((entry) => {
      if (entry.kind === 'state') {
        return {
          kind: 'state',
          prev: deserializeEditStateFromStorage(entry.prev),
          next: deserializeEditStateFromStorage(entry.next),
        };
      }
      if (entry.kind === 'masks') {
        return {
          ...entry,
          prev: serializeMaskLayersForStorage(entry.prev),
          next: serializeMaskLayersForStorage(entry.next),
        };
      }
      if (entry.kind === 'retouch-rgb') {
        return {
          ...entry,
          retouchOp: entry.retouchOp
            ? serializeRetouchOpsForStorage([entry.retouchOp])[0]
            : undefined,
        };
      }
      return entry;
    }),
  };

  return { summary, state, assets };
}

export async function renameProjectInIdb(
  projectId: string,
  newName: string
): Promise<SavedProjectSummary> {
  const cleanName = newName.trim();
  if (!cleanName) {
    throw new Error('Project name cannot be empty.');
  }
  const db = await openDatabase();
  const tx = db.transaction([STORE_PROJECTS], 'readwrite');
  const store = tx.objectStore(STORE_PROJECTS);
  const existing = await reqPromise<SavedProjectSummary | undefined>(store.get(projectId));
  if (!existing) {
    throw new Error('Project no longer exists in local storage.');
  }
  const updated: SavedProjectSummary = {
    ...existing,
    name: cleanName,
    updatedAt: new Date().toISOString(),
  };
  store.put(updated);
  await txDone(tx);
  return updated;
}

export async function duplicateProjectInIdb(
  projectId: string
): Promise<SavedProjectSummary> {
  const { summary, state, assets } = await loadProjectFromIdb(projectId);
  const now = new Date().toISOString();
  const newId = `proj-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  const newSummary: SavedProjectSummary = {
    ...summary,
    id: newId,
    name: `${summary.name} (Copy)`,
    createdAt: now,
    updatedAt: now,
  };

  const newState: SavedProjectStatePayload = {
    ...state,
    projectId: newId,
    updatedAt: now,
  };

  const newAssets: SavedProjectAssetsPayload = {
    ...assets,
    projectId: newId,
    manualAlphaDelta: assets.manualAlphaDelta
      ? new Int16Array(assets.manualAlphaDelta)
      : null,
  };

  await saveProjectToIdb(newSummary, newState, newAssets);
  return newSummary;
}

export async function deleteProjectFromIdb(projectId: string): Promise<void> {
  const db = await openDatabase();
  const tx = db.transaction([STORE_PROJECTS, STORE_STATES, STORE_ASSETS], 'readwrite');
  tx.objectStore(STORE_PROJECTS).delete(projectId);
  tx.objectStore(STORE_STATES).delete(projectId);
  tx.objectStore(STORE_ASSETS).delete(projectId);
  await txDone(tx);

  if (getLastActiveProjectId() === projectId) {
    setLastActiveProjectId(null);
  }
}
