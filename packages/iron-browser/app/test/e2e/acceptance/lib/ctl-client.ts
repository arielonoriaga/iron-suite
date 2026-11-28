import {
  ControlSocketClient as BaseControlSocketClient,
  CtlFrameDecoder,
  CtlRpcError,
  MAX_FRAME_BYTES,
  encodeCtlFrame,
} from '../../lib/ctl-client';
import type {
  TabSnapshotDto,
  TabsResultDto,
  ViewportRole,
} from './types';

export { CtlFrameDecoder, CtlRpcError, MAX_FRAME_BYTES, encodeCtlFrame };

export interface CloseTabResultDto {
  activeTabId: string | null;
  tabs: TabSnapshotDto[];
  closedTabId?: string;
}

export interface SelectTabResultDto {
  activeTabId: string | null;
  tab?: TabSnapshotDto | null;
  tabs?: TabSnapshotDto[];
}

export interface ReloadResultDto {
  ok?: boolean;
  tabId?: string;
  tab?: TabSnapshotDto | null;
}

export interface NavigateHistoryResultDto {
  ok?: boolean;
  direction?: 'back' | 'forward';
  tabId?: string;
  url?: string;
  canGoBack?: boolean;
  canGoForward?: boolean;
  tab?: TabSnapshotDto | null;
}

export interface WaitForResultDto {
  ok: boolean;
  tabId?: string;
  viewport?: ViewportRole;
  matched?: boolean;
  elapsedMs?: number;
  text?: string;
}

export interface StorageResultDto {
  ok: boolean;
  tabId?: string;
  viewport?: ViewportRole;
  scope?: 'cookies' | 'localStorage' | 'sessionStorage' | 'all';
  action?: 'get' | 'set' | 'remove' | 'clear';
  cookies?: Array<Record<string, unknown>>;
  localStorage?: Record<string, string>;
  sessionStorage?: Record<string, string>;
  value?: unknown;
}

/**
 * Acceptance control socket client extending the proven E2E ControlSocketClient
 * with M2 RPC helpers routed via `this.request(...)` so strict typechecking passes
 * before M2 lands in `ctl-socket.ts`.
 */
export class AcceptanceControlClient extends BaseControlSocketClient {
  static override async connect(
    socketPath: string,
    timeoutMs?: number,
  ): Promise<AcceptanceControlClient> {
    const client = new AcceptanceControlClient(socketPath);
    await client.connect(timeoutMs);
    return client;
  }

  closeTab(tabId: string): Promise<CloseTabResultDto> {
    return this.request<CloseTabResultDto>('browser_close_tab', { tab_id: tabId });
  }

  selectTab(tabId: string): Promise<SelectTabResultDto> {
    return this.request<SelectTabResultDto>('browser_select_tab', { tab_id: tabId });
  }

  reloadTab(opts?: { tabId?: string; ignoreCache?: boolean }): Promise<ReloadResultDto> {
    const params: Record<string, unknown> = {};
    if (opts?.tabId !== undefined) params.tab_id = opts.tabId;
    if (opts?.ignoreCache !== undefined) params.ignore_cache = opts.ignoreCache;
    return this.request<ReloadResultDto>('browser_reload', params);
  }

  navigateHistory(
    direction: 'back' | 'forward',
    tabId?: string,
  ): Promise<NavigateHistoryResultDto> {
    const params: Record<string, unknown> = { direction };
    if (tabId !== undefined) params.tab_id = tabId;
    return this.request<NavigateHistoryResultDto>('browser_navigate_history', params);
  }

  waitFor(opts: {
    tabId?: string;
    viewport?: ViewportRole;
    selector?: string;
    text?: string;
    urlIncludes?: string;
    networkIdleMs?: number;
    timeoutMs?: number;
  }): Promise<WaitForResultDto> {
    const params: Record<string, unknown> = {};
    if (opts.tabId !== undefined) params.tab_id = opts.tabId;
    if (opts.viewport !== undefined) params.viewport = opts.viewport;
    if (opts.selector !== undefined) params.selector = opts.selector;
    if (opts.text !== undefined) params.text = opts.text;
    if (opts.urlIncludes !== undefined) params.url_includes = opts.urlIncludes;
    if (opts.networkIdleMs !== undefined) params.network_idle_ms = opts.networkIdleMs;
    if (opts.timeoutMs !== undefined) params.timeout_ms = opts.timeoutMs;
    return this.request<WaitForResultDto>('browser_wait_for', params, (opts.timeoutMs ?? 10_000) + 5_000);
  }

  storage(opts: {
    action: 'get' | 'set' | 'remove' | 'clear';
    scope?: 'cookies' | 'localStorage' | 'sessionStorage' | 'all';
    tabId?: string;
    viewport?: ViewportRole;
    key?: string;
    value?: string;
    url?: string;
    name?: string;
  }): Promise<StorageResultDto> {
    const params: Record<string, unknown> = { action: opts.action };
    if (opts.scope !== undefined) params.scope = opts.scope;
    if (opts.tabId !== undefined) params.tab_id = opts.tabId;
    if (opts.viewport !== undefined) params.viewport = opts.viewport;
    if (opts.key !== undefined) params.key = opts.key;
    if (opts.value !== undefined) params.value = opts.value;
    if (opts.url !== undefined) params.url = opts.url;
    if (opts.name !== undefined) params.name = opts.name;
    return this.request<StorageResultDto>('browser_storage', params);
  }

  webgl(opts?: {
    tabId?: string;
    viewport?: ViewportRole | 'both';
    action?: 'snapshot' | 'capture_frame' | 'rendering_order' | 'reset_counters';
    maxCalls?: number;
    maxLayers?: number;
    timeoutMs?: number;
  }): Promise<Record<string, unknown>> {
    const params: Record<string, unknown> = { action: opts?.action ?? 'snapshot' };
    if (opts?.tabId !== undefined) params.tab_id = opts.tabId;
    if (opts?.viewport !== undefined) params.viewport = opts.viewport;
    if (opts?.maxCalls !== undefined) params.max_calls = opts.maxCalls;
    if (opts?.maxLayers !== undefined) params.max_layers = opts.maxLayers;
    if (opts?.timeoutMs !== undefined) params.timeout_ms = opts.timeoutMs;
    return this.request<Record<string, unknown>>('browser_webgl', params);
  }

  incidents(opts?: {
    tabId?: string;
    viewport?: ViewportRole | 'both';
    limit?: number;
    windowMs?: number;
  }): Promise<{ tabId?: string; count: number; incidents: Array<Record<string, unknown>> }> {
    const params: Record<string, unknown> = {};
    if (opts?.tabId !== undefined) params.tab_id = opts.tabId;
    if (opts?.viewport !== undefined) params.viewport = opts.viewport;
    if (opts?.limit !== undefined) params.limit = opts.limit;
    if (opts?.windowMs !== undefined) params.window_ms = opts.windowMs;
    return this.request('browser_incidents', params);
  }

  heap(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('browser_heap', params, 30_000);
  }

  traceStart(params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('browser_trace_start', params);
  }

  traceStop(params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('browser_trace_stop', params);
  }

  repro(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('browser_repro', params);
  }

  filmstrip(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('browser_filmstrip', params, 30_000);
  }

  async getAllTabsSnapshot(): Promise<TabsResultDto> {
    return this.tabs();
  }
}
