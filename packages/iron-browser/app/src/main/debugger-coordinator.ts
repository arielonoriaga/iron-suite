export interface DebuggerLike {
  isAttached(): boolean;
  attach(protocolVersion?: string): void;
  detach(): void;
  sendCommand(method: string, commandParams?: Record<string, unknown>): Promise<unknown>;
  on(event: 'detach', listener: (event: unknown, reason: string) => void): unknown;
  on(event: 'message', listener: (event: unknown, method: string, params: unknown) => void): unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  off?(event: 'detach' | 'message', listener: (...args: any[]) => void): unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  removeListener?(event: 'detach' | 'message', listener: (...args: any[]) => void): unknown;
}

export interface DebuggerTarget {
  readonly id: number;
  isDestroyed(): boolean;
  once(event: 'destroyed', listener: () => void): unknown;
  readonly debugger: DebuggerLike;
}

export interface DebuggerParticipantHooks {
  onDetach?: (reason: string) => void;
  onReattach?: () => Promise<void> | void;
  onMessage?: (method: string, params: unknown) => void;
  onDestroyed?: () => void;
}

interface WcEntry {
  wc: DebuggerTarget;
  participants: Map<string, DebuggerParticipantHooks>;
  needsRestore: boolean;
  detachEpoch: number;
  disposing: boolean;
  reattachInFlight: Promise<boolean> | null;
  onDetachListener: (_event: unknown, reason: string) => void;
  onMessageListener: (_event: unknown, method: string, params: unknown) => void;
  onDestroyedListener: () => void;
}

export class DebuggerCoordinator {
  private readonly entries = new Map<number, WcEntry>();
  private readonly attachLocks = new Map<number, Promise<boolean>>();

  private getOrCreateEntry(wc: DebuggerTarget): WcEntry {
    const existing = this.entries.get(wc.id);
    if (existing) {
      return existing;
    }

    const entry: WcEntry = {
      wc,
      participants: new Map(),
      needsRestore: false,
      detachEpoch: 0,
      disposing: false,
      reattachInFlight: null,
      onDetachListener: (_event, reason) => {
        if (entry.disposing) return;
        entry.detachEpoch += 1;
        entry.needsRestore = true;
        const snapshot = Array.from(entry.participants.values());
        for (const p of snapshot) {
          try {
            p.onDetach?.(reason);
          } catch {
            // Isolate participant failures so all participants are notified.
          }
        }
      },
      onMessageListener: (_event, method, params) => {
        const snapshot = Array.from(entry.participants.values());
        for (const p of snapshot) {
          try {
            p.onMessage?.(method, params);
          } catch {
            // Isolate participant failures so telemetry/dedup/mux stay healthy.
          }
        }
      },
      onDestroyedListener: () => {
        this.cleanupEntry(wc.id, true);
      },
    };

    wc.debugger.on('detach', entry.onDetachListener);
    wc.debugger.on('message', entry.onMessageListener);
    wc.once('destroyed', entry.onDestroyedListener);
    this.entries.set(wc.id, entry);
    return entry;
  }

  private removeDebuggerListeners(entry: WcEntry): void {
    try {
      const dbg = entry.wc.debugger;
      if (typeof dbg.off === 'function') {
        dbg.off('detach', entry.onDetachListener);
        dbg.off('message', entry.onMessageListener);
      } else if (typeof dbg.removeListener === 'function') {
        dbg.removeListener('detach', entry.onDetachListener);
        dbg.removeListener('message', entry.onMessageListener);
      }
    } catch {
      // Ignore cleanup errors on already-destroyed WebContents.
    }
  }

  private cleanupEntry(wcId: number, notifyDestroyed: boolean): void {
    const entry = this.entries.get(wcId);
    this.entries.delete(wcId);
    this.attachLocks.delete(wcId);
    if (!entry) return;

    this.removeDebuggerListeners(entry);
    if (notifyDestroyed) {
      const snapshot = Array.from(entry.participants.values());
      for (const p of snapshot) {
        try {
          p.onDestroyed?.();
        } catch {
          // Ignore participant cleanup errors.
        }
      }
    }
    entry.participants.clear();
  }

  isAttached(wc: DebuggerTarget | null | undefined): boolean {
    if (!wc || wc.isDestroyed()) return false;
    try {
      return wc.debugger.isAttached();
    } catch {
      return false;
    }
  }

  async ensureAttached(wc: DebuggerTarget): Promise<boolean> {
    if (wc.isDestroyed()) return false;
    this.getOrCreateEntry(wc);

    const existingLock = this.attachLocks.get(wc.id);
    if (existingLock) {
      return existingLock;
    }

    const lock = (async (): Promise<boolean> => {
      if (wc.isDestroyed()) return false;
      try {
        if (!wc.debugger.isAttached()) {
          wc.debugger.attach('1.3');
        }
      } catch {
        // Ignore attach errors (e.g., internal chrome:// pages or concurrent attach).
      }
      return !wc.isDestroyed() && this.isAttached(wc);
    })();

    this.attachLocks.set(wc.id, lock);
    try {
      return await lock;
    } finally {
      if (this.attachLocks.get(wc.id) === lock) {
        this.attachLocks.delete(wc.id);
      }
    }
  }

  registerParticipant(
    wc: DebuggerTarget,
    id: string,
    hooks: DebuggerParticipantHooks,
  ): () => void {
    if (wc.isDestroyed()) {
      return () => {};
    }
    const entry = this.getOrCreateEntry(wc);
    entry.participants.set(id, hooks);
    return () => {
      const cur = this.entries.get(wc.id);
      cur?.participants.delete(id);
    };
  }

  async sendCommand<T = unknown>(
    wc: DebuggerTarget,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T> {
    if (wc.isDestroyed()) {
      throw new Error(`Cannot send CDP command ${method}: WebContents destroyed`);
    }

    const attached = await this.ensureAttached(wc);
    if (!attached) {
      throw new Error(`Cannot send CDP command ${method}: debugger not attached`);
    }

    const isElectronRuntime = Boolean(
      typeof process !== 'undefined' && process.versions && process.versions.electron,
    );
    let result: T;
    try {
      result = (await wc.debugger.sendCommand(method, params)) as T;
    } catch (err) {
      if (isElectronRuntime) {
        // Yield out of Electron's C++ WebContentsDebugger::DispatchProtocolMessage V8 MicrotasksScope
        // before any caller issues a follow-up sendCommand/detach that could mutate pending_requests_.
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      const entry = this.entries.get(wc.id);
      if (entry && !wc.isDestroyed() && !this.isAttached(wc)) {
        entry.detachEpoch += 1;
        entry.needsRestore = true;
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`CDP command ${method} failed: ${msg}`);
    }
    if (isElectronRuntime) {
      // Break synchronous Promise microtask re-entrancy into WebContentsDebugger::pending_requests_.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return result;
  }

  async reattachAndRestore(
    wc: DebuggerTarget,
    opts?: { force?: boolean },
  ): Promise<boolean> {
    if (wc.isDestroyed()) return false;
    const entry = this.getOrCreateEntry(wc);
    if (entry.reattachInFlight) {
      return entry.reattachInFlight;
    }

    const run = (async (): Promise<boolean> => {
      const wasAttached = this.isAttached(wc);
      const shouldRestore = Boolean(opts?.force) || !wasAttached || entry.needsRestore;
      const attached = await this.ensureAttached(wc);
      if (!attached) return false;

      if (shouldRestore) {
        const epochBeforeRestore = entry.detachEpoch;
        const snapshot = Array.from(entry.participants.values());
        await Promise.allSettled(
          snapshot.map((p) => Promise.resolve(p.onReattach?.())),
        );
        if (
          entry.detachEpoch === epochBeforeRestore &&
          !wc.isDestroyed() &&
          wc.debugger.isAttached()
        ) {
          entry.needsRestore = false;
        }
      }
      return !wc.isDestroyed() && this.isAttached(wc);
    })();

    entry.reattachInFlight = run;
    try {
      return await run;
    } finally {
      if (entry.reattachInFlight === run) {
        entry.reattachInFlight = null;
      }
    }
  }

  detach(wc: DebuggerTarget | null | undefined): void {
    if (!wc) return;
    const entry = this.entries.get(wc.id);
    if (entry) {
      entry.disposing = true;
    }
    try {
      if (!wc.isDestroyed() && wc.debugger.isAttached()) {
        wc.debugger.detach();
      }
    } catch {
      // Ignore detach errors during teardown.
    }
    this.cleanupEntry(wc.id, false);
  }
}
