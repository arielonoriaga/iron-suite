import { contextBridge, ipcRenderer } from 'electron';
import type {
  AgentCliOption,
  AgentCliPreset,
  AgentDockMode,
  AgentDockState,
  Rect,
  RunningAgentInstance,
} from '../shared/types';

export interface IronAgentDockApi {
  getInitial(): Promise<{
    state: AgentDockState;
    transcript: string;
    instances: RunningAgentInstance[];
    defaultCwd: string;
    contextSnippet: string;
    availableClis?: AgentCliOption[];
  }>;
  listClis?: () => Promise<AgentCliOption[]>;
  listInstances(): Promise<RunningAgentInstance[]>;
  startCli(opts: {
    preset: AgentCliPreset;
    customCommand?: string;
    cwd?: string;
    cols?: number;
    rows?: number;
  }): Promise<AgentDockState>;
  attachInstance(target: string): Promise<AgentDockState>;
  stop(): Promise<AgentDockState>;
  write(data: string, submitEnter?: boolean): Promise<boolean>;
  sendSpecialKey(key: string): Promise<boolean>;
  resize(cols: number, rows: number): Promise<boolean>;
  setMode(mode: AgentDockMode): Promise<AgentDockState>;
  setFloatBounds(bounds: Partial<Rect>): Promise<AgentDockState>;
  getContext(): Promise<string>;
  clearTranscript?(): Promise<boolean>;
  copyTranscript?(): Promise<boolean>;
  exportTranscript?(): Promise<{
    ok: boolean;
    path?: string;
    canceled?: boolean;
    error?: string;
  }>;
  onState(cb: (state: AgentDockState) => void): () => void;
  onOutput(cb: (payload: { chunk: string; replace: boolean }) => void): () => void;
  onInjectContext(cb: (snippet: string) => void): () => void;
}

const api: IronAgentDockApi = {
  getInitial: () => ipcRenderer.invoke('agent:get-initial'),
  listClis: () => ipcRenderer.invoke('agent:list-clis'),
  listInstances: () => ipcRenderer.invoke('agent:list-instances'),
  startCli: (opts) => ipcRenderer.invoke('agent:start-cli', opts),
  attachInstance: (target) => ipcRenderer.invoke('agent:attach-instance', { target }),
  stop: () => ipcRenderer.invoke('agent:stop'),
  write: (data, submitEnter) => ipcRenderer.invoke('agent:write', { data, submitEnter }),
  sendSpecialKey: (key) => ipcRenderer.invoke('agent:special-key', { key }),
  resize: (cols, rows) => ipcRenderer.invoke('agent:resize', { cols, rows }),
  setMode: (mode) => ipcRenderer.invoke('agent:set-mode', { mode }),
  setFloatBounds: (bounds) => ipcRenderer.invoke('agent:set-float-bounds', bounds),
  getContext: () => ipcRenderer.invoke('agent:get-context'),
  clearTranscript: () => ipcRenderer.invoke('agent:clear-transcript'),
  copyTranscript: () => ipcRenderer.invoke('agent:copy-transcript'),
  exportTranscript: () => ipcRenderer.invoke('agent:export-transcript'),
  onState: (cb) => {
    const fn = (_ev: Electron.IpcRendererEvent, st: AgentDockState) => cb(st);
    ipcRenderer.on('agent:state', fn);
    return () => ipcRenderer.removeListener('agent:state', fn);
  },
  onOutput: (cb) => {
    const fn = (
      _ev: Electron.IpcRendererEvent,
      payload: { chunk: string; replace: boolean },
    ) => cb(payload);
    ipcRenderer.on('agent:output', fn);
    return () => ipcRenderer.removeListener('agent:output', fn);
  },
  onInjectContext: (cb) => {
    const fn = (_ev: Electron.IpcRendererEvent, snippet: string) => cb(snippet);
    ipcRenderer.on('agent:inject-context', fn);
    return () => ipcRenderer.removeListener('agent:inject-context', fn);
  },
};

contextBridge.exposeInMainWorld('ironAgent', api);
