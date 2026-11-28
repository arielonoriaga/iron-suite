import type {
  HistoryEntry,
  Rect,
  SessionMode,
  ThemeMode,
  ViewMode,
  ViewportRole,
} from './types';
import { normalizeUrl } from './url';
import {
  DEFAULT_LANDSCAPE_PRESET_ID,
  DEFAULT_PORTRAIT_PRESET_ID,
  DEVICE_PRESETS,
} from './presets';
import {
  clamp,
  MAX_SPLIT_RATIO,
  MIN_AGENT_FLOAT_HEIGHT,
  MIN_AGENT_FLOAT_WIDTH,
  MIN_DOCK_HEIGHT,
  MIN_SPLIT_RATIO,
} from './layout';

export const MAX_PERSISTED_TABS = 24;
export const MAX_HISTORY_ENTRIES = 30;
export const MAX_PERSISTED_URL_LENGTH = 4096;
export const MAX_PERSISTED_TITLE_LENGTH = 120;

const PLACEHOLDER_TITLES = new Set(['IronBrowser', 'IronBrowser — Ready']);

export interface PersistedWindowBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized?: boolean;
}

export interface PersistedTab {
  url: string;
  title: string;
  mode: ViewMode;
  mirror: boolean;
  dedup?: boolean;
  session: SessionMode;
  sleeping: boolean;
  portraitPresetId: string;
  landscapePresetId: string;
  devtoolsTarget: ViewportRole;
  audioSource: ViewportRole | 'muted';
}

export interface PersistedSession {
  version: 1;
  savedAt: number;
  window?: PersistedWindowBounds;
  railCollapsed: boolean;
  dockOpen: boolean;
  dockHeight: number;
  splitRatio: number;
  theme: ThemeMode;
  ecoMode?: boolean;
  autoSleep?: boolean;
  agentFloatBounds?: Rect;
  activeTabIndex: number;
  tabs: PersistedTab[];
  history: HistoryEntry[];
}

const VALID_PRESET_IDS = new Set(DEVICE_PRESETS.map((p) => p.id));

export function isPersistableHttpUrl(raw: string): boolean {
  if (!raw || typeof raw !== 'string') return false;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_PERSISTED_URL_LENGTH) return false;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    if (parsed.username !== '' || parsed.password !== '') return false;
    if (parsed.href.length > MAX_PERSISTED_URL_LENGTH) return false;
    return true;
  } catch {
    return false;
  }
}

export function formatHistorySubtitle(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    const hostPort = u.host;
    const pathAndQuery = `${u.pathname === '/' && !u.search && !u.hash ? '' : u.pathname}${u.search}${u.hash}`;
    const combined = `${hostPort}${pathAndQuery}`;
    return combined.length > 64 ? `${combined.slice(0, 63)}…` : combined;
  } catch {
    return rawUrl.slice(0, 64);
  }
}

export function isPlaceholderTitle(
  title: string | undefined,
  url?: string,
  rawUrl?: string,
): boolean {
  const trimmed = (title ?? '').trim();
  if (!trimmed) return true;
  if (PLACEHOLDER_TITLES.has(trimmed)) return true;
  if (url !== undefined && trimmed === url.trim()) return true;
  if (rawUrl !== undefined && trimmed === rawUrl.trim()) return true;
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const normalizedTitle = normalizeUrl(trimmed);
      if (url !== undefined) {
        if (normalizedTitle === url.trim()) return true;
        if (/^https?:\/\//i.test(url.trim())) {
          try {
            if (normalizedTitle === normalizeUrl(url)) return true;
          } catch {
            // Ignore unparseable url comparison.
          }
        }
      }
      if (rawUrl !== undefined && /^https?:\/\//i.test(rawUrl.trim())) {
        try {
          if (normalizedTitle === normalizeUrl(rawUrl)) return true;
        } catch {
          // Ignore unparseable rawUrl comparison.
        }
      }
    } catch {
      // Ignore non-URL titles starting with http(s)://.
    }
  }
  return false;
}

export function truncatePersistedTitle(title: string | undefined, fallback = 'IronBrowser'): string {
  const trimmed = (title ?? '').trim();
  if (!trimmed) return fallback.slice(0, MAX_PERSISTED_TITLE_LENGTH);
  return trimmed.slice(0, MAX_PERSISTED_TITLE_LENGTH);
}

function cleanTitle(title: string | undefined, url: string, rawUrl?: string): string {
  if (isPlaceholderTitle(title, url, rawUrl)) {
    return formatHistorySubtitle(url);
  }
  return (title ?? '').trim().slice(0, MAX_PERSISTED_TITLE_LENGTH);
}

export function recordHistoryEntry(
  history: readonly HistoryEntry[],
  rawUrl: string,
  title?: string,
  nowMs = Date.now(),
  maxItems = MAX_HISTORY_ENTRIES,
): HistoryEntry[] {
  if (!isPersistableHttpUrl(rawUrl)) {
    return [...history];
  }
  let url: string;
  try {
    url = normalizeUrl(rawUrl);
  } catch {
    return [...history];
  }
  if (!isPersistableHttpUrl(url)) {
    return [...history];
  }

  const existing = history.find((item) => item.url === url);
  const isDuplicateRecent =
    history[0]?.url === url && Math.abs(nowMs - history[0].visitedAt) < 5000;
  const nextTitle = !isPlaceholderTitle(title, url, rawUrl)
    ? cleanTitle(title, url, rawUrl)
    : existing && !isPlaceholderTitle(existing.title, url, rawUrl)
      ? existing.title.slice(0, MAX_PERSISTED_TITLE_LENGTH)
      : formatHistorySubtitle(url);

  const entry: HistoryEntry = {
    url,
    title: nextTitle,
    visitedAt: nowMs,
    visitCount: isDuplicateRecent ? existing?.visitCount ?? 1 : (existing?.visitCount ?? 0) + 1,
  };

  const filtered = history.filter((item) => item.url !== url);
  return [entry, ...filtered].slice(0, Math.max(1, maxItems));
}

export function updateHistoryTitle(
  history: readonly HistoryEntry[],
  rawUrl: string,
  title: string,
): HistoryEntry[] {
  const trimmed = title.trim();
  if (isPlaceholderTitle(trimmed, undefined, rawUrl) || !isPersistableHttpUrl(rawUrl)) {
    return [...history];
  }
  let url: string;
  try {
    url = normalizeUrl(rawUrl);
  } catch {
    return [...history];
  }
  if (!isPersistableHttpUrl(url) || isPlaceholderTitle(trimmed, url, rawUrl)) {
    return [...history];
  }

  let changed = false;
  const next = history.map((item) => {
    if (item.url !== url) return item;
    const cleaned = cleanTitle(trimmed, url, rawUrl);
    if (item.title === cleaned) return item;
    changed = true;
    return { ...item, title: cleaned };
  });
  return changed ? next : [...history];
}

export function removeHistoryEntry(
  history: readonly HistoryEntry[],
  url: string,
): HistoryEntry[] {
  return history.filter((item) => item.url !== url);
}

function asEnumOrDefault<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return typeof value === 'string' && allowed.includes(value as T) ? (value as T) : fallback;
}

function sanitizeWindowBounds(raw: unknown): PersistedWindowBounds | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  if (
    typeof obj.width !== 'number' ||
    !Number.isFinite(obj.width) ||
    typeof obj.height !== 'number' ||
    !Number.isFinite(obj.height)
  ) {
    return undefined;
  }
  const width = Math.round(clamp(obj.width, 760, 7680));
  const height = Math.round(clamp(obj.height, 520, 4320));
  const bounds: PersistedWindowBounds = { width, height };
  if (typeof obj.x === 'number' && Number.isFinite(obj.x)) {
    bounds.x = Math.round(obj.x);
  }
  if (typeof obj.y === 'number' && Number.isFinite(obj.y)) {
    bounds.y = Math.round(obj.y);
  }
  if (typeof obj.maximized === 'boolean') {
    bounds.maximized = obj.maximized;
  }
  return bounds;
}

function sanitizeTab(raw: unknown): PersistedTab | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.url !== 'string' || !isPersistableHttpUrl(obj.url)) return null;

  let url: string;
  try {
    url = normalizeUrl(obj.url);
  } catch {
    return null;
  }
  if (!isPersistableHttpUrl(url)) return null;

  const portraitPresetId =
    typeof obj.portraitPresetId === 'string' && VALID_PRESET_IDS.has(obj.portraitPresetId)
      ? obj.portraitPresetId
      : DEFAULT_PORTRAIT_PRESET_ID;
  const landscapePresetId =
    typeof obj.landscapePresetId === 'string' && VALID_PRESET_IDS.has(obj.landscapePresetId)
      ? obj.landscapePresetId
      : DEFAULT_LANDSCAPE_PRESET_ID;

  const mode = asEnumOrDefault<ViewMode>(obj.mode, ['single', 'dual'], 'dual');
  const rawAudioSource = asEnumOrDefault<ViewportRole | 'muted'>(
    obj.audioSource,
    ['portrait', 'landscape', 'muted'],
    'landscape',
  );
  return {
    url,
    title: cleanTitle(typeof obj.title === 'string' ? obj.title : undefined, url),
    mode,
    mirror: typeof obj.mirror === 'boolean' ? obj.mirror : true,
    dedup: typeof obj.dedup === 'boolean' ? obj.dedup : true,
    session: asEnumOrDefault<SessionMode>(obj.session, ['shared', 'isolated'], 'shared'),
    sleeping: typeof obj.sleeping === 'boolean' ? obj.sleeping : false,
    portraitPresetId,
    landscapePresetId,
    devtoolsTarget:
      mode === 'single'
        ? 'landscape'
        : asEnumOrDefault<ViewportRole>(obj.devtoolsTarget, ['portrait', 'landscape'], 'portrait'),
    audioSource: mode === 'single' && rawAudioSource === 'portrait' ? 'landscape' : rawAudioSource,
  };
}

function sanitizeHistoryEntry(raw: unknown): HistoryEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.url !== 'string' || !isPersistableHttpUrl(obj.url)) return null;
  let url: string;
  try {
    url = normalizeUrl(obj.url);
  } catch {
    return null;
  }
  if (!isPersistableHttpUrl(url)) return null;

  const visitedAt =
    typeof obj.visitedAt === 'number' && Number.isFinite(obj.visitedAt) && obj.visitedAt > 0
      ? Math.floor(obj.visitedAt)
      : Date.now();
  const visitCount =
    typeof obj.visitCount === 'number' && Number.isFinite(obj.visitCount) && obj.visitCount >= 1
      ? Math.floor(obj.visitCount)
      : 1;

  return {
    url,
    title: cleanTitle(typeof obj.title === 'string' ? obj.title : undefined, url),
    visitedAt,
    visitCount,
  };
}

export function capPersistedTabs(
  tabs: readonly PersistedTab[],
  activeTabIndex: number,
  maxTabs = MAX_PERSISTED_TABS,
): { tabs: PersistedTab[]; activeTabIndex: number } {
  if (tabs.length === 0) {
    return { tabs: [], activeTabIndex: 0 };
  }
  const safeMaxTabs = Number.isFinite(maxTabs) ? Math.floor(maxTabs) : MAX_PERSISTED_TABS;
  const limit = Math.max(1, safeMaxTabs);
  const normalizedActive = Number.isFinite(activeTabIndex) ? Math.floor(activeTabIndex) : 0;
  const safeActive = clamp(normalizedActive, 0, tabs.length - 1);
  if (tabs.length <= limit) {
    return { tabs: [...tabs], activeTabIndex: safeActive };
  }
  if (safeActive < limit) {
    return { tabs: tabs.slice(0, limit), activeTabIndex: safeActive };
  }
  return {
    tabs: [...tabs.slice(0, limit - 1), tabs[safeActive]!],
    activeTabIndex: limit - 1,
  };
}

export function sanitizePersistedSession(raw: unknown): PersistedSession | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (obj.version !== 1) return null;

  const rawTabs = Array.isArray(obj.tabs) ? obj.tabs : [];
  const tabs: PersistedTab[] = [];
  for (const item of rawTabs) {
    const clean = sanitizeTab(item);
    if (clean) {
      tabs.push(clean);
      if (tabs.length >= MAX_PERSISTED_TABS) break;
    }
  }

  const rawHistory = Array.isArray(obj.history) ? obj.history : [];
  const seenUrls = new Set<string>();
  const history: HistoryEntry[] = [];
  for (const item of rawHistory) {
    const clean = sanitizeHistoryEntry(item);
    if (clean && !seenUrls.has(clean.url)) {
      seenUrls.add(clean.url);
      history.push(clean);
      if (history.length >= MAX_HISTORY_ENTRIES) break;
    }
  }
  history.sort((a, b) => b.visitedAt - a.visitedAt);

  const dockHeight =
    typeof obj.dockHeight === 'number' && Number.isFinite(obj.dockHeight)
      ? Math.round(clamp(obj.dockHeight, MIN_DOCK_HEIGHT, 900))
      : 290;
  const splitRatio =
    typeof obj.splitRatio === 'number' && Number.isFinite(obj.splitRatio)
      ? clamp(obj.splitRatio, MIN_SPLIT_RATIO, MAX_SPLIT_RATIO)
      : 0.34;

  const rawActiveIdx =
    typeof obj.activeTabIndex === 'number' && Number.isFinite(obj.activeTabIndex)
      ? Math.floor(obj.activeTabIndex)
      : 0;
  const activeTabIndex = tabs.length > 0 ? clamp(rawActiveIdx, 0, tabs.length - 1) : 0;

  const rawFloat = obj.agentFloatBounds;
  let agentFloatBounds: Rect | undefined;
  if (rawFloat && typeof rawFloat === 'object' && !Array.isArray(rawFloat)) {
    const f = rawFloat as Record<string, unknown>;
    if (
      typeof f.x === 'number' &&
      Number.isFinite(f.x) &&
      typeof f.y === 'number' &&
      Number.isFinite(f.y) &&
      typeof f.width === 'number' &&
      Number.isFinite(f.width) &&
      typeof f.height === 'number' &&
      Number.isFinite(f.height)
    ) {
      agentFloatBounds = {
        x: Math.round(clamp(f.x, 0, 8192)),
        y: Math.round(clamp(f.y, 0, 8192)),
        width: Math.round(clamp(f.width, MIN_AGENT_FLOAT_WIDTH, 4096)),
        height: Math.round(clamp(f.height, MIN_AGENT_FLOAT_HEIGHT, 4096)),
      };
    }
  }

  return {
    version: 1,
    savedAt:
      typeof obj.savedAt === 'number' && Number.isFinite(obj.savedAt)
        ? Math.floor(obj.savedAt)
        : Date.now(),
    window: sanitizeWindowBounds(obj.window),
    railCollapsed: typeof obj.railCollapsed === 'boolean' ? obj.railCollapsed : false,
    dockOpen: typeof obj.dockOpen === 'boolean' ? obj.dockOpen : false,
    dockHeight,
    splitRatio,
    theme: asEnumOrDefault<ThemeMode>(obj.theme, ['dark', 'light'], 'dark'),
    ecoMode: typeof obj.ecoMode === 'boolean' ? obj.ecoMode : true,
    autoSleep: typeof obj.autoSleep === 'boolean' ? obj.autoSleep : false,
    ...(agentFloatBounds ? { agentFloatBounds } : {}),
    activeTabIndex,
    tabs,
    history,
  };
}
