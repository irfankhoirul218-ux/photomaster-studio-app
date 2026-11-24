import {
  Adjustments,
  ColorGradingState,
  CurvePoint,
  DEFAULT_ADJUSTMENTS,
  DEFAULT_COLOR_GRADING,
  DEFAULT_HSL_MIXER,
  DEFAULT_TONE_CURVE,
  HslColorKey,
  HslMixerState,
  Lut3DData,
  Preset,
  PresetCategory,
  PresetSourceFormat,
  SplitToneMode,
  ToneCurveChannels,
  WhiteBalanceMode,
} from '../types/editor';

export interface ParsedPresetResult {
  preset: Preset;
  warnings: string[];
}

export interface PhotoMasterJsonPresetSchema {
  schema: 'photomaster-studio/preset/v1' | 'photomaster-studio/preset/v2';
  version: 1 | 2;
  name: string;
  category?: Exclude<PresetCategory, 'All' | 'My Presets'>;
  createdAt: string;
  sourceFormat?: PresetSourceFormat;
  adjustments: Omit<Adjustments, 'lut'>;
  lut: {
    size: number;
    domainMin: [number, number, number];
    domainMax: [number, number, number];
    title?: string;
    table: number[];
  } | null;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function uniquePresetId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

function stripExtension(filename: string): string {
  return filename.replace(/\.[^.]+$/, '').trim() || 'Imported Preset';
}

function parseBool(val: string | boolean | number | undefined): boolean {
  if (typeof val === 'boolean') return val;
  if (typeof val === 'number') return val !== 0;
  if (typeof val === 'string') {
    const s = val.trim().toLowerCase();
    return s === 'true' || s === '1' || s === 'yes';
  }
  return false;
}

function parseXmpCurvePoints(serialized: unknown): CurvePoint[] | null {
  if (typeof serialized !== 'string' || !serialized.trim()) return null;
  const pairs = serialized
    .split(';')
    .map((item) => item.trim())
    .filter(Boolean);
  const pts: CurvePoint[] = [];
  for (const pair of pairs) {
    const m = pair.match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
    if (m) {
      pts.push({
        x: clamp(Math.round(Number(m[1])), 0, 255),
        y: clamp(Math.round(Number(m[2])), 0, 255),
      });
    }
  }
  if (pts.length < 2) return null;
  pts.sort((a, b) => a.x - b.x);
  return pts;
}

const LR_HSL_COLORS: { lr: string; key: HslColorKey }[] = [
  { lr: 'Red', key: 'red' },
  { lr: 'Orange', key: 'orange' },
  { lr: 'Yellow', key: 'yellow' },
  { lr: 'Green', key: 'green' },
  { lr: 'Aqua', key: 'aqua' },
  { lr: 'Blue', key: 'blue' },
  { lr: 'Purple', key: 'purple' },
  { lr: 'Magenta', key: 'magenta' },
];

/**
 * Maps Adobe Lightroom / Camera Raw develop parameters (.XMP and .LRTEMPLATE)
 * into PhotoMaster Studio adjustment sliders.
 */
function mapLightroomSettings(
  raw: Record<string, string | number | boolean>
): { adjustments: Partial<Adjustments>; mappedFields: string[]; warnings: string[] } {
  const adj: Partial<Adjustments> = {};
  const mappedFields: string[] = [];
  const warnings: string[] = [];

  const getNum = (...keys: string[]): number | null => {
    for (const k of keys) {
      if (raw[k] !== undefined && raw[k] !== '') {
        const n = Number(raw[k]);
        if (Number.isFinite(n)) return n;
      }
    }
    return null;
  };

  // Exposure: Lightroom uses -5.0..+5.0 EV (typical preset range -2.5..+2.5)
  const exp2012 = getNum('Exposure2012');
  const expLegacy = getNum('Exposure');
  if (exp2012 !== null) {
    adj.exposure = clamp(Math.round(exp2012 * 40), -100, 100);
    mappedFields.push('Exposure');
  } else if (expLegacy !== null) {
    adj.exposure = clamp(Math.round(expLegacy * 40), -100, 100);
    mappedFields.push('Exposure');
  }

  // Contrast: -100..+100
  const contrast = getNum('Contrast2012', 'Contrast');
  if (contrast !== null) {
    adj.contrast = clamp(Math.round(contrast), -100, 100);
    mappedFields.push('Contrast');
  }

  // Brightness (legacy PV2010/2003)
  const legacyBright = getNum('Brightness');
  if (legacyBright !== null) {
    adj.brightness = clamp(Math.round(legacyBright * 0.6), -100, 100);
    mappedFields.push('Brightness');
  }

  // Whites & Blacks native mapping
  const whites = getNum('Whites2012');
  if (whites !== null) {
    adj.whites = clamp(Math.round(whites), -100, 100);
    mappedFields.push('Whites');
  }
  const blacks = getNum('Blacks2012');
  if (blacks !== null) {
    adj.blacks = clamp(Math.round(blacks), -100, 100);
    mappedFields.push('Blacks');
  }

  // Highlights: Highlights2012 (-100..100) or legacy Recovery (0..100 -> negative highlights)
  const highlights = getNum('Highlights2012');
  const recovery = getNum('Recovery');
  if (highlights !== null) {
    adj.highlights = clamp(Math.round(highlights), -100, 100);
    mappedFields.push('Highlights');
  } else if (recovery !== null) {
    adj.highlights = clamp(Math.round(-recovery), -100, 100);
    mappedFields.push('Highlights');
  }

  // Shadows: Shadows2012 (-100..100) or legacy FillLight (0..100)
  const shadows = getNum('Shadows2012');
  const fillLight = getNum('FillLight');
  if (shadows !== null) {
    adj.shadows = clamp(Math.round(shadows), -100, 100);
    mappedFields.push('Shadows');
  } else if (fillLight !== null) {
    adj.shadows = clamp(Math.round(fillLight * 0.9), -100, 100);
    mappedFields.push('Shadows');
  }

  // Temperature: presets often store relative offset (-100..100) or absolute Kelvin (2000..12000)
  const temp = getNum('Temperature');
  if (temp !== null) {
    if (temp > 500) {
      adj.temperature = clamp(Math.round(((temp - 5500) / 3500) * 100), -100, 100);
    } else {
      adj.temperature = clamp(Math.round(temp), -100, 100);
    }
    mappedFields.push('Temperature');
  }

  // Tint: -150..+150
  const tint = getNum('Tint');
  if (tint !== null) {
    adj.tint = clamp(Math.round(tint), -100, 100);
    mappedFields.push('Tint');
  }

  // Vibrance & Saturation
  const vibrance = getNum('Vibrance');
  if (vibrance !== null) {
    adj.vibrance = clamp(Math.round(vibrance), -100, 100);
    mappedFields.push('Vibrance');
  }

  const saturation = getNum('Saturation');
  if (saturation !== null) {
    adj.saturation = clamp(Math.round(saturation), -100, 100);
    mappedFields.push('Saturation');
  }

  // Grayscale / Black & White conversion
  const grayscale =
    parseBool(raw['ConvertToGrayscale']) ||
    String(raw['Treatment'] ?? '').toLowerCase().includes('black');
  if (grayscale) {
    adj.saturation = -100;
    if (!mappedFields.includes('Saturation')) mappedFields.push('B&W');
  }

  // Native Clarity, Texture & Dehaze
  const clarity = getNum('Clarity2012', 'Clarity');
  if (clarity !== null) {
    adj.clarity = clamp(Math.round(clarity), -100, 100);
    mappedFields.push('Clarity');
  }
  const texture = getNum('Texture');
  if (texture !== null) {
    adj.texture = clamp(Math.round(texture), -100, 100);
    mappedFields.push('Texture');
  }
  const dehaze = getNum('Dehaze');
  if (dehaze !== null) {
    adj.dehaze = clamp(Math.round(dehaze), -100, 100);
    mappedFields.push('Dehaze');
  }

  // Sharpness (LR 0..150 -> PhotoMaster 0..100) & Noise Reduction
  const sharpness = getNum('Sharpness');
  if (sharpness !== null) {
    adj.sharpness = clamp(Math.round((sharpness / 150) * 100), 0, 100);
    mappedFields.push('Sharpness');
  }
  const lumNR = getNum('LuminanceSmoothing');
  if (lumNR !== null) {
    adj.luminanceNR = clamp(Math.round(lumNR), 0, 100);
    mappedFields.push('Luminance NR');
  }
  const colNR = getNum('ColorNoiseReduction');
  if (colNR !== null) {
    adj.colorNR = clamp(Math.round(colNR), 0, 100);
    mappedFields.push('Color NR');
  }

  // Vignette (PostCropVignetteAmount or VignetteAmount)
  const vignette = getNum('PostCropVignetteAmount', 'VignetteAmount');
  if (vignette !== null) {
    adj.vignette = clamp(Math.round(vignette), -100, 100);
    mappedFields.push('Vignette');
  }

  // Grain
  const grain = getNum('GrainAmount');
  if (grain !== null) {
    adj.grain = clamp(Math.round(grain), 0, 100);
    mappedFields.push('Grain');
  }

  // Native 8-band HSL Mixer mapping
  const hsl: HslMixerState = {
    red: { ...DEFAULT_HSL_MIXER.red },
    orange: { ...DEFAULT_HSL_MIXER.orange },
    yellow: { ...DEFAULT_HSL_MIXER.yellow },
    green: { ...DEFAULT_HSL_MIXER.green },
    aqua: { ...DEFAULT_HSL_MIXER.aqua },
    blue: { ...DEFAULT_HSL_MIXER.blue },
    purple: { ...DEFAULT_HSL_MIXER.purple },
    magenta: { ...DEFAULT_HSL_MIXER.magenta },
  };
  let hasHsl = false;
  for (const { lr, key } of LR_HSL_COLORS) {
    const h = getNum(`HueAdjustment${lr}`);
    const s = getNum(`SaturationAdjustment${lr}`);
    const l = getNum(`LuminanceAdjustment${lr}`);
    if (h !== null) {
      hsl[key].h = clamp(Math.round(h), -100, 100);
      hasHsl = true;
    }
    if (s !== null) {
      hsl[key].s = clamp(Math.round(s), -100, 100);
      hasHsl = true;
    }
    if (l !== null) {
      hsl[key].l = clamp(Math.round(l), -100, 100);
      hasHsl = true;
    }
  }
  if (hasHsl) {
    adj.hsl = hsl;
    mappedFields.push('HSL Mixer');
  }

  // Native RGB & R/G/B Tone Curve mapping
  const rgbPts = parseXmpCurvePoints(raw['ToneCurvePV2012']);
  const rPts = parseXmpCurvePoints(raw['ToneCurvePV2012Red']);
  const gPts = parseXmpCurvePoints(raw['ToneCurvePV2012Green']);
  const bPts = parseXmpCurvePoints(raw['ToneCurvePV2012Blue']);
  if (rgbPts || rPts || gPts || bPts) {
    adj.toneCurve = {
      rgb: rgbPts ?? DEFAULT_TONE_CURVE.rgb.map((p) => ({ ...p })),
      red: rPts ?? DEFAULT_TONE_CURVE.red.map((p) => ({ ...p })),
      green: gPts ?? DEFAULT_TONE_CURVE.green.map((p) => ({ ...p })),
      blue: bPts ?? DEFAULT_TONE_CURVE.blue.map((p) => ({ ...p })),
    };
    mappedFields.push('Tone Curve');
  }

  // Native 3-Way Color Grading / Split Toning mapping
  const shHue = getNum('ColorGradeShadowHue', 'SplitToningShadowHue');
  const shSat = getNum('ColorGradeShadowSat', 'SplitToningShadowSaturation');
  const shLum = getNum('ColorGradeShadowLum');
  const midHue = getNum('ColorGradeMidtoneHue');
  const midSat = getNum('ColorGradeMidtoneSat');
  const midLum = getNum('ColorGradeMidtoneLum');
  const hiHue = getNum('ColorGradeHighlightHue', 'SplitToningHighlightHue');
  const hiSat = getNum('ColorGradeHighlightSat', 'SplitToningHighlightSaturation');
  const hiLum = getNum('ColorGradeHighlightLum');
  const cgBlend = getNum('ColorGradeBlending');
  const cgBal = getNum('SplitToningBalance', 'ColorGradeBalance');

  if (
    shSat !== null ||
    midSat !== null ||
    hiSat !== null ||
    shLum !== null ||
    midLum !== null ||
    hiLum !== null
  ) {
    adj.colorGrading = {
      shadows: {
        hue: clamp(Math.round(shHue ?? 0), 0, 360),
        sat: clamp(Math.round(shSat ?? 0), 0, 100),
        lum: clamp(Math.round(shLum ?? 0), -100, 100),
      },
      midtones: {
        hue: clamp(Math.round(midHue ?? 0), 0, 360),
        sat: clamp(Math.round(midSat ?? 0), 0, 100),
        lum: clamp(Math.round(midLum ?? 0), -100, 100),
      },
      highlights: {
        hue: clamp(Math.round(hiHue ?? 0), 0, 360),
        sat: clamp(Math.round(hiSat ?? 0), 0, 100),
        lum: clamp(Math.round(hiLum ?? 0), -100, 100),
      },
      blending: clamp(Math.round(cgBlend ?? DEFAULT_COLOR_GRADING.blending), 0, 100),
      balance: clamp(Math.round(cgBal ?? DEFAULT_COLOR_GRADING.balance), -100, 100),
    };
    mappedFields.push('Color Grading');
  }

  return { adjustments: adj, mappedFields, warnings };
}

/**
 * Parses Adobe Lightroom / Camera Raw .XMP preset files.
 */
function parseXmpPreset(text: string, fileName: string): ParsedPresetResult {
  const parser = new DOMParser();
  const doc = parser.parseFromString(text, 'application/xml');
  const parserError = doc.querySelector('parsererror');
  if (parserError) {
    throw new Error('Corrupted or invalid XML structure in .XMP file.');
  }

  const rawSettings: Record<string, string | number | boolean> = {};
  let detectedName = '';

  const allElements = Array.from(doc.getElementsByTagName('*'));
  for (const el of allElements) {
    for (const attr of Array.from(el.attributes)) {
      const localName = attr.localName || attr.name.split(':').pop() || attr.name;
      rawSettings[localName] = attr.value;
      if (localName === 'PresetName' && attr.value.trim()) {
        detectedName = attr.value.trim();
      }
    }

    const elLocal = el.localName || el.tagName.split(':').pop() || el.tagName;
    if (el.children.length === 0 && el.textContent && el.textContent.trim()) {
      rawSettings[elLocal] = el.textContent.trim();
    }

    if (!detectedName && (elLocal === 'Name' || elLocal === 'title')) {
      const li = el.getElementsByTagName('rdf:li')[0] || el.getElementsByTagName('li')[0];
      if (li?.textContent?.trim()) {
        detectedName = li.textContent.trim();
      }
    }

    if (
      elLocal === 'ToneCurvePV2012' ||
      elLocal === 'ToneCurvePV2012Red' ||
      elLocal === 'ToneCurvePV2012Green' ||
      elLocal === 'ToneCurvePV2012Blue'
    ) {
      const items = Array.from(el.getElementsByTagName('*'))
        .filter((child) => (child.localName || child.tagName) === 'li')
        .map((child) => child.textContent?.trim() ?? '')
        .filter(Boolean);
      if (items.length > 0) {
        rawSettings[elLocal] = items.join('; ');
      }
    }
  }

  const { adjustments, mappedFields, warnings } = mapLightroomSettings(rawSettings);
  if (mappedFields.length === 0) {
    throw new Error(
      'No compatible Lightroom or Camera Raw develop settings were found in this .XMP file.'
    );
  }

  const name = detectedName || stripExtension(fileName);
  return {
    preset: {
      id: uniquePresetId('imported-xmp'),
      name,
      isCustom: true,
      sourceFormat: 'xmp',
      importSummary: `XMP · ${mappedFields.length} settings mapped`,
      createdAt: new Date().toISOString(),
      adjustments,
    },
    warnings,
  };
}

/**
 * Downsamples a 3D LUT to targetSize (e.g. 33) via trilinear interpolation
 * for fast browser rendering and compact localStorage persistence.
 */
function downsampleLut3D(lut: Lut3DData, targetSize: number): Lut3DData {
  const srcSize = lut.size;
  const outTable = new Float32Array(targetSize * targetSize * targetSize * 3);

  const sampleAt = (r: number, g: number, b: number, c: number): number => {
    const ri = clamp(r, 0, srcSize - 1);
    const gi = clamp(g, 0, srcSize - 1);
    const bi = clamp(b, 0, srcSize - 1);
    return lut.table[(bi * srcSize * srcSize + gi * srcSize + ri) * 3 + c];
  };

  for (let b = 0; b < targetSize; b++) {
    const fb = (b / (targetSize - 1)) * (srcSize - 1);
    const b0 = Math.floor(fb);
    const b1 = Math.min(srcSize - 1, b0 + 1);
    const db = fb - b0;

    for (let g = 0; g < targetSize; g++) {
      const fg = (g / (targetSize - 1)) * (srcSize - 1);
      const g0 = Math.floor(fg);
      const g1 = Math.min(srcSize - 1, g0 + 1);
      const dg = fg - g0;

      for (let r = 0; r < targetSize; r++) {
        const fr = (r / (targetSize - 1)) * (srcSize - 1);
        const r0 = Math.floor(fr);
        const r1 = Math.min(srcSize - 1, r0 + 1);
        const dr = fr - r0;

        const outIdx = (b * targetSize * targetSize + g * targetSize + r) * 3;
        for (let c = 0; c < 3; c++) {
          const c000 = sampleAt(r0, g0, b0, c);
          const c100 = sampleAt(r1, g0, b0, c);
          const c010 = sampleAt(r0, g1, b0, c);
          const c110 = sampleAt(r1, g1, b0, c);
          const c001 = sampleAt(r0, g0, b1, c);
          const c101 = sampleAt(r1, g0, b1, c);
          const c011 = sampleAt(r0, g1, b1, c);
          const c111 = sampleAt(r1, g1, b1, c);

          const c00 = c000 * (1 - dr) + c100 * dr;
          const c10 = c010 * (1 - dr) + c110 * dr;
          const c01 = c001 * (1 - dr) + c101 * dr;
          const c11 = c011 * (1 - dr) + c111 * dr;

          const c0 = c00 * (1 - dg) + c10 * dg;
          const c1 = c01 * (1 - dg) + c11 * dg;

          outTable[outIdx + c] = c0 * (1 - db) + c1 * db;
        }
      }
    }
  }

  return {
    size: targetSize,
    domainMin: lut.domainMin,
    domainMax: lut.domainMax,
    table: outTable,
    title: lut.title,
  };
}

/**
 * Parses Adobe / Iridas .CUBE 3D (and 1D) LUT color grading files.
 */
function parseCubePreset(text: string, fileName: string): ParsedPresetResult {
  const lines = text.split(/\r?\n/);
  let title = '';
  let size3D: number | null = null;
  let size1D: number | null = null;
  let domainMin: [number, number, number] = [0, 0, 0];
  let domainMax: [number, number, number] = [1, 1, 1];
  const values: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i].split('#')[0].trim();
    if (!rawLine) continue;

    if (rawLine.startsWith('TITLE')) {
      const m = rawLine.match(/^TITLE\s+"?([^"]*)"?$/i);
      if (m?.[1]) title = m[1].trim();
      continue;
    }

    if (rawLine.startsWith('LUT_3D_SIZE')) {
      const n = Number(rawLine.split(/\s+/)[1]);
      if (!Number.isInteger(n) || n < 2 || n > 128) {
        throw new Error('Invalid LUT_3D_SIZE in .CUBE file (must be an integer between 2 and 128).');
      }
      size3D = n;
      continue;
    }

    if (rawLine.startsWith('LUT_1D_SIZE')) {
      const n = Number(rawLine.split(/\s+/)[1]);
      if (!Number.isInteger(n) || n < 2 || n > 4096) {
        throw new Error('Invalid LUT_1D_SIZE in .CUBE file.');
      }
      size1D = n;
      continue;
    }

    if (rawLine.startsWith('DOMAIN_MIN')) {
      const parts = rawLine.split(/\s+/).slice(1).map(Number);
      if (parts.length !== 3 || parts.some((v) => !Number.isFinite(v))) {
        throw new Error('Invalid DOMAIN_MIN header in .CUBE file.');
      }
      domainMin = [parts[0], parts[1], parts[2]];
      continue;
    }

    if (rawLine.startsWith('DOMAIN_MAX')) {
      const parts = rawLine.split(/\s+/).slice(1).map(Number);
      if (parts.length !== 3 || parts.some((v) => !Number.isFinite(v))) {
        throw new Error('Invalid DOMAIN_MAX header in .CUBE file.');
      }
      domainMax = [parts[0], parts[1], parts[2]];
      continue;
    }

    if (/^[A-Z0-9_]+/i.test(rawLine) && !/^[-+]?\d/.test(rawLine)) {
      // Ignore other valid metadata keywords like LUT_1D_INPUT_RANGE
      continue;
    }

    const parts = rawLine.split(/\s+/);
    if (parts.length !== 3) {
      throw new Error(`Malformed color entry on line ${i + 1} in .CUBE file.`);
    }
    const r = Number(parts[0]);
    const g = Number(parts[1]);
    const b = Number(parts[2]);
    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) {
      throw new Error(`Non-numeric RGB value on line ${i + 1} in .CUBE file.`);
    }
    values.push(clamp(r, 0, 1), clamp(g, 0, 1), clamp(b, 0, 1));
  }

  let lutData: Lut3DData;
  const warnings: string[] = [];

  if (size3D !== null) {
    const expectedTriplets = size3D * size3D * size3D;
    const foundTriplets = values.length / 3;
    if (foundTriplets !== expectedTriplets) {
      throw new Error(
        `Invalid .CUBE file: expected ${expectedTriplets.toLocaleString()} RGB entries for a ${size3D}×${size3D}×${size3D} LUT, found ${foundTriplets.toLocaleString()}.`
      );
    }
    lutData = {
      size: size3D,
      domainMin,
      domainMax,
      table: new Float32Array(values),
      title: title || undefined,
    };
    if (size3D > 33) {
      lutData = downsampleLut3D(lutData, 33);
      warnings.push(`Downsampled ${size3D}³ LUT to 33³ for smooth browser storage & performance.`);
    }
  } else if (size1D !== null) {
    if (values.length / 3 !== size1D) {
      throw new Error(
        `Invalid 1D .CUBE file: expected ${size1D} RGB entries, found ${values.length / 3}.`
      );
    }
    // Expand 1D LUT cleanly into a 17x17x17 3D LUT
    const target = 17;
    const table3d = new Float32Array(target * target * target * 3);
    const sample1D = (t: number, channel: number): number => {
      const pos = clamp(t, 0, 1) * (size1D - 1);
      const i0 = Math.floor(pos);
      const i1 = Math.min(size1D - 1, i0 + 1);
      const frac = pos - i0;
      return values[i0 * 3 + channel] * (1 - frac) + values[i1 * 3 + channel] * frac;
    };
    for (let b = 0; b < target; b++) {
      const bOut = sample1D(b / (target - 1), 2);
      for (let g = 0; g < target; g++) {
        const gOut = sample1D(g / (target - 1), 1);
        for (let r = 0; r < target; r++) {
          const idx = (b * target * target + g * target + r) * 3;
          table3d[idx] = sample1D(r / (target - 1), 0);
          table3d[idx + 1] = gOut;
          table3d[idx + 2] = bOut;
        }
      }
    }
    lutData = {
      size: target,
      domainMin,
      domainMax,
      table: table3d,
      title: title || undefined,
    };
  } else {
    throw new Error('Missing LUT_3D_SIZE (or LUT_1D_SIZE) header in .CUBE file.');
  }

  const name = title || stripExtension(fileName);
  return {
    preset: {
      id: uniquePresetId('imported-cube'),
      name,
      isCustom: true,
      sourceFormat: 'cube',
      importSummary: `CUBE ${lutData.size}³ LUT`,
      createdAt: new Date().toISOString(),
      adjustments: {
        ...DEFAULT_ADJUSTMENTS,
        lut: lutData,
        lutIntensity: 100,
      },
    },
    warnings,
  };
}

/**
 * Parses legacy Adobe Lightroom .LRTEMPLATE (Lua-style table syntax) presets.
 */
function parseLrTemplatePreset(text: string, fileName: string): ParsedPresetResult {
  if (!text.includes('{') || !text.includes('}')) {
    throw new Error('Invalid .LRTEMPLATE file structure.');
  }

  const typeMatch = text.match(/\btype\s*=\s*"([^"]+)"/);
  if (typeMatch && typeMatch[1].toLowerCase() !== 'develop') {
    throw new Error(
      `Unsupported .LRTEMPLATE type "${typeMatch[1]}". Only Develop presets can be imported.`
    );
  }

  const titleMatch =
    text.match(/\btitle\s*=\s*"([^"]+)"/) || text.match(/\binternalName\s*=\s*"([^"]+)"/);
  const name = titleMatch?.[1]?.trim() || stripExtension(fileName);

  // Locate settings = { ... } block with balanced braces
  const settingsMatch = /\bsettings\s*=\s*\{/.exec(text);
  if (!settingsMatch) {
    throw new Error('No "settings" block found in this .LRTEMPLATE file.');
  }

  const startIdx = settingsMatch.index + settingsMatch[0].length;
  let depth = 1;
  let endIdx = startIdx;
  while (endIdx < text.length && depth > 0) {
    const ch = text[endIdx];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    endIdx++;
  }

  if (depth !== 0) {
    throw new Error('Corrupted .LRTEMPLATE file: unbalanced settings block.');
  }

  const settingsBody = text.slice(startIdx, endIdx - 1);
  const rawSettings: Record<string, string | number | boolean> = {};

  // Parse top-level scalar Key = Value entries inside settings
  let braceDepth = 0;
  const lines = settingsBody.split(/\r?\n/);
  for (const line of lines) {
    // Track nested tables like ToneCurvePV2012 = { ... }
    const opens = (line.match(/\{/g) || []).length;
    const closes = (line.match(/\}/g) || []).length;

    if (braceDepth === 0) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.+?)\s*,?\s*$/);
      if (m) {
        const key = m[1];
        let val = m[2].trim();
        if (val.startsWith('"') && val.endsWith('"')) {
          val = val.slice(1, -1);
          rawSettings[key] = val;
        } else if (val === 'true' || val === 'false') {
          rawSettings[key] = val === 'true';
        } else if (!val.startsWith('{') && !Number.isNaN(Number(val))) {
          rawSettings[key] = Number(val);
        }
      }
    }
    braceDepth = Math.max(0, braceDepth + opens - closes);
  }

  const { adjustments, mappedFields, warnings } = mapLightroomSettings(rawSettings);
  if (mappedFields.length === 0) {
    throw new Error(
      'No compatible develop parameters could be parsed from this .LRTEMPLATE file.'
    );
  }

  return {
    preset: {
      id: uniquePresetId('imported-lrt'),
      name,
      isCustom: true,
      sourceFormat: 'lrtemplate',
      importSummary: `LRT · ${mappedFields.length} settings mapped`,
      createdAt: new Date().toISOString(),
      adjustments,
    },
    warnings,
  };
}

const VALID_SPLIT_TONES: SplitToneMode[] = ['none', 'cinematic', 'moody', 'vintage', 'golden'];
const VALID_WB_MODES: WhiteBalanceMode[] = [
  'as-shot',
  'daylight',
  'cloudy',
  'shade',
  'tungsten',
  'fluorescent',
  'custom',
];
const VALID_CATEGORIES: Exclude<PresetCategory, 'All' | 'My Presets'>[] = [
  'Landscape',
  'Portrait',
  'Cinematic',
  'Monochrome',
  'Vintage',
];

function sanitizeCurvePoints(raw: unknown): CurvePoint[] | null {
  if (!Array.isArray(raw) || raw.length < 2) return null;
  const pts: CurvePoint[] = [];
  for (const p of raw) {
    if (
      p &&
      typeof p === 'object' &&
      typeof (p as CurvePoint).x === 'number' &&
      typeof (p as CurvePoint).y === 'number'
    ) {
      pts.push({
        x: clamp(Math.round((p as CurvePoint).x), 0, 255),
        y: clamp(Math.round((p as CurvePoint).y), 0, 255),
      });
    }
  }
  if (pts.length < 2) return null;
  pts.sort((a, b) => a.x - b.x);
  return pts;
}

/**
 * Parses PhotoMaster Studio .JSON preset files (schema v1 or v2).
 */
function parseJsonPreset(text: string, fileName: string): ParsedPresetResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Corrupted .JSON file: could not parse JSON syntax.');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid .JSON preset format: root must be a JSON object.');
  }

  const obj = parsed as Record<string, unknown>;
  const adjObj =
    obj.adjustments && typeof obj.adjustments === 'object' && !Array.isArray(obj.adjustments)
      ? (obj.adjustments as Record<string, unknown>)
      : null;

  const lutObj =
    obj.lut && typeof obj.lut === 'object' && !Array.isArray(obj.lut)
      ? (obj.lut as Record<string, unknown>)
      : null;

  if (!adjObj && !lutObj) {
    throw new Error(
      'Invalid PhotoMaster .JSON preset: missing "adjustments" or "lut" properties.'
    );
  }

  const cleanAdj: Partial<Adjustments> = {};
  let validCount = 0;

  const numField = (key: keyof Adjustments, min: number, max: number) => {
    if (adjObj && typeof adjObj[key] === 'number' && Number.isFinite(adjObj[key] as number)) {
      (cleanAdj[key] as number) = clamp(Math.round((adjObj[key] as number) * 10) / 10, min, max);
      validCount++;
    }
  };

  numField('exposure', -100, 100);
  numField('brightness', -100, 100);
  numField('contrast', -100, 100);
  numField('highlights', -100, 100);
  numField('shadows', -100, 100);
  numField('whites', -100, 100);
  numField('blacks', -100, 100);
  numField('temperature', -100, 100);
  numField('tint', -100, 100);
  numField('saturation', -100, 100);
  numField('vibrance', -100, 100);
  numField('texture', -100, 100);
  numField('clarity', -100, 100);
  numField('dehaze', -100, 100);
  numField('sharpness', 0, 100);
  numField('luminanceNR', 0, 100);
  numField('colorNR', 0, 100);
  numField('vignette', -100, 100);
  numField('grain', 0, 100);
  numField('fade', 0, 50);
  numField('lutIntensity', 0, 100);

  if (
    adjObj &&
    typeof adjObj.splitTone === 'string' &&
    VALID_SPLIT_TONES.includes(adjObj.splitTone as SplitToneMode)
  ) {
    cleanAdj.splitTone = adjObj.splitTone as SplitToneMode;
    validCount++;
  }

  if (
    adjObj &&
    typeof adjObj.whiteBalance === 'string' &&
    VALID_WB_MODES.includes(adjObj.whiteBalance as WhiteBalanceMode)
  ) {
    cleanAdj.whiteBalance = adjObj.whiteBalance as WhiteBalanceMode;
    validCount++;
  }

  if (adjObj && adjObj.toneCurve && typeof adjObj.toneCurve === 'object') {
    const tcRaw = adjObj.toneCurve as Record<string, unknown>;
    const tc: ToneCurveChannels = {
      rgb: sanitizeCurvePoints(tcRaw.rgb) ?? DEFAULT_TONE_CURVE.rgb.map((p) => ({ ...p })),
      red: sanitizeCurvePoints(tcRaw.red) ?? DEFAULT_TONE_CURVE.red.map((p) => ({ ...p })),
      green: sanitizeCurvePoints(tcRaw.green) ?? DEFAULT_TONE_CURVE.green.map((p) => ({ ...p })),
      blue: sanitizeCurvePoints(tcRaw.blue) ?? DEFAULT_TONE_CURVE.blue.map((p) => ({ ...p })),
    };
    cleanAdj.toneCurve = tc;
    validCount++;
  }

  if (adjObj && adjObj.hsl && typeof adjObj.hsl === 'object') {
    const hslRaw = adjObj.hsl as Record<string, unknown>;
    const hsl: HslMixerState = {
      red: { ...DEFAULT_HSL_MIXER.red },
      orange: { ...DEFAULT_HSL_MIXER.orange },
      yellow: { ...DEFAULT_HSL_MIXER.yellow },
      green: { ...DEFAULT_HSL_MIXER.green },
      aqua: { ...DEFAULT_HSL_MIXER.aqua },
      blue: { ...DEFAULT_HSL_MIXER.blue },
      purple: { ...DEFAULT_HSL_MIXER.purple },
      magenta: { ...DEFAULT_HSL_MIXER.magenta },
    };
    for (const { key } of LR_HSL_COLORS) {
      const band = hslRaw[key];
      if (band && typeof band === 'object') {
        const bObj = band as Record<string, unknown>;
        if (typeof bObj.h === 'number') hsl[key].h = clamp(Math.round(bObj.h), -100, 100);
        if (typeof bObj.s === 'number') hsl[key].s = clamp(Math.round(bObj.s), -100, 100);
        if (typeof bObj.l === 'number') hsl[key].l = clamp(Math.round(bObj.l), -100, 100);
      }
    }
    cleanAdj.hsl = hsl;
    validCount++;
  }

  if (adjObj && adjObj.colorGrading && typeof adjObj.colorGrading === 'object') {
    const cgRaw = adjObj.colorGrading as Record<string, unknown>;
    const sanitizeWheel = (w: unknown) => {
      const wo = w && typeof w === 'object' ? (w as Record<string, unknown>) : {};
      return {
        hue: typeof wo.hue === 'number' ? clamp(Math.round(wo.hue), 0, 360) : 0,
        sat: typeof wo.sat === 'number' ? clamp(Math.round(wo.sat), 0, 100) : 0,
        lum: typeof wo.lum === 'number' ? clamp(Math.round(wo.lum), -100, 100) : 0,
      };
    };
    const cg: ColorGradingState = {
      shadows: sanitizeWheel(cgRaw.shadows),
      midtones: sanitizeWheel(cgRaw.midtones),
      highlights: sanitizeWheel(cgRaw.highlights),
      blending:
        typeof cgRaw.blending === 'number'
          ? clamp(Math.round(cgRaw.blending), 0, 100)
          : DEFAULT_COLOR_GRADING.blending,
      balance:
        typeof cgRaw.balance === 'number'
          ? clamp(Math.round(cgRaw.balance), -100, 100)
          : DEFAULT_COLOR_GRADING.balance,
    };
    cleanAdj.colorGrading = cg;
    validCount++;
  }

  if (lutObj) {
    const size = Number(lutObj.size);
    const tableRaw = lutObj.table;
    if (
      !Number.isInteger(size) ||
      size < 2 ||
      size > 65 ||
      !Array.isArray(tableRaw) ||
      tableRaw.length !== size * size * size * 3
    ) {
      throw new Error('Invalid LUT data inside .JSON preset.');
    }
    const dMin =
      Array.isArray(lutObj.domainMin) && lutObj.domainMin.length === 3
        ? ([Number(lutObj.domainMin[0]), Number(lutObj.domainMin[1]), Number(lutObj.domainMin[2])] as [
            number,
            number,
            number,
          ])
        : ([0, 0, 0] as [number, number, number]);
    const dMax =
      Array.isArray(lutObj.domainMax) && lutObj.domainMax.length === 3
        ? ([Number(lutObj.domainMax[0]), Number(lutObj.domainMax[1]), Number(lutObj.domainMax[2])] as [
            number,
            number,
            number,
          ])
        : ([1, 1, 1] as [number, number, number]);

    cleanAdj.lut = {
      size,
      domainMin: dMin,
      domainMax: dMax,
      table: new Float32Array(tableRaw.map((v) => clamp(Number(v) || 0, 0, 1))),
      title: typeof lutObj.title === 'string' ? lutObj.title : undefined,
    };
    validCount++;
  }

  if (validCount === 0) {
    throw new Error(
      'This .JSON file does not contain any recognizable PhotoMaster Studio preset parameters.'
    );
  }

  const name =
    typeof obj.name === 'string' && obj.name.trim()
      ? obj.name.trim().slice(0, 48)
      : stripExtension(fileName);

  const category =
    typeof obj.category === 'string' &&
    VALID_CATEGORIES.includes(obj.category as Exclude<PresetCategory, 'All' | 'My Presets'>)
      ? (obj.category as Exclude<PresetCategory, 'All' | 'My Presets'>)
      : undefined;

  return {
    preset: {
      id: uniquePresetId('imported-json'),
      name,
      category,
      isCustom: true,
      sourceFormat: 'json',
      importSummary: cleanAdj.lut ? `JSON + ${cleanAdj.lut.size}³ LUT` : 'PhotoMaster JSON',
      createdAt: new Date().toISOString(),
      adjustments: cleanAdj,
    },
    warnings: [],
  };
}

/**
 * Entry point to parse an uploaded preset file (.xmp, .cube, .json, .lrtemplate).
 * Explicitly rejects unsupported formats like .dng, .jpg, .icc, etc.
 */
export async function parsePresetFile(file: File): Promise<ParsedPresetResult> {
  if (file.size > 25 * 1024 * 1024) {
    throw new Error('Preset file is too large (maximum 25 MB).');
  }

  const extMatch = file.name.toLowerCase().match(/\.([a-z0-9]+)$/);
  const ext = extMatch ? extMatch[1] : '';

  if (!['xmp', 'cube', 'json', 'lrtemplate'].includes(ext)) {
    throw new Error(
      `Unsupported preset format "${ext ? '.' + ext : 'unknown'}". Supported formats: .XMP, .CUBE, .JSON, and .LRTEMPLATE.`
    );
  }

  const text = await file.text();
  if (!text || !text.trim()) {
    throw new Error(`The file "${file.name}" is empty.`);
  }

  switch (ext) {
    case 'xmp':
      return parseXmpPreset(text, file.name);
    case 'cube':
      return parseCubePreset(text, file.name);
    case 'lrtemplate':
      return parseLrTemplatePreset(text, file.name);
    case 'json':
      return parseJsonPreset(text, file.name);
    default:
      throw new Error(`Unsupported preset format ".${ext}".`);
  }
}

/**
 * Serializes any PhotoMaster Studio preset into the documented JSON preset schema.
 */
export function exportPresetToJsonString(preset: Preset): string {
  const merged: Adjustments = {
    ...DEFAULT_ADJUSTMENTS,
    ...preset.adjustments,
    toneCurve: preset.adjustments.toneCurve
      ? {
          rgb: preset.adjustments.toneCurve.rgb.map((p) => ({ ...p })),
          red: preset.adjustments.toneCurve.red.map((p) => ({ ...p })),
          green: preset.adjustments.toneCurve.green.map((p) => ({ ...p })),
          blue: preset.adjustments.toneCurve.blue.map((p) => ({ ...p })),
        }
      : {
          rgb: DEFAULT_TONE_CURVE.rgb.map((p) => ({ ...p })),
          red: DEFAULT_TONE_CURVE.red.map((p) => ({ ...p })),
          green: DEFAULT_TONE_CURVE.green.map((p) => ({ ...p })),
          blue: DEFAULT_TONE_CURVE.blue.map((p) => ({ ...p })),
        },
    hsl: preset.adjustments.hsl
      ? {
          red: { ...preset.adjustments.hsl.red },
          orange: { ...preset.adjustments.hsl.orange },
          yellow: { ...preset.adjustments.hsl.yellow },
          green: { ...preset.adjustments.hsl.green },
          aqua: { ...preset.adjustments.hsl.aqua },
          blue: { ...preset.adjustments.hsl.blue },
          purple: { ...preset.adjustments.hsl.purple },
          magenta: { ...preset.adjustments.hsl.magenta },
        }
      : DEFAULT_HSL_MIXER,
    colorGrading: preset.adjustments.colorGrading
      ? {
          shadows: { ...preset.adjustments.colorGrading.shadows },
          midtones: { ...preset.adjustments.colorGrading.midtones },
          highlights: { ...preset.adjustments.colorGrading.highlights },
          blending: preset.adjustments.colorGrading.blending,
          balance: preset.adjustments.colorGrading.balance,
        }
      : DEFAULT_COLOR_GRADING,
  };

  const { lut, ...scalarAdjustments } = merged;

  const payload: PhotoMasterJsonPresetSchema = {
    schema: 'photomaster-studio/preset/v2',
    version: 2,
    name: preset.name,
    category: preset.category,
    createdAt: preset.createdAt || new Date().toISOString(),
    sourceFormat: preset.sourceFormat || 'custom',
    adjustments: scalarAdjustments,
    lut: lut
      ? {
          size: lut.size,
          domainMin: lut.domainMin,
          domainMax: lut.domainMax,
          title: lut.title,
          table: Array.from(lut.table, (n) => Math.round(n * 10000) / 10000),
        }
      : null,
  };

  return JSON.stringify(payload, null, 2);
}
