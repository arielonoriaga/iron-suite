import type { ConsoleEntry, NetworkEntry, ViewportRole } from './types';

export type DiagnosticIncidentKind = 'network-failure' | 'js-exception' | 'console-error';

export interface SanitizedEndpoint {
  origin: string | null;
  sanitizedPath: string;
}

export interface DiagnosticIncident {
  id: string;
  kind: DiagnosticIncidentKind;
  tabId: string;
  method: string | null;
  origin: string | null;
  sanitizedPath: string | null;
  status: number | null;
  timestamps: {
    firstSeenMs: number;
    lastSeenMs: number;
  };
  affectedViewports: ViewportRole[];
  requests: NetworkEntry[];
  consoleEntries: ConsoleEntry[];
}

export interface IncidentGroupingOptions {
  tabId?: string;
  viewport?: ViewportRole | 'both';
  windowMs?: number;
  causalConsoleWindowMs?: number;
  limit?: number;
}

const DEFAULT_GROUP_WINDOW_MS = 15_000;
const DEFAULT_CAUSAL_CONSOLE_WINDOW_MS = 3_000;

/**
 * Strips query parameters, fragments, and embedded credentials from URLs so
 * diagnostic grouping keys never leak tokens while matching cross-pane endpoints.
 */
export function sanitizeIncidentUrl(rawUrl: string | undefined | null): SanitizedEndpoint | null {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
      return {
        origin: null,
        sanitizedPath: parsed.pathname || parsed.protocol,
      };
    }
    return {
      origin: parsed.origin,
      sanitizedPath: parsed.pathname || '/',
    };
  } catch {
    const noCreds = trimmed.replace(/^((?:[a-zA-Z][a-zA-Z0-9+.-]*:)?\/\/)[^/?#]*@/, '$1');
    const stripped = noCreds.replace(/[?#].*$/, '');
    return stripped ? { origin: null, sanitizedPath: stripped } : null;
  }
}

export function redactUrlsInText(rawText: string): string {
  if (!rawText) return '';
  return rawText.replace(/(?:https?|wss?):\/\/[^\s'")<>]+/gi, (matched) => {
    const san = sanitizeIncidentUrl(matched);
    if (!san) return matched;
    return san.origin ? `${san.origin}${san.sanitizedPath}` : san.sanitizedPath;
  });
}

export function sanitizeConsoleEntryForIncident(con: ConsoleEntry): ConsoleEntry {
  const safeConUrl = con.url ? sanitizeIncidentUrl(con.url) : null;
  const safeText = redactUrlsInText(con.text);
  return {
    ...con,
    text: safeText,
    ...(safeConUrl
      ? {
          url: safeConUrl.origin
            ? `${safeConUrl.origin}${safeConUrl.sanitizedPath}`
            : safeConUrl.sanitizedPath,
        }
      : {}),
  };
}

export function redactNetworkEntryUrl(entry: NetworkEntry): NetworkEntry {
  const san = sanitizeIncidentUrl(entry.url);
  if (!san) return entry;
  const cleanUrl = san.origin ? `${san.origin}${san.sanitizedPath}` : san.sanitizedPath;
  return {
    ...entry,
    url: cleanUrl,
  };
}

function isConsoleEntryLinkedToNetwork(
  con: ConsoleEntry,
  req: NetworkEntry,
  san: SanitizedEndpoint,
  causalWindowMs: number,
): boolean {
  if (con.source === 'exception') {
    return false;
  }
  if (con.tabId !== req.tabId || con.viewport !== req.viewport) {
    return false;
  }
  const dt = Math.abs(con.timestampMs - req.timestampMs);
  if (dt > causalWindowMs) {
    return false;
  }

  if (con.url) {
    const conSan = sanitizeIncidentUrl(con.url);
    if (
      conSan &&
      conSan.sanitizedPath === san.sanitizedPath &&
      (conSan.origin === san.origin || conSan.origin === null || san.origin === null)
    ) {
      return true;
    }
  }

  const lowerText = con.text.toLowerCase();
  const lowerPath = san.sanitizedPath.toLowerCase();
  if (lowerPath.length > 1 && lowerText.includes(lowerPath)) {
    return true;
  }

  const segments = lowerPath.split('/').filter((s) => s.length >= 4);
  const lastSeg = segments[segments.length - 1];
  if (lastSeg && lowerText.includes(lastSeg)) {
    if (req.status === null || lowerText.includes(String(req.status)) || /fail|err|http|status|unauth|forbid|not found/.test(lowerText)) {
      return true;
    }
  }

  if (
    req.status !== null &&
    lowerText.includes(String(req.status)) &&
    /failed to load resource|responded with a status|http|fetch|xhr|request failed/.test(lowerText)
  ) {
    return true;
  }

  return false;
}

function orderViewports(viewports: Set<ViewportRole>): ViewportRole[] {
  const out: ViewportRole[] = [];
  if (viewports.has('portrait')) out.push('portrait');
  if (viewports.has('landscape')) out.push('landscape');
  return out;
}

/**
 * Observational diagnostic incident grouper (strictly distinct from R2 HTTP request deduplication).
 * - Groups matching failed network requests across Portrait and Landscape (`method + sanitizedPath + status`).
 * - Attaches causally related console errors on the affected viewports while keeping raw entries expandable.
 * - Keeps JS exceptions (`source === 'exception'`) and unrelated single-pane console errors strictly distinct.
 */
export function groupDiagnosticIncidents(
  networkEntries: readonly NetworkEntry[],
  consoleEntries: readonly ConsoleEntry[],
  opts: IncidentGroupingOptions = {},
): DiagnosticIncident[] {
  const windowMs = opts.windowMs ?? DEFAULT_GROUP_WINDOW_MS;
  const causalWindowMs = opts.causalConsoleWindowMs ?? DEFAULT_CAUSAL_CONSOLE_WINDOW_MS;
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const vpFilter = opts.viewport && opts.viewport !== 'both' ? opts.viewport : null;

  const filteredNet = networkEntries.filter((n) => {
    if (opts.tabId && n.tabId !== opts.tabId) return false;
    if (!n.failed && (n.status === null || n.status < 400)) return false;
    return true;
  });

  const filteredCon = consoleEntries.filter((c) => {
    if (opts.tabId && c.tabId !== opts.tabId) return false;
    return c.level === 'error' || c.source === 'exception';
  });

  interface MutableNetGroup {
    key: string;
    tabId: string;
    method: string;
    origin: string | null;
    sanitizedPath: string;
    status: number | null;
    firstSeenMs: number;
    lastSeenMs: number;
    viewports: Set<ViewportRole>;
    requests: NetworkEntry[];
    consoleIds: Set<number>;
    consoleEntries: ConsoleEntry[];
  }

  const netGroups: MutableNetGroup[] = [];
  const netGroupsByKey = new Map<string, MutableNetGroup[]>();

  for (const req of filteredNet) {
    const san = sanitizeIncidentUrl(req.url) ?? { origin: null, sanitizedPath: req.url || '/' };
    const method = (req.method || 'GET').toUpperCase();
    const statusKey = req.status !== null ? String(req.status) : `ERR:${req.errorText ?? 'failed'}`;
    const bucketKey = `${req.tabId}|${method}|${san.origin ?? ''}|${san.sanitizedPath}|${statusKey}`;

    const candidates = netGroupsByKey.get(bucketKey) ?? [];
    let matchedGroup: MutableNetGroup | null = null;
    for (let i = candidates.length - 1; i >= 0; i -= 1) {
      const g = candidates[i]!;
      if (Math.abs(req.timestampMs - g.lastSeenMs) <= windowMs) {
        matchedGroup = g;
        break;
      }
    }

    const safeReq = redactNetworkEntryUrl(req);
    if (matchedGroup) {
      matchedGroup.firstSeenMs = Math.min(matchedGroup.firstSeenMs, req.timestampMs);
      matchedGroup.lastSeenMs = Math.max(matchedGroup.lastSeenMs, req.timestampMs);
      matchedGroup.viewports.add(req.viewport);
      matchedGroup.requests.push(safeReq);
    } else {
      const created: MutableNetGroup = {
        key: bucketKey,
        tabId: req.tabId,
        method,
        origin: san.origin,
        sanitizedPath: san.sanitizedPath,
        status: req.status,
        firstSeenMs: req.timestampMs,
        lastSeenMs: req.timestampMs,
        viewports: new Set([req.viewport]),
        requests: [safeReq],
        consoleIds: new Set(),
        consoleEntries: [],
      };
      candidates.push(created);
      netGroupsByKey.set(bucketKey, candidates);
      netGroups.push(created);
    }
  }

  const linkedConsoleIds = new Set<number>();

  for (const con of filteredCon) {
    if (con.source === 'exception') {
      continue;
    }
    let bestGroup: MutableNetGroup | null = null;
    let bestDelta = Number.POSITIVE_INFINITY;

    for (const group of netGroups) {
      if (group.tabId !== con.tabId) continue;
      const san: SanitizedEndpoint = {
        origin: group.origin,
        sanitizedPath: group.sanitizedPath,
      };
      for (const req of group.requests) {
        if (isConsoleEntryLinkedToNetwork(con, req, san, causalWindowMs)) {
          const dt = Math.abs(con.timestampMs - req.timestampMs);
          if (dt < bestDelta) {
            bestDelta = dt;
            bestGroup = group;
          }
        }
      }
    }

    if (bestGroup && !bestGroup.consoleIds.has(con.id)) {
      bestGroup.consoleIds.add(con.id);
      bestGroup.consoleEntries.push(sanitizeConsoleEntryForIncident(con));
      bestGroup.firstSeenMs = Math.min(bestGroup.firstSeenMs, con.timestampMs);
      bestGroup.lastSeenMs = Math.max(bestGroup.lastSeenMs, con.timestampMs);
      bestGroup.viewports.add(con.viewport);
      linkedConsoleIds.add(con.id);
    }
  }

  const incidents: DiagnosticIncident[] = [];
  let seq = 1;

  for (const g of netGroups) {
    const affected = orderViewports(g.viewports);
    if (vpFilter && !affected.includes(vpFilter)) continue;
    incidents.push({
      id: `inc-net-${seq++}`,
      kind: 'network-failure',
      tabId: g.tabId,
      method: g.method,
      origin: g.origin,
      sanitizedPath: g.sanitizedPath,
      status: g.status,
      timestamps: {
        firstSeenMs: g.firstSeenMs,
        lastSeenMs: g.lastSeenMs,
      },
      affectedViewports: affected,
      requests: g.requests,
      consoleEntries: g.consoleEntries,
    });
  }

  for (const con of filteredCon) {
    if (linkedConsoleIds.has(con.id)) continue;
    if (vpFilter && con.viewport !== vpFilter) continue;
    const isException =
      con.source === 'exception' ||
      /^(Uncaught |TypeError:|ReferenceError:|SyntaxError:|RangeError:|Error:)/.test(con.text);
    const san = con.url ? sanitizeIncidentUrl(con.url) : null;
    const safeCon = sanitizeConsoleEntryForIncident(con);
    incidents.push({
      id: isException ? `inc-exc-${con.id}` : `inc-con-${con.id}`,
      kind: isException ? 'js-exception' : 'console-error',
      tabId: con.tabId,
      method: null,
      origin: san?.origin ?? null,
      sanitizedPath: san?.sanitizedPath ?? null,
      status: null,
      timestamps: {
        firstSeenMs: con.timestampMs,
        lastSeenMs: con.timestampMs,
      },
      affectedViewports: [con.viewport],
      requests: [],
      consoleEntries: [safeCon],
    });
  }

  incidents.sort((a, b) => a.timestamps.firstSeenMs - b.timestamps.firstSeenMs);
  return incidents.slice(-limit);
}
