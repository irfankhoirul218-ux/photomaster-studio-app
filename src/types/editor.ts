export type AspectRatioOption =
  | 'free'
  | 'original'
  | '1:1'
  | '4:3'
  | '3:2'
  | '16:9'
  | '4:5'
  | '9:16';

export type SplitToneMode = 'none' | 'cinematic' | 'moody' | 'vintage' | 'golden';

export type PresetSourceFormat = 'custom' | 'xmp' | 'cube' | 'json' | 'lrtemplate';

export type PresetCategory =
  | 'All'
  | 'My Presets'
  | 'Landscape'
  | 'Portrait'
  | 'Cinematic'
  | 'Monochrome'
  | 'Vintage';

export type WhiteBalanceMode =
  | 'as-shot'
  | 'daylight'
  | 'cloudy'
  | 'shade'
  | 'tungsten'
  | 'fluorescent'
  | 'custom';

export interface Lut3DData {
  size: number;
  domainMin: [number, number, number];
  domainMax: [number, number, number];
  table: Float32Array;
  title?: string;
}

export interface CurvePoint {
  x: number; // 0..255
  y: number; // 0..255
}

export interface ToneCurveChannels {
  rgb: CurvePoint[];
  red: CurvePoint[];
  green: CurvePoint[];
  blue: CurvePoint[];
}

export type HslColorKey =
  | 'red'
  | 'orange'
  | 'yellow'
  | 'green'
  | 'aqua'
  | 'blue'
  | 'purple'
  | 'magenta';

export interface HslBandAdjustment {
  h: number; // -100..100
  s: number; // -100..100
  l: number; // -100..100
}

export type HslMixerState = Record<HslColorKey, HslBandAdjustment>;

export interface ColorWheelValue {
  hue: number; // 0..360
  sat: number; // 0..100
  lum: number; // -100..100
}

export interface ColorGradingState {
  shadows: ColorWheelValue;
  midtones: ColorWheelValue;
  highlights: ColorWheelValue;
  blending: number; // 0..100
  balance: number;  // -100..100
}

export interface Adjustments {
  // Light
  exposure: number;    // -100 to 100
  brightness: number;  // -100 to 100
  contrast: number;    // -100 to 100
  highlights: number;  // -100 to 100
  shadows: number;     // -100 to 100
  whites: number;      // -100 to 100
  blacks: number;      // -100 to 100
  toneCurve: ToneCurveChannels;

  // Color
  whiteBalance: WhiteBalanceMode;
  temperature: number; // -100 to 100
  tint: number;        // -100 to 100
  saturation: number;  // -100 to 100
  vibrance: number;    // -100 to 100
  hsl: HslMixerState;
  colorGrading: ColorGradingState;

  // Detail & Effects
  texture: number;     // -100 to 100
  clarity: number;     // -100 to 100
  dehaze: number;      // -100 to 100
  sharpness: number;   // 0 to 100
  luminanceNR: number; // 0 to 100
  colorNR: number;     // 0 to 100
  vignette: number;    // -100 to 100
  grain: number;       // 0 to 100

  // Subtle film tone & 3D LUT options
  fade: number;        // 0 to 50
  splitTone: SplitToneMode;
  lut: Lut3DData | null;
  lutIntensity: number; // 0 to 100
}

export interface CropRect {
  x: number;      // 0..1
  y: number;      // 0..1
  width: number;  // 0..1
  height: number; // 0..1
}

export interface TransformState {
  rotate90: 0 | 1 | 2 | 3;
  straighten: number; // -45 to 45 degrees
  flipH: boolean;
  flipV: boolean;
  crop: CropRect;
  aspectRatio: AspectRatioOption;
  // Optics & Perspective
  lensDistortion: number;      // -100 to 100
  chromaticAberration: number; // 0 to 100
  perspectiveV: number;        // -100 to 100
  perspectiveH: number;        // -100 to 100
}

// ---------- MASKING SYSTEM TYPES ----------

export type MaskCreationTool =
  | 'subject'
  | 'sky'
  | 'background'
  | 'brush'
  | 'linear'
  | 'radial'
  | 'color-range'
  | 'luminance-range'
  | 'object';

export type MaskOperation = 'add' | 'subtract' | 'intersect';

export interface MaskRasterData {
  width: number;
  height: number;
  data: Uint8Array; // 0..255 single-channel alpha
}

export type MaskComponent =
  | {
      id: string;
      op: MaskOperation;
      kind: 'subject' | 'sky' | 'background' | 'object';
      raster: MaskRasterData;
      label: string;
    }
  | {
      id: string;
      op: MaskOperation;
      kind: 'brush';
      raster: MaskRasterData;
    }
  | {
      id: string;
      op: MaskOperation;
      kind: 'linear';
      x0: number; // normalized 0..1 base image coords
      y0: number;
      x1: number;
      y1: number;
    }
  | {
      id: string;
      op: MaskOperation;
      kind: 'radial';
      cx: number; // normalized 0..1 base image coords
      cy: number;
      rx: number; // normalized radii
      ry: number;
      angle: number; // degrees
      feather: number; // 0..100
    }
  | {
      id: string;
      op: MaskOperation;
      kind: 'color-range';
      targetRgb: [number, number, number];
      tolerance: number; // 1..100
      smoothness: number; // 0..100
    }
  | {
      id: string;
      op: MaskOperation;
      kind: 'luminance-range';
      minLum: number; // 0..100
      maxLum: number; // 0..100
      smoothness: number; // 0..100
    }
  | {
      id: string;
      op: MaskOperation;
      kind: 'mask-ref';
      sourceMaskId: string;
      sourceRaster: MaskRasterData;
      label: string;
    };

export interface LocalAdjustments {
  exposure: number;
  brightness: number;
  contrast: number;
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
  temperature: number;
  tint: number;
  saturation: number;
  texture: number;
  clarity: number;
  dehaze: number;
  sharpness: number;
  noiseReduction: number;
}

export interface MaskLayer {
  id: string;
  name: string;
  enabled: boolean;
  inverted: boolean;
  overlayColor: string;
  showOverlay: boolean;
  feather: number;        // 0..100
  density: number;        // 0..100
  edgeRefinement: number; // 0..100
  components: MaskComponent[];
  adjustments: LocalAdjustments;
}

export interface MaskBrushSettings {
  size: number;     // 8..200 px
  feather: number;  // 0..100 %
  flow: number;     // 5..100 %
  density: number;  // 5..100 %
}

export interface EditState {
  adjustments: Adjustments;
  transform: TransformState;
  activePresetId: string | null;
}

export interface Preset {
  id: string;
  name: string;
  category?: Exclude<PresetCategory, 'All' | 'My Presets'>;
  isCustom?: boolean;
  sourceFormat?: PresetSourceFormat;
  importSummary?: string;
  createdAt?: string;
  adjustments: Partial<Adjustments>;
}

export type CompareMode = 'off' | 'split' | 'hold';

export type EditorTab = 'edit' | 'masking' | 'retouch' | 'presets' | 'crop';
export type MobileSubTab = 'adjust' | 'masking' | 'retouch' | 'presets' | 'crop';
export type EditSubSection = 'light' | 'color' | 'detail' | 'optics';

export type RetouchTool =
  | 'object-remover'
  | 'eraser'
  | 'healing'
  | 'clone'
  | 'background';

export type BackgroundMode = 'transparent' | 'solid' | 'image';

export type BackgroundRemovalMode = 'portrait' | 'general' | 'product' | 'manual';

export interface BgRefinementSettings {
  mode: BackgroundRemovalMode;
  refineEdge: number;          // 0..100
  feather: number;             // 0..40 px
  smooth: number;              // 0..100
  contrast: number;            // 0..100
  expandContract: number;      // -30..30 px
  hairRefinement: number;      // 0..100
  decontaminateColors: number; // 0..100
  removeColorHalo: number;     // 0..100
}

export interface BgSegmentationProgress {
  stage: 'loading-model' | 'segmenting' | 'refining';
  progress: number; // 0..100
  message: string;
}

export interface BackgroundSettings {
  mode: BackgroundMode;
  color: string;
  imageSrc: string | null;
  imageName: string | null;
}

export interface RetouchBrushConfig {
  objectBrushSize: number;
  eraserSize: number;
  eraserHardness: number;
  eraserOpacity: number;
  eraserMode: 'erase' | 'restore';
  eraserShowMask: boolean;
  healingSize: number;
  healingSoftness: number;
  cloneSize: number;
  cloneOpacity: number;
  cloneHardness: number;
  cloneAligned: boolean;
  bgBrushSize: number;
  bgBrushHardness: number;
  bgBrushFeather: number;
  bgBrushMode: 'erase' | 'restore';
  bgShowMask: boolean;
  bgMaskOverlayColor: string;
}

export interface DirtyRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RetouchNormPoint {
  nx: number; // 0..1 normalized X in base image space
  ny: number; // 0..1 normalized Y in base image space
}

export type RetouchOperation =
  | {
      id: string;
      kind: 'healing';
      points: RetouchNormPoint[];
      radiusNorm: number; // radius / max(width, height)
      softnessPct: number;
    }
  | {
      id: string;
      kind: 'clone';
      points: RetouchNormPoint[];
      deltaNx: number; // (srcX - dstX) / width
      deltaNy: number; // (srcY - dstY) / height
      radiusNorm: number; // radius / max(width, height)
      hardnessPct: number;
      opacityPct: number;
    }
  | {
      id: string;
      kind: 'object-removal';
      /** Tight bounding box of the painted object mask in normalized [0..1] coords */
      normRect: {
        x: number;
        y: number;
        width: number;
        height: number;
      };
      maskWidth: number;
      maskHeight: number;
      /** Single-channel [0..255] alpha bytes of size maskWidth * maskHeight */
      maskBytes: Uint8Array;
    };

export interface LoadedImageMeta {
  name: string;
  width: number;
  height: number;
  fileSize?: number;
  mimeType?: string;
}

export interface HistogramData {
  r: number[];
  g: number[];
  b: number[];
  l: number[];
}

export const DEFAULT_TONE_CURVE: ToneCurveChannels = {
  rgb: [
    { x: 0, y: 0 },
    { x: 255, y: 255 },
  ],
  red: [
    { x: 0, y: 0 },
    { x: 255, y: 255 },
  ],
  green: [
    { x: 0, y: 0 },
    { x: 255, y: 255 },
  ],
  blue: [
    { x: 0, y: 0 },
    { x: 255, y: 255 },
  ],
};

export const DEFAULT_HSL_MIXER: HslMixerState = {
  red: { h: 0, s: 0, l: 0 },
  orange: { h: 0, s: 0, l: 0 },
  yellow: { h: 0, s: 0, l: 0 },
  green: { h: 0, s: 0, l: 0 },
  aqua: { h: 0, s: 0, l: 0 },
  blue: { h: 0, s: 0, l: 0 },
  purple: { h: 0, s: 0, l: 0 },
  magenta: { h: 0, s: 0, l: 0 },
};

export const DEFAULT_COLOR_GRADING: ColorGradingState = {
  shadows: { hue: 0, sat: 0, lum: 0 },
  midtones: { hue: 0, sat: 0, lum: 0 },
  highlights: { hue: 0, sat: 0, lum: 0 },
  blending: 50,
  balance: 0,
};

export const DEFAULT_ADJUSTMENTS: Adjustments = {
  exposure: 0,
  brightness: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  toneCurve: DEFAULT_TONE_CURVE,
  whiteBalance: 'as-shot',
  temperature: 0,
  tint: 0,
  saturation: 0,
  vibrance: 0,
  hsl: DEFAULT_HSL_MIXER,
  colorGrading: DEFAULT_COLOR_GRADING,
  texture: 0,
  clarity: 0,
  dehaze: 0,
  sharpness: 0,
  luminanceNR: 0,
  colorNR: 0,
  vignette: 0,
  grain: 0,
  fade: 0,
  splitTone: 'none',
  lut: null,
  lutIntensity: 100,
};

export const DEFAULT_TRANSFORM: TransformState = {
  rotate90: 0,
  straighten: 0,
  flipH: false,
  flipV: false,
  crop: { x: 0, y: 0, width: 1, height: 1 },
  aspectRatio: 'free',
  lensDistortion: 0,
  chromaticAberration: 0,
  perspectiveV: 0,
  perspectiveH: 0,
};

export const DEFAULT_EDIT_STATE: EditState = {
  adjustments: {
    ...DEFAULT_ADJUSTMENTS,
    toneCurve: {
      rgb: DEFAULT_TONE_CURVE.rgb.map((p) => ({ ...p })),
      red: DEFAULT_TONE_CURVE.red.map((p) => ({ ...p })),
      green: DEFAULT_TONE_CURVE.green.map((p) => ({ ...p })),
      blue: DEFAULT_TONE_CURVE.blue.map((p) => ({ ...p })),
    },
    hsl: {
      red: { ...DEFAULT_HSL_MIXER.red },
      orange: { ...DEFAULT_HSL_MIXER.orange },
      yellow: { ...DEFAULT_HSL_MIXER.yellow },
      green: { ...DEFAULT_HSL_MIXER.green },
      aqua: { ...DEFAULT_HSL_MIXER.aqua },
      blue: { ...DEFAULT_HSL_MIXER.blue },
      purple: { ...DEFAULT_HSL_MIXER.purple },
      magenta: { ...DEFAULT_HSL_MIXER.magenta },
    },
    colorGrading: {
      shadows: { ...DEFAULT_COLOR_GRADING.shadows },
      midtones: { ...DEFAULT_COLOR_GRADING.midtones },
      highlights: { ...DEFAULT_COLOR_GRADING.highlights },
      blending: DEFAULT_COLOR_GRADING.blending,
      balance: DEFAULT_COLOR_GRADING.balance,
    },
  },
  transform: { ...DEFAULT_TRANSFORM, crop: { ...DEFAULT_TRANSFORM.crop } },
  activePresetId: null,
};

export const DEFAULT_LOCAL_ADJUSTMENTS: LocalAdjustments = {
  exposure: 0,
  brightness: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  temperature: 0,
  tint: 0,
  saturation: 0,
  texture: 0,
  clarity: 0,
  dehaze: 0,
  sharpness: 0,
  noiseReduction: 0,
};

export const DEFAULT_MASK_BRUSH_SETTINGS: MaskBrushSettings = {
  size: 56,
  feather: 60,
  flow: 100,
  density: 100,
};

export const DEFAULT_BACKGROUND_SETTINGS: BackgroundSettings = {
  mode: 'transparent',
  color: '#09090b',
  imageSrc: null,
  imageName: null,
};

export const DEFAULT_BG_REFINEMENT_SETTINGS: BgRefinementSettings = {
  mode: 'portrait',
  refineEdge: 45,
  feather: 1,
  smooth: 15,
  contrast: 12,
  expandContract: 0,
  hairRefinement: 65,
  decontaminateColors: 60,
  removeColorHalo: 55,
};

export function getDefaultRefinementForMode(mode: BackgroundRemovalMode): BgRefinementSettings {
  switch (mode) {
    case 'portrait':
      return { ...DEFAULT_BG_REFINEMENT_SETTINGS, mode: 'portrait' };
    case 'general':
      return {
        mode: 'general',
        refineEdge: 35,
        feather: 0.5,
        smooth: 18,
        contrast: 22,
        expandContract: 0,
        hairRefinement: 25,
        decontaminateColors: 45,
        removeColorHalo: 45,
      };
    case 'product':
      return {
        mode: 'product',
        refineEdge: 30,
        feather: 0,
        smooth: 22,
        contrast: 42,
        expandContract: -1,
        hairRefinement: 10,
        decontaminateColors: 55,
        removeColorHalo: 65,
      };
    case 'manual':
      return {
        mode: 'manual',
        refineEdge: 20,
        feather: 0,
        smooth: 10,
        contrast: 10,
        expandContract: 0,
        hairRefinement: 15,
        decontaminateColors: 35,
        removeColorHalo: 35,
      };
  }
}

export const DEFAULT_RETOUCH_BRUSH_CONFIG: RetouchBrushConfig = {
  objectBrushSize: 42,
  eraserSize: 48,
  eraserHardness: 75,
  eraserOpacity: 100,
  eraserMode: 'erase',
  eraserShowMask: false,
  healingSize: 28,
  healingSoftness: 75,
  cloneSize: 40,
  cloneOpacity: 100,
  cloneHardness: 65,
  cloneAligned: true,
  bgBrushSize: 48,
  bgBrushHardness: 75,
  bgBrushFeather: 25,
  bgBrushMode: 'restore',
  bgShowMask: false,
  bgMaskOverlayColor: '#ef4444',
};

// ---------- LOCAL INDEXEDDB PROJECT PERSISTENCE TYPES ----------

export type AutoSaveStatus = 'idle' | 'saving' | 'saved' | 'error';

export interface StorageQuotaStatus {
  supported: boolean;
  usageBytes: number;
  quotaBytes: number;
  percentUsed: number;
  remainingBytes: number;
  isNearLimit: boolean;
}

export interface SavedProjectSummary {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  fileName: string;
  width: number;
  height: number;
  fileSize?: number;
  mimeType?: string;
  thumbnailDataUrl: string;
  activePresetId: string | null;
  activePresetName: string | null;
  maskCount: number;
  retouchCount: number;
  hasTransparency: boolean;
  estimatedBytes: number;
}

export type SerializedHistoryEntry =
  | { kind: 'state'; prev: EditState; next: EditState }
  | { kind: 'retouch-rgb'; rect: DirtyRect; retouchOp?: RetouchOperation }
  | {
      kind: 'retouch-alpha';
      rect: DirtyRect;
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

export interface SavedProjectStatePayload {
  projectId: string;
  editState: EditState;
  maskLayers: MaskLayer[];
  activeMaskId: string | null;
  activeRetouchOps: RetouchOperation[];
  archivedRetouchOps: RetouchOperation[];
  bgSettings: BackgroundSettings;
  bgRefinement: BgRefinementSettings;
  bgLastModelLabel: string | null;
  hasTransparency: boolean;
  historyEntries: SerializedHistoryEntry[];
  historyCursor: number;
  updatedAt: string;
}

export interface SavedProjectAssetsPayload {
  projectId: string;
  sourceBlob: Blob;
  bgImageBlob: Blob | null;
  alphaPngBlob: Blob | null;
  rawAutoAlphaPngBlob: Blob | null;
  manualAlphaDelta: Int16Array | null;
  assetVersion: number;
}

