import type { DebuggerCoordinator, DebuggerTarget } from './debugger-coordinator';
import {
  buildWebGlInspectorInitScript,
  type WebGlFrameCapturePayload,
} from '../shared/webgl-inspector-core';
import type { RenderingOrderLayer, WebGlViewportSummary } from '../shared/types';

export type WebGlInspectAction =
  | 'snapshot'
  | 'capture_frame'
  | 'rendering_order'
  | 'reset_counters';

export interface WebGlInspectOptions {
  action?: WebGlInspectAction;
  maxCalls?: number;
  maxLayers?: number;
  timeoutMs?: number;
}

export interface WebGlViewportInspection {
  action: WebGlInspectAction;
  summary: WebGlViewportSummary;
  renderingOrder?: RenderingOrderLayer[];
  capture?: Omit<WebGlFrameCapturePayload, 'summary' | 'renderingOrder'>;
}

interface TrackedWebGlWc {
  wc: DebuggerTarget & { executeJavaScript?: (code: string, userGesture?: boolean) => Promise<unknown> };
  scriptIdentifier: string | null;
  installing: boolean;
  detachEpoch: number;
  unregister: () => void;
}

export class WebGlInspectorManager {
  private readonly tracked = new Map<number, TrackedWebGlWc>();
  private readonly initScript = buildWebGlInspectorInitScript();
  private disposed = false;

  constructor(private readonly coordinator: DebuggerCoordinator) {}

  async syncViewport(
    wc: DebuggerTarget & { executeJavaScript?: (code: string, userGesture?: boolean) => Promise<unknown> },
  ): Promise<void> {
    if (this.disposed || wc.isDestroyed()) return;
    let entry = this.tracked.get(wc.id);
    if (!entry) {
      const unregister = this.coordinator.registerParticipant(wc, `webgl-inspector:${wc.id}`, {
        onDetach: () => {
          const cur = this.tracked.get(wc.id);
          if (cur) {
            cur.detachEpoch += 1;
            cur.scriptIdentifier = null;
          }
        },
        onReattach: async () => {
          const cur = this.tracked.get(wc.id);
          if (!cur || this.disposed || cur.wc.isDestroyed()) return;
          cur.detachEpoch += 1;
          cur.scriptIdentifier = null;
          await this.ensureNewDocumentScript(cur);
        },
      });
      entry = { wc, scriptIdentifier: null, installing: false, detachEpoch: 0, unregister };
      this.tracked.set(wc.id, entry);
    }
    await this.ensureNewDocumentScript(entry);
  }

  private async ensureNewDocumentScript(entry: TrackedWebGlWc): Promise<void> {
    if (this.disposed || entry.wc.isDestroyed() || entry.scriptIdentifier || entry.installing) {
      return;
    }
    const startEpoch = entry.detachEpoch;
    entry.installing = true;
    try {
      const attached = await this.coordinator.ensureAttached(entry.wc);
      if (!attached || this.disposed || entry.wc.isDestroyed() || entry.detachEpoch !== startEpoch) {
        return;
      }
      await this.coordinator.sendCommand(entry.wc, 'Page.enable').catch(() => {});
      const res = (await this.coordinator.sendCommand(
        entry.wc,
        'Page.addScriptToEvaluateOnNewDocument',
        { source: this.initScript },
      )) as { identifier?: string } | undefined;
      if (
        !this.disposed &&
        !entry.wc.isDestroyed() &&
        entry.detachEpoch === startEpoch &&
        res?.identifier
      ) {
        entry.scriptIdentifier = res.identifier;
      }
    } catch {
      // Ignore transient navigation/teardown debugger errors.
    } finally {
      entry.installing = false;
    }
  }

  private async evalWithTimeout<T>(
    wc: DebuggerTarget & { executeJavaScript?: (code: string, userGesture?: boolean) => Promise<unknown> },
    expr: string,
    timeoutMs: number,
  ): Promise<T | null> {
    if (this.disposed || wc.isDestroyed() || typeof wc.executeJavaScript !== 'function') {
      return null;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const res = await Promise.race([
        wc.executeJavaScript(expr, false) as Promise<T>,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), timeoutMs);
          timer.unref?.();
        }),
      ]);
      return res;
    } catch {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async getViewportSummary(
    wc: DebuggerTarget & { executeJavaScript?: (code: string, userGesture?: boolean) => Promise<unknown> },
  ): Promise<WebGlViewportSummary | null> {
    const fast = await this.evalWithTimeout<WebGlViewportSummary>(
      wc,
      'window.__ironWebGlInspector ? window.__ironWebGlInspector.getSummary() : null',
      300,
    );
    if (fast && typeof fast.contexts === 'number') return fast;
    const code = `(() => {
      ${this.initScript}
      const api = window.__ironWebGlInspector;
      return api ? api.getSummary() : null;
    })()`;
    const summary = await this.evalWithTimeout<WebGlViewportSummary>(wc, code, 450);
    if (!summary || typeof summary.contexts !== 'number') return null;
    return summary;
  }

  async inspectViewport(
    wc: DebuggerTarget & { executeJavaScript?: (code: string, userGesture?: boolean) => Promise<unknown> },
    options: WebGlInspectOptions = {},
  ): Promise<WebGlViewportInspection | null> {
    const action: WebGlInspectAction = options.action ?? 'snapshot';
    const maxCalls = Math.max(1, Math.min(2048, Math.trunc(options.maxCalls ?? 256)));
    const maxLayers = Math.max(8, Math.min(200, Math.trunc(options.maxLayers ?? 64)));
    const timeoutMs = Math.max(100, Math.min(3000, Math.trunc(options.timeoutMs ?? 700)));

    await this.syncViewport(wc);

    if (action === 'capture_frame') {
      const code = `(async () => {
        ${this.initScript}
        const api = window.__ironWebGlInspector;
        if (!api) return null;
        return await api.captureFrame(${maxCalls}, ${timeoutMs}, ${maxLayers});
      })()`;
      const payload = await this.evalWithTimeout<WebGlFrameCapturePayload>(
        wc,
        code,
        timeoutMs + 600,
      );
      if (!payload) return null;
      return {
        action,
        summary: payload.summary,
        renderingOrder: payload.renderingOrder,
        capture: {
          capturedFrames: payload.capturedFrames,
          elapsedMs: payload.elapsedMs,
          passes: payload.passes,
          drawCalls: payload.drawCalls,
          truncated: payload.truncated,
        },
      };
    }

    if (action === 'reset_counters') {
      const code = `(() => {
        ${this.initScript}
        const api = window.__ironWebGlInspector;
        return api ? { summary: api.resetCounters() } : null;
      })()`;
      const res = await this.evalWithTimeout<{ summary: WebGlViewportSummary }>(wc, code, 600);
      if (!res) return null;
      return { action, summary: res.summary };
    }

    const code = `(() => {
      ${this.initScript}
      const api = window.__ironWebGlInspector;
      if (!api) return null;
      return {
        summary: api.getSummary(),
        renderingOrder: api.inspectRenderingOrder(${maxLayers})
      };
    })()`;
    const snap = await this.evalWithTimeout<{
      summary: WebGlViewportSummary;
      renderingOrder: RenderingOrderLayer[];
    }>(wc, code, 800);
    if (!snap) return null;
    return {
      action,
      summary: snap.summary,
      renderingOrder: snap.renderingOrder,
    };
  }

  disposeWebContents(wcId: number): void {
    const entry = this.tracked.get(wcId);
    if (!entry) return;
    this.tracked.delete(wcId);
    entry.unregister();
  }

  dispose(): void {
    this.disposed = true;
    for (const wcId of Array.from(this.tracked.keys())) {
      this.disposeWebContents(wcId);
    }
  }
}
