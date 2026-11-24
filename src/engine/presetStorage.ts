import { Lut3DData, Preset } from '../types/editor';

const CUSTOM_PRESETS_KEY = 'photomaster_custom_presets_v1';

interface StoredLutPayload {
  size: number;
  domainMin: [number, number, number];
  domainMax: [number, number, number];
  title?: string;
  tableU16Base64: string;
}

interface StoredPresetRecord {
  id: string;
  name: string;
  isCustom?: boolean;
  sourceFormat?: Preset['sourceFormat'];
  importSummary?: string;
  createdAt?: string;
  adjustments: Omit<Preset['adjustments'], 'lut'> & {
    lut?: StoredLutPayload | null;
  };
}

function encodeLutToBase64(lut: Lut3DData): StoredLutPayload {
  const u16 = new Uint16Array(lut.table.length);
  for (let i = 0; i < lut.table.length; i++) {
    const v = Math.max(0, Math.min(1, lut.table[i]));
    u16[i] = Math.round(v * 65535);
  }
  const bytes = new Uint8Array(u16.buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return {
    size: lut.size,
    domainMin: lut.domainMin,
    domainMax: lut.domainMax,
    title: lut.title,
    tableU16Base64: btoa(binary),
  };
}

function decodeLutFromBase64(payload: StoredLutPayload): Lut3DData | null {
  try {
    const binary = atob(payload.tableU16Base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const u16 = new Uint16Array(bytes.buffer);
    const expectedLen = payload.size * payload.size * payload.size * 3;
    if (u16.length !== expectedLen) return null;

    const table = new Float32Array(u16.length);
    for (let i = 0; i < u16.length; i++) {
      table[i] = u16[i] / 65535;
    }
    return {
      size: payload.size,
      domainMin: payload.domainMin,
      domainMax: payload.domainMax,
      title: payload.title,
      table,
    };
  } catch {
    return null;
  }
}

export function loadStoredPresets(): Preset[] {
  try {
    const raw = localStorage.getItem(CUSTOM_PRESETS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((item): item is StoredPresetRecord => Boolean(item && item.id && item.name && item.adjustments))
      .map((item) => {
        const { lut, ...restAdj } = item.adjustments;
        const decodedLut = lut ? decodeLutFromBase64(lut) : null;
        return {
          id: item.id,
          name: item.name,
          isCustom: true,
          sourceFormat: item.sourceFormat || 'custom',
          importSummary: item.importSummary,
          createdAt: item.createdAt,
          adjustments: {
            ...restAdj,
            lut: decodedLut,
          },
        };
      });
  } catch {
    return [];
  }
}

export function saveStoredPresets(presets: Preset[]): { ok: boolean; error?: string } {
  try {
    const serialized: StoredPresetRecord[] = presets.map((preset) => {
      const { lut, ...restAdj } = preset.adjustments;
      return {
        id: preset.id,
        name: preset.name,
        isCustom: true,
        sourceFormat: preset.sourceFormat,
        importSummary: preset.importSummary,
        createdAt: preset.createdAt,
        adjustments: {
          ...restAdj,
          lut: lut ? encodeLutToBase64(lut) : null,
        },
      };
    });
    localStorage.setItem(CUSTOM_PRESETS_KEY, JSON.stringify(serialized));
    return { ok: true };
  } catch {
    return {
      ok: false,
      error: 'Browser storage limit reached. Try removing unused LUT presets before saving more.',
    };
  }
}
