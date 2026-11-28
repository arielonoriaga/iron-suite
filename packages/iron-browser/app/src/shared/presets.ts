import type { DevicePreset } from './types';

export const DEVICE_PRESETS: readonly DevicePreset[] = [
  {
    id: 'iphone-15',
    label: 'iPhone 15 (390×844)',
    width: 390,
    height: 844,
    dpr: 3,
    touch: true,
    category: 'portrait',
  },
  {
    id: 'iphone-se',
    label: 'iPhone SE (375×667)',
    width: 375,
    height: 667,
    dpr: 2,
    touch: true,
    category: 'portrait',
  },
  {
    id: 'sunmi-v2-pro',
    label: 'Sunmi V2 Pro (360×720)',
    width: 360,
    height: 720,
    dpr: 2,
    touch: true,
    category: 'portrait',
  },
  {
    id: 'iphone-15-pro-max',
    label: 'Pro Max (430×932)',
    width: 430,
    height: 932,
    dpr: 3,
    touch: true,
    category: 'portrait',
  },
  {
    id: 'tablet-portrait',
    label: 'Tablet (768×1024)',
    width: 768,
    height: 1024,
    dpr: 2,
    touch: true,
    category: 'portrait',
  },
  {
    id: 'desktop-hd',
    label: 'HD (1280×720)',
    width: 1280,
    height: 720,
    dpr: 1,
    touch: false,
    category: 'landscape',
  },
  {
    id: 'desktop-1440',
    label: 'Desktop (1440×900)',
    width: 1440,
    height: 900,
    dpr: 1,
    touch: false,
    category: 'landscape',
  },
];

export const DEFAULT_PORTRAIT_PRESET_ID = 'iphone-15';
export const DEFAULT_LANDSCAPE_PRESET_ID = 'desktop-hd';

export function findPreset(id: string): DevicePreset | undefined {
  return DEVICE_PRESETS.find((preset) => preset.id === id);
}

export function getPresetOrDefault(id: string, fallbackId: string): DevicePreset {
  return (
    findPreset(id) ??
    findPreset(fallbackId) ??
    DEVICE_PRESETS[0]!
  );
}
