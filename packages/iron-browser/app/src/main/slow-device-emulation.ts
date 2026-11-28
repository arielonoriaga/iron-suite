import os from 'node:os';
import type {
  CalibrationResult,
  EmulationProfileId,
  NetworkConditionPreset,
  NetworkEmulationConfig,
  TabEmulationSummary,
  ViewportEmulationState,
  ViewportRole,
} from '../shared/types';
import { findPreset } from '../shared/presets';
import type { DebuggerCoordinator, DebuggerTarget } from './debugger-coordinator';

export interface EmulateTargetWebContents extends DebuggerTarget {
  executeJavaScript?(code: string, userGesture?: boolean): Promise<unknown>;
  getUserAgent?(): string;
  session?: {
    getUserAgent?: () => string;
  };
}

export interface CustomNetworkInput {
  offline?: boolean;
  latency?: number;
  latency_ms?: number;
  latencyMs?: number;
  down?: number;
  down_kbps?: number;
  download_kbps?: number;
  download_bytes_per_sec?: number;
  downloadBytesPerSec?: number;
  up?: number;
  up_kbps?: number;
  upload_kbps?: number;
  upload_bytes_per_sec?: number;
  uploadBytesPerSec?: number;
}

export interface EmulateViewportInput {
  profile?: 'none' | 'sunmi-v2-pro' | 'low-end-android';
  cpuRate?: number;
  network?: NetworkConditionPreset | CustomNetworkInput;
  preset?: string;
  userAgent?: string | null;
  hardwareConcurrency?: number | null;
  deviceMemory?: number | null;
  reducedMotion?: boolean;
  saveData?: boolean;
  targetScore?: number;
  calibrate?: boolean;
  reset?: boolean;
}

export const SUNMI_V2_PRO_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 7.1.2; V2_PRO Build/N2G47H; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/87.0.4280.141 Mobile Safari/537.36';

export const LOW_END_ANDROID_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Mobile Safari/537.36';

export const HOST_HARDWARE_CONCURRENCY: number = Math.max(
  1,
  typeof os.availableParallelism === 'function'
    ? os.availableParallelism()
    : (os.cpus()?.length ?? 4),
);

export const NETWORK_PRESETS: Readonly<Record<NetworkConditionPreset, NetworkEmulationConfig>> = {
  none: {
    preset: 'none',
    offline: false,
    latencyMs: 0,
    downloadBytesPerSec: -1,
    uploadBytesPerSec: -1,
  },
  'fast-4g': {
    preset: 'fast-4g',
    offline: false,
    latencyMs: 60,
    downloadBytesPerSec: 500_000, // 4 Mbps
    uploadBytesPerSec: 375_000, // 3 Mbps
  },
  'slow-4g': {
    preset: 'slow-4g',
    offline: false,
    latencyMs: 150,
    downloadBytesPerSec: 200_000, // 1.6 Mbps
    uploadBytesPerSec: 93_750, // 750 kbps
  },
  '3g': {
    preset: '3g',
    offline: false,
    latencyMs: 300,
    downloadBytesPerSec: 93_750, // 750 kbps
    uploadBytesPerSec: 46_875, // 375 kbps
  },
  offline: {
    preset: 'offline',
    offline: true,
    latencyMs: 0,
    downloadBytesPerSec: 0,
    uploadBytesPerSec: 0,
  },
};

export interface ProfileTemplate {
  id: 'none' | 'sunmi-v2-pro' | 'low-end-android';
  label: string;
  cpuRate: number;
  networkPreset: NetworkConditionPreset;
  presetId: string | null;
  userAgent: string | null;
  hardwareConcurrency: number | null;
  deviceMemory: number | null;
  targetScore: number | null;
}

export const EMULATION_PROFILES: Readonly<
  Record<'none' | 'sunmi-v2-pro' | 'low-end-android', ProfileTemplate>
> = {
  none: {
    id: 'none',
    label: 'None',
    cpuRate: 1,
    networkPreset: 'none',
    presetId: null,
    userAgent: null,
    hardwareConcurrency: null,
    deviceMemory: null,
    targetScore: null,
  },
  'sunmi-v2-pro': {
    id: 'sunmi-v2-pro',
    label: 'Sunmi V2 Pro',
    cpuRate: 6,
    networkPreset: 'slow-4g',
    presetId: 'sunmi-v2-pro',
    userAgent: SUNMI_V2_PRO_USER_AGENT,
    hardwareConcurrency: 4,
    deviceMemory: 2,
    // Default JS benchmark throughput target (ops/ms) representing quad-core Cortex-A53 ~1.3GHz WebView (~6x below desktop V8).
    targetScore: 95_000,
  },
  'low-end-android': {
    id: 'low-end-android',
    label: 'Low-End Android',
    cpuRate: 4,
    networkPreset: 'fast-4g',
    presetId: null,
    userAgent: LOW_END_ANDROID_USER_AGENT,
    hardwareConcurrency: 4,
    deviceMemory: 2,
    targetScore: 145_000,
  },
};

export function createDefaultViewportEmulationState(): ViewportEmulationState {
  return {
    active: false,
    profile: 'none',
    cpuRate: 1,
    network: { ...NETWORK_PRESETS.none },
    presetId: null,
    userAgent: null,
    hardwareConcurrency: null,
    deviceMemory: null,
    reducedMotion: false,
    saveData: false,
    targetScore: null,
    lastCalibration: null,
  };
}

export function clampCpuRate(raw: number): number {
  if (!Number.isFinite(raw)) {
    throw new Error('cpu_rate must be a finite number between 1 and 20');
  }
  if (raw < 1 || raw > 20) {
    throw new Error(`cpu_rate must be between 1 and 20 (got ${raw})`);
  }
  return Math.round(raw * 100) / 100;
}

export function resolveNetworkEmulationInput(
  input: NetworkConditionPreset | CustomNetworkInput,
): NetworkEmulationConfig {
  if (typeof input === 'string') {
    const preset = NETWORK_PRESETS[input as NetworkConditionPreset];
    if (!preset) {
      throw new Error(
        `unknown network preset '${input}': expected none|fast-4g|slow-4g|3g|offline`,
      );
    }
    return { ...preset };
  }

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('network must be a preset name or an object with latency/down/up');
  }

  const offline = Boolean(input.offline);
  const rawLatency = input.latency_ms ?? input.latencyMs ?? input.latency ?? 0;
  if (typeof rawLatency !== 'number' || !Number.isFinite(rawLatency) || rawLatency < 0 || rawLatency > 60_000) {
    throw new Error('network latency must be a finite number between 0 and 60000 ms');
  }

  const parseThroughput = (
    bytesDirect: number | undefined,
    kbpsVal: number | undefined,
    label: string,
  ): number => {
    if (bytesDirect !== undefined) {
      if (typeof bytesDirect !== 'number' || !Number.isFinite(bytesDirect) || bytesDirect < -1) {
        throw new Error(`${label} bytes/sec must be -1 or >= 0`);
      }
      return bytesDirect === -1 ? -1 : Math.round(bytesDirect);
    }
    if (kbpsVal !== undefined) {
      if (typeof kbpsVal !== 'number' || !Number.isFinite(kbpsVal) || kbpsVal < -1) {
        throw new Error(`${label} kbps must be -1 or >= 0`);
      }
      return kbpsVal === -1 ? -1 : Math.round((kbpsVal * 1000) / 8);
    }
    return -1;
  };

  const downloadBytesPerSec = offline
    ? 0
    : parseThroughput(
        input.download_bytes_per_sec ?? input.downloadBytesPerSec,
        input.download_kbps ?? input.down_kbps ?? input.down,
        'download',
      );
  const uploadBytesPerSec = offline
    ? 0
    : parseThroughput(
        input.upload_bytes_per_sec ?? input.uploadBytesPerSec,
        input.upload_kbps ?? input.up_kbps ?? input.up,
        'upload',
      );

  return {
    preset: 'custom',
    offline,
    latencyMs: offline ? 0 : Math.round(rawLatency),
    downloadBytesPerSec,
    uploadBytesPerSec,
  };
}

export function isEmulationStateActive(state: ViewportEmulationState): boolean {
  return (
    state.cpuRate > 1 ||
    state.network.offline ||
    state.network.latencyMs > 0 ||
    state.network.downloadBytesPerSec >= 0 ||
    state.network.uploadBytesPerSec >= 0 ||
    state.userAgent !== null ||
    state.hardwareConcurrency !== null ||
    state.deviceMemory !== null ||
    state.reducedMotion ||
    state.saveData ||
    state.presetId !== null
  );
}

/**
 * Builds an idempotent script that installs or restores `navigator.deviceMemory` and
 * `navigator.connection.saveData` while stashing the host's native property descriptors
 * once so `reset: true` / `profile: "none"` restores exact host values immediately.
 */
export function buildIdentityOverrideScript(
  deviceMemory: number | null,
  saveData: boolean,
): string {
  const memJson = deviceMemory === null ? 'null' : String(deviceMemory);
  const saveJson = saveData ? 'true' : 'false';
  return `(() => {
    try {
      const memVal = ${memJson};
      const saveVal = ${saveJson};
      const memSym = Symbol.for('__ironOrigDeviceMemoryDesc');
      if (typeof Navigator !== 'undefined' && Navigator.prototype) {
        if (!Object.prototype.hasOwnProperty.call(Navigator.prototype, memSym)) {
          const orig = Object.getOwnPropertyDescriptor(Navigator.prototype, 'deviceMemory') || null;
          Object.defineProperty(Navigator.prototype, memSym, {
            value: orig,
            configurable: true,
            enumerable: false,
            writable: false,
          });
        }
        const stashed = Navigator.prototype[memSym];
        if (memVal !== null) {
          Object.defineProperty(Navigator.prototype, 'deviceMemory', {
            get: () => memVal,
            configurable: true,
            enumerable: true,
          });
        } else if (stashed) {
          Object.defineProperty(Navigator.prototype, 'deviceMemory', stashed);
        } else {
          try { delete Navigator.prototype.deviceMemory; } catch {}
        }
      }
      const conn = typeof navigator !== 'undefined' ? navigator.connection : null;
      const connProto = conn ? Object.getPrototypeOf(conn) : null;
      const saveSym = Symbol.for('__ironOrigSaveDataDesc');
      if (connProto) {
        if (!Object.prototype.hasOwnProperty.call(connProto, saveSym)) {
          const origSave = Object.getOwnPropertyDescriptor(connProto, 'saveData') || null;
          Object.defineProperty(connProto, saveSym, {
            value: origSave,
            configurable: true,
            enumerable: false,
            writable: false,
          });
        }
        const stashedSave = connProto[saveSym];
        if (saveVal) {
          Object.defineProperty(connProto, 'saveData', {
            get: () => true,
            configurable: true,
            enumerable: true,
          });
        } else if (stashedSave) {
          Object.defineProperty(connProto, 'saveData', stashedSave);
        }
      }
    } catch {}
  })();`;
}

/**
 * Fixed-budget (~65ms wall-clock) deterministic JS CPU micro-benchmark.
 * Measures sustained integer + typed-array throughput in ops/ms so calibration always
 * completes in ~150ms total regardless of host speed or throttling rate (1x..20x).
 */
export function buildCalibrationBenchmarkScript(windowMs = 65): string {
  const safeWindowMs = Math.min(Math.max(Math.round(windowMs), 20), 250);
  return `(() => {
    const runBatch = (seed) => {
      let x = (seed | 0) || 0x1234567;
      const arr = new Int32Array(64);
      for (let i = 0; i < 2000; i += 1) {
        x = (Math.imul(x ^ (x >>> 13), 0x5bd1e995) + i) | 0;
        arr[i & 63] = (arr[(i + 7) & 63] + x) | 0;
      }
      return (x ^ arr[19]) | 0;
    };
    let sink = 1;
    for (let w = 0; w < 5; w += 1) {
      sink ^= runBatch(w + 1);
    }
    const t0 = performance.now();
    let batches = 0;
    while (performance.now() - t0 < ${safeWindowMs} || batches < 3) {
      sink ^= runBatch(batches + 1);
      batches += 1;
    }
    const elapsedMs = Math.max(0.1, performance.now() - t0);
    const opsPerMs = (batches * 2000) / elapsedMs;
    return {
      score: Math.max(1, Math.round(opsPerMs)),
      elapsedMs: Math.round(elapsedMs * 100) / 100,
      batches,
      sink,
    };
  })()`;
}

export function formatTabEmulationLabel(
  portrait: ViewportEmulationState,
  landscape: ViewportEmulationState,
): string {
  const primary = portrait.active ? portrait : landscape;
  if (!primary.active) return 'None';
  const name =
    primary.profile === 'sunmi-v2-pro'
      ? 'Sunmi V2 Pro'
      : primary.profile === 'low-end-android'
        ? 'Low-End Android'
        : 'Custom';
  const parts = [name];
  if (primary.cpuRate > 1) {
    parts.push(`${primary.cpuRate}× CPU`);
  }
  if (primary.network.preset !== 'none') {
    parts.push(primary.network.preset === 'custom' ? `${primary.network.latencyMs}ms net` : primary.network.preset);
  }
  return parts.join(' · ');
}

interface AppliedWcTracking {
  scriptId: string | null;
  hadOverrides: boolean;
  hostUserAgent: string;
  unsubParticipant: (() => void) | null;
}

export class SlowDeviceEmulationManager {
  private readonly tabStates = new Map<
    string,
    {
      portrait: ViewportEmulationState;
      landscape: ViewportEmulationState;
      savedPortraitPresetId: string | null;
      savedLandscapePresetId: string | null;
    }
  >();
  private readonly wcTracking = new Map<number, AppliedWcTracking>();
  private readonly now: () => number;

  constructor(
    private readonly debuggerCoordinator: DebuggerCoordinator,
    opts: { now?: () => number } = {},
  ) {
    this.now = opts.now ?? (() => Date.now());
  }

  private getOrCreateTabEntry(tabId: string) {
    let entry = this.tabStates.get(tabId);
    if (!entry) {
      entry = {
        portrait: createDefaultViewportEmulationState(),
        landscape: createDefaultViewportEmulationState(),
        savedPortraitPresetId: null,
        savedLandscapePresetId: null,
      };
      this.tabStates.set(tabId, entry);
    }
    return entry;
  }

  getViewportState(tabId: string, role: ViewportRole): ViewportEmulationState {
    const entry = this.tabStates.get(tabId);
    if (!entry) return createDefaultViewportEmulationState();
    const s = entry[role];
    return {
      ...s,
      network: { ...s.network },
      lastCalibration: s.lastCalibration ? { ...s.lastCalibration } : null,
    };
  }

  isViewportActive(tabId: string, role: ViewportRole): boolean {
    return this.tabStates.get(tabId)?.[role].active ?? false;
  }

  getTabSummary(tabId: string): TabEmulationSummary {
    const portrait = this.getViewportState(tabId, 'portrait');
    const landscape = this.getViewportState(tabId, 'landscape');
    const active = portrait.active || landscape.active;
    let profile: EmulationProfileId = 'none';
    if (active) {
      if (portrait.active && landscape.active && portrait.profile === landscape.profile) {
        profile = portrait.profile;
      } else if (portrait.active) {
        profile = portrait.profile;
      } else {
        profile = landscape.profile;
      }
    }
    return {
      active,
      profile,
      label: formatTabEmulationLabel(portrait, landscape),
      portrait,
      landscape,
    };
  }

  rememberPresetBeforeOverride(tabId: string, role: ViewportRole, currentPresetId: string): void {
    const entry = this.getOrCreateTabEntry(tabId);
    if (role === 'portrait' && entry.savedPortraitPresetId === null) {
      entry.savedPortraitPresetId = currentPresetId;
    } else if (role === 'landscape' && entry.savedLandscapePresetId === null) {
      entry.savedLandscapePresetId = currentPresetId;
    }
  }

  consumeSavedPresetOnReset(tabId: string, role: ViewportRole): string | null {
    const entry = this.tabStates.get(tabId);
    if (!entry) return null;
    if (role === 'portrait') {
      const saved = entry.savedPortraitPresetId;
      entry.savedPortraitPresetId = null;
      return saved;
    }
    const saved = entry.savedLandscapePresetId;
    entry.savedLandscapePresetId = null;
    return saved;
  }

  handleManualPresetChange(tabId: string, role: ViewportRole, presetId: string): void {
    const entry = this.tabStates.get(tabId);
    if (!entry) return;
    if (role === 'portrait') {
      entry.savedPortraitPresetId = null;
    } else {
      entry.savedLandscapePresetId = null;
    }
    if (entry[role].presetId !== null) {
      entry[role].presetId = presetId;
      entry[role].active = isEmulationStateActive(entry[role]);
    }
  }

  clearRolePresetOverride(tabId: string, role: ViewportRole): void {
    this.setRolePresetOverride(tabId, role, null);
  }

  setRolePresetOverride(tabId: string, role: ViewportRole, presetId: string | null): void {
    const entry = this.tabStates.get(tabId);
    if (!entry) return;
    if (entry[role].presetId !== presetId) {
      entry[role].presetId = presetId;
      entry[role].active = isEmulationStateActive(entry[role]);
    }
  }

  updateViewportConfig(
    tabId: string,
    role: ViewportRole,
    input: EmulateViewportInput,
    applyProfilePresetToRole: boolean,
  ): ViewportEmulationState {
    const entry = this.getOrCreateTabEntry(tabId);
    let next: ViewportEmulationState = {
      ...entry[role],
      network: { ...entry[role].network },
      lastCalibration: entry[role].lastCalibration ? { ...entry[role].lastCalibration } : null,
    };

    if (input.reset === true || input.profile === 'none') {
      next = createDefaultViewportEmulationState();
      entry[role] = next;
      return this.getViewportState(tabId, role);
    }

    let explicitCustomField = false;

    if (input.profile === 'sunmi-v2-pro' || input.profile === 'low-end-android') {
      const tpl = EMULATION_PROFILES[input.profile];
      next = {
        active: true,
        profile: tpl.id,
        cpuRate: tpl.cpuRate,
        network: { ...NETWORK_PRESETS[tpl.networkPreset] },
        presetId: applyProfilePresetToRole ? tpl.presetId : null,
        userAgent: tpl.userAgent,
        hardwareConcurrency: tpl.hardwareConcurrency,
        deviceMemory: tpl.deviceMemory,
        reducedMotion: false,
        saveData: false,
        targetScore: tpl.targetScore,
        lastCalibration: null,
      };
    }

    if (input.cpuRate !== undefined) {
      next.cpuRate = clampCpuRate(input.cpuRate);
      if (!input.profile) explicitCustomField = true;
    }

    if (input.network !== undefined) {
      next.network = resolveNetworkEmulationInput(input.network);
      if (!input.profile) explicitCustomField = true;
    }

    if (input.preset !== undefined) {
      const trimmed = input.preset.trim();
      if (trimmed === '' || trimmed === 'none') {
        next.presetId = null;
      } else {
        const found = findPreset(trimmed);
        if (!found) {
          throw new Error(`unknown device preset '${trimmed}'`);
        }
        next.presetId = found.id;
      }
      if (!input.profile) explicitCustomField = true;
    }

    if (input.userAgent !== undefined) {
      next.userAgent =
        input.userAgent === null || input.userAgent.trim() === ''
          ? null
          : input.userAgent.slice(0, 512);
      if (!input.profile) explicitCustomField = true;
    }

    if (input.hardwareConcurrency !== undefined) {
      if (input.hardwareConcurrency === null || input.hardwareConcurrency === 0) {
        next.hardwareConcurrency = null;
      } else {
        if (
          typeof input.hardwareConcurrency !== 'number' ||
          !Number.isFinite(input.hardwareConcurrency) ||
          input.hardwareConcurrency < 1 ||
          input.hardwareConcurrency > 128
        ) {
          throw new Error('hardware_concurrency must be an integer between 1 and 128');
        }
        next.hardwareConcurrency = Math.round(input.hardwareConcurrency);
      }
      if (!input.profile) explicitCustomField = true;
    }

    if (input.deviceMemory !== undefined) {
      if (input.deviceMemory === null || input.deviceMemory === 0) {
        next.deviceMemory = null;
      } else {
        if (
          typeof input.deviceMemory !== 'number' ||
          !Number.isFinite(input.deviceMemory) ||
          input.deviceMemory < 0.25 ||
          input.deviceMemory > 64
        ) {
          throw new Error('device_memory must be a number between 0.25 and 64 (GB)');
        }
        next.deviceMemory = Math.round(input.deviceMemory * 100) / 100;
      }
      if (!input.profile) explicitCustomField = true;
    }

    if (input.reducedMotion !== undefined) {
      next.reducedMotion = Boolean(input.reducedMotion);
      if (!input.profile) explicitCustomField = true;
    }

    if (input.saveData !== undefined) {
      next.saveData = Boolean(input.saveData);
      if (!input.profile) explicitCustomField = true;
    }

    if (input.targetScore !== undefined) {
      if (
        typeof input.targetScore !== 'number' ||
        !Number.isFinite(input.targetScore) ||
        input.targetScore <= 0
      ) {
        throw new Error('target_score must be a positive finite number');
      }
      next.targetScore = Math.round(input.targetScore);
    }

    next.active = isEmulationStateActive(next);
    if (!next.active) {
      next.profile = 'none';
    } else if (explicitCustomField && next.profile === 'none') {
      next.profile = 'custom';
    }

    entry[role] = next;
    return this.getViewportState(tabId, role);
  }

  private ensureWcTracking(
    tabId: string,
    role: ViewportRole,
    wc: EmulateTargetWebContents,
  ): AppliedWcTracking {
    let tracked = this.wcTracking.get(wc.id);
    if (!tracked) {
      const hostUa =
        (typeof wc.session?.getUserAgent === 'function' ? wc.session.getUserAgent() : '') ||
        (typeof wc.getUserAgent === 'function' ? wc.getUserAgent() : '');
      tracked = {
        scriptId: null,
        hadOverrides: false,
        hostUserAgent: hostUa,
        unsubParticipant: null,
      };
      tracked.unsubParticipant = this.debuggerCoordinator.registerParticipant(
        wc,
        `slow-device-emulation:${tabId}:${role}`,
        {
          onDetach: () => {
            const cur = this.wcTracking.get(wc.id);
            if (cur) cur.scriptId = null;
          },
          onReattach: async () => {
            if (!wc.isDestroyed() && this.isViewportActive(tabId, role)) {
              await this.syncViewport(tabId, role, wc);
            }
          },
          onDestroyed: () => {
            this.wcTracking.delete(wc.id);
          },
        },
      );
      this.wcTracking.set(wc.id, tracked);
    }
    return tracked;
  }

  async syncViewport(
    tabId: string,
    role: ViewportRole,
    wc: EmulateTargetWebContents | null | undefined,
  ): Promise<void> {
    if (!wc || wc.isDestroyed()) return;
    const state = this.getViewportState(tabId, role);
    const existing = this.wcTracking.get(wc.id);
    if (!state.active && !existing?.hadOverrides) {
      return;
    }

    const tracked = this.ensureWcTracking(tabId, role, wc);
    const attached = await this.debuggerCoordinator.ensureAttached(wc);
    if (!attached || wc.isDestroyed()) return;

    await Promise.all([
      this.debuggerCoordinator
        .sendCommand(wc, 'Network.enable', {
          maxTotalBufferSize: 1,
          maxResourceBufferSize: 1,
          maxPostDataSize: 1,
        })
        .catch(() => {}),
      this.debuggerCoordinator.sendCommand(wc, 'Page.enable').catch(() => {}),
    ]);
    if (wc.isDestroyed()) return;

    // 1. CPU throttling (1 = unthrottled)
    await this.debuggerCoordinator
      .sendCommand(wc, 'Emulation.setCPUThrottlingRate', { rate: state.cpuRate })
      .catch(() => {});

    // 2. Network conditions + Save-Data request header
    await this.debuggerCoordinator
      .sendCommand(wc, 'Network.emulateNetworkConditions', {
        offline: state.network.offline,
        latency: state.network.latencyMs,
        downloadThroughput: state.network.downloadBytesPerSec,
        uploadThroughput: state.network.uploadBytesPerSec,
      })
      .catch(() => {});

    await this.debuggerCoordinator
      .sendCommand(wc, 'Network.setExtraHTTPHeaders', {
        headers: state.saveData ? { 'Save-Data': 'on' } : {},
      })
      .catch(() => {});

    // 3. User-Agent override (empty string clears override in Chromium CDP; fallback to hostUserAgent)
    await this.debuggerCoordinator
      .sendCommand(wc, 'Network.setUserAgentOverride', {
        userAgent: state.userAgent ?? '',
        ...(state.userAgent && state.userAgent.includes('Android')
          ? { platform: 'Linux armv8l' }
          : {}),
      })
      .catch(() => {});

    // 4. Hardware concurrency override (CDP requires >= 1; restore host core count on reset)
    if (state.hardwareConcurrency !== null) {
      await this.debuggerCoordinator
        .sendCommand(wc, 'Emulation.setHardwareConcurrencyOverride', {
          hardwareConcurrency: state.hardwareConcurrency,
        })
        .catch(() => {});
    } else if (tracked.hadOverrides) {
      await this.debuggerCoordinator
        .sendCommand(wc, 'Emulation.setHardwareConcurrencyOverride', {
          hardwareConcurrency: HOST_HARDWARE_CONCURRENCY,
        })
        .catch(() => {});
    }

    // 5. Media feature prefers-reduced-motion
    await this.debuggerCoordinator
      .sendCommand(wc, 'Emulation.setEmulatedMedia', {
        features: [
          {
            name: 'prefers-reduced-motion',
            value: state.reducedMotion ? 'reduce' : '',
          },
        ],
      })
      .catch(() => {});

    // 6. navigator.deviceMemory + navigator.connection.saveData (NewDocument + live document)
    if (tracked.scriptId !== null) {
      const oldId = tracked.scriptId;
      tracked.scriptId = null;
      await this.debuggerCoordinator
        .sendCommand(wc, 'Page.removeScriptToEvaluateOnNewDocument', { identifier: oldId })
        .catch(() => {});
    }

    const identityScript = buildIdentityOverrideScript(state.deviceMemory, state.saveData);
    if (state.deviceMemory !== null || state.saveData) {
      const res = await this.debuggerCoordinator
        .sendCommand<{ identifier?: string }>(wc, 'Page.addScriptToEvaluateOnNewDocument', {
          source: identityScript,
        })
        .catch(() => null);
      if (res && typeof res.identifier === 'string') {
        tracked.scriptId = res.identifier;
      }
    }

    if (!wc.isDestroyed() && typeof wc.executeJavaScript === 'function') {
      await wc.executeJavaScript(identityScript, false).catch(() => {});
    }

    tracked.hadOverrides = state.active;
  }

  async calibrateViewport(
    tabId: string,
    role: ViewportRole,
    wc: EmulateTargetWebContents,
    overrideTargetScore?: number,
  ): Promise<CalibrationResult> {
    if (wc.isDestroyed()) {
      throw new Error(`cannot calibrate destroyed '${role}' viewport`);
    }
    if (typeof wc.executeJavaScript !== 'function') {
      throw new Error(`viewport '${role}' does not support executeJavaScript`);
    }

    const entry = this.getOrCreateTabEntry(tabId);
    const curState = entry[role];
    const targetScore = Math.max(
      1,
      Math.round(
        overrideTargetScore ??
          curState.targetScore ??
          EMULATION_PROFILES['sunmi-v2-pro'].targetScore ??
          18_000,
      ),
    );

    const tracked = this.ensureWcTracking(tabId, role, wc);
    const attached = await this.debuggerCoordinator.ensureAttached(wc);
    if (!attached || wc.isDestroyed()) {
      throw new Error(`cannot attach CDP debugger to '${role}' viewport for calibration`);
    }

    const prevCpuRate = curState.cpuRate;

    // Measure host unthrottled score at rate = 1 (restoring prevCpuRate if executeJavaScript throws)
    await this.debuggerCoordinator.sendCommand(wc, 'Emulation.setCPUThrottlingRate', { rate: 1 });
    let hostRun: { score?: number } | null = null;
    try {
      hostRun = (await wc.executeJavaScript(buildCalibrationBenchmarkScript(65), false)) as {
        score?: number;
      } | null;
    } catch (err) {
      if (!wc.isDestroyed() && prevCpuRate > 1) {
        await this.debuggerCoordinator
          .sendCommand(wc, 'Emulation.setCPUThrottlingRate', { rate: prevCpuRate })
          .catch(() => {});
      }
      throw err;
    }
    const hostScore = Math.max(1, Math.round(Number(hostRun?.score ?? targetScore)));

    const chosenRate = Math.min(20, Math.max(1, Math.round(hostScore / targetScore)));
    await this.debuggerCoordinator.sendCommand(wc, 'Emulation.setCPUThrottlingRate', {
      rate: chosenRate,
    });

    curState.cpuRate = chosenRate;
    curState.targetScore = targetScore;
    curState.active = isEmulationStateActive(curState);
    if (curState.active && curState.profile === 'none') {
      curState.profile = 'custom';
    }
    tracked.hadOverrides = tracked.hadOverrides || curState.active;

    const throttledRun = (await wc.executeJavaScript(
      buildCalibrationBenchmarkScript(75),
      false,
    )) as { score?: number } | null;
    const resultingScore = Math.max(1, Math.round(Number(throttledRun?.score ?? targetScore)));

    const calibration: CalibrationResult = {
      hostScore,
      targetScore,
      chosenRate,
      resultingScore,
      measuredAtMs: this.now(),
    };

    curState.lastCalibration = calibration;

    return calibration;
  }

  disposeWebContents(wcId: number): void {
    const tracked = this.wcTracking.get(wcId);
    if (!tracked) return;
    this.wcTracking.delete(wcId);
    tracked.unsubParticipant?.();
  }

  clearTab(tabId: string): void {
    this.tabStates.delete(tabId);
  }

  dispose(): void {
    for (const tracked of this.wcTracking.values()) {
      tracked.unsubParticipant?.();
    }
    this.wcTracking.clear();
    this.tabStates.clear();
  }
}
