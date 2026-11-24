export type PerformanceTier = 'low' | 'standard' | 'high';

export interface DevicePerformanceProfile {
  tier: PerformanceTier;
  isMobileOrAndroid: boolean;
  deviceMemoryGb: number;
  cores: number;
  retouchMaxDim: number;
  maskMaxDim: number;
  maskAlphaCacheLimit: number;
  maskOverlayMaxDim: number;
  maxHistoryEntries: number;
}

function detectDeviceCapabilities(): DevicePerformanceProfile {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return {
      tier: 'high',
      isMobileOrAndroid: false,
      deviceMemoryGb: 8,
      cores: 8,
      retouchMaxDim: 2048,
      maskMaxDim: 1024,
      maskAlphaCacheLimit: 8,
      maskOverlayMaxDim: 480,
      maxHistoryEntries: 45,
    };
  }

  const nav = navigator as unknown as {
    deviceMemory?: number;
    hardwareConcurrency?: number;
    userAgent?: string;
  };

  const ua = nav.userAgent ?? '';
  const isAndroidOrTouch =
    /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua) ||
    window.innerWidth < 1024;
  const deviceMemoryGb =
    typeof nav.deviceMemory === 'number' && nav.deviceMemory > 0
      ? nav.deviceMemory
      : isAndroidOrTouch
        ? 4
        : 8;
  const cores =
    typeof nav.hardwareConcurrency === 'number' && nav.hardwareConcurrency > 0
      ? nav.hardwareConcurrency
      : isAndroidOrTouch
        ? 4
        : 8;

  let tier: PerformanceTier = 'standard';
  if (deviceMemoryGb <= 3 || cores <= 2 || (isAndroidOrTouch && deviceMemoryGb <= 4)) {
    tier = 'low';
  } else if (!isAndroidOrTouch && deviceMemoryGb >= 8 && cores >= 6) {
    tier = 'high';
  }

  const retouchMaxDim = tier === 'low' || isAndroidOrTouch ? 1536 : 2048;
  const maskMaxDim = tier === 'low' ? 768 : isAndroidOrTouch ? 832 : 1024;
  const maskAlphaCacheLimit = tier === 'low' ? 4 : isAndroidOrTouch ? 6 : 8;
  const maskOverlayMaxDim = tier === 'low' ? 360 : isAndroidOrTouch ? 400 : 480;
  const maxHistoryEntries = tier === 'low' ? 28 : isAndroidOrTouch ? 35 : 45;

  return {
    tier,
    isMobileOrAndroid: isAndroidOrTouch,
    deviceMemoryGb,
    cores,
    retouchMaxDim,
    maskMaxDim,
    maskAlphaCacheLimit,
    maskOverlayMaxDim,
    maxHistoryEntries,
  };
}

let cachedProfile: DevicePerformanceProfile | null = null;
let cachedViewportMobile: boolean | null = null;

export function getDevicePerformanceProfile(): DevicePerformanceProfile {
  const isNarrow = typeof window !== 'undefined' ? window.innerWidth < 1024 : false;
  if (!cachedProfile || cachedViewportMobile !== isNarrow) {
    cachedViewportMobile = isNarrow;
    cachedProfile = detectDeviceCapabilities();
  }
  return cachedProfile;
}

/**
 * Selects sharp resting preview resolution matched to device viewport + capability,
 * and uses fast interactive downscale during active slider dragging when heavy spatial
 * kernels or masks are engaged so preview stays fluid without altering committed pixels.
 */
export function getOptimalPreviewMaxDim(
  isDesktop: boolean,
  isInteractiveScrubbing = false,
  hasHeavySpatialOrMasks = false
): number {
  const profile = getDevicePerformanceProfile();
  const dpr =
    typeof window !== 'undefined'
      ? Math.min(2, Math.max(1, window.devicePixelRatio || 1))
      : 1;

  if (isInteractiveScrubbing) {
    if (!isDesktop || profile.tier === 'low') {
      return hasHeavySpatialOrMasks ? 480 : 580;
    }
    return hasHeavySpatialOrMasks ? 680 : 880;
  }

  if (isDesktop) {
    return profile.tier === 'low' ? 1120 : 1360;
  }

  // Mobile / Android portrait/landscape workspace: fit display container * capped DPR
  const viewportLong =
    typeof window !== 'undefined'
      ? Math.max(window.innerWidth, Math.round(window.innerHeight * 0.62))
      : 540;
  const desired = Math.round(viewportLong * Math.min(dpr, 1.75));
  const ceiling = profile.tier === 'low' ? 768 : 960;
  return Math.max(540, Math.min(ceiling, desired));
}
