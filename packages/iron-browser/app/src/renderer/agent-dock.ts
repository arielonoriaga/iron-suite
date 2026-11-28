import type { IronAgentDockApi } from '../preload/agent-preload';
import {
  parseAgentTranscript,
  parseAnsiTranscript,
  stripAnsiAll,
  tokenizeCodeLine,
  type AnsiSpan,
  type InlineToken,
} from '../shared/agent-markdown';
import { computeResizedFloatBounds, type FloatResizeEdge } from '../shared/layout';
import type {
  AgentCliOption,
  AgentCliPreset,
  AgentDockState,
  Rect,
  RunningAgentInstance,
} from '../shared/types';

const RESIZE_CURSORS: Record<FloatResizeEdge, string> = {
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  nw: 'nwse-resize',
  se: 'nwse-resize',
};

const VALID_RESIZE_EDGES = new Set<string>(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']);

declare global {
  interface Window {
    ironAgent: IronAgentDockApi;
  }
}

export function stripAnsiSequences(input: string): string {
  return stripAnsiAll(input);
}

const EMPTY_PLACEHOLDER =
  'Select a running agent or terminal instance above (iron-term or tmux) to chat with it live, or start an available CLI / shell.\n\nEvery spawned agent automatically receives IRON_BROWSER_SOCKET bound to this window.';

function copyTextSafely(text: string): void {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      void navigator.clipboard.writeText(text).catch(() => {});
    }
  } catch {
    // Ignore clipboard unavailability in restricted/headless contexts.
  }
}

function appendInlineTokens(parent: HTMLElement, tokens: InlineToken[], doc: Document = document): void {
  for (const tok of tokens) {
    if (tok.type === 'text') {
      parent.appendChild(doc.createTextNode(tok.text));
    } else if (tok.type === 'code') {
      const el = doc.createElement('code');
      el.className = 'md-inline-code';
      el.textContent = tok.text;
      parent.appendChild(el);
    } else if (tok.type === 'bold') {
      const el = doc.createElement('strong');
      el.className = 'md-strong';
      appendInlineTokens(el, tok.children, doc);
      parent.appendChild(el);
    } else if (tok.type === 'italic') {
      const el = doc.createElement('em');
      el.className = 'md-em';
      appendInlineTokens(el, tok.children, doc);
      parent.appendChild(el);
    } else if (tok.type === 'strike') {
      const el = doc.createElement('del');
      el.className = 'md-del';
      appendInlineTokens(el, tok.children, doc);
      parent.appendChild(el);
    } else if (tok.type === 'link') {
      const el = doc.createElement('span');
      el.className = 'md-link';
      el.textContent = tok.label;
      el.title = `${tok.href} (click to copy URL)`;
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        copyTextSafely(tok.href);
      });
      parent.appendChild(el);
    }
  }
}

function appendAnsiSpans(parent: HTMLElement, spans: AnsiSpan[], doc: Document = document): void {
  if (spans.length === 0) {
    parent.appendChild(doc.createTextNode(' '));
    return;
  }
  for (const sp of spans) {
    const s = sp.style;
    const hasStyle = Boolean(s.fg || s.bold || s.dim || s.italic || s.underline || s.strike);
    if (!hasStyle) {
      parent.appendChild(doc.createTextNode(sp.text));
      continue;
    }
    const el = doc.createElement('span');
    el.textContent = sp.text;
    if (s.fg) el.style.color = s.fg;
    if (s.bold) el.classList.add('ansi-bold');
    if (s.dim) el.classList.add('ansi-dim');
    if (s.italic) el.classList.add('ansi-italic');
    if (s.underline) el.classList.add('ansi-underline');
    if (s.strike) el.classList.add('ansi-strike');
    parent.appendChild(el);
  }
}

function renderFormattedMarkdown(container: HTMLElement, raw: string, doc: Document = document): void {
  const frag = doc.createDocumentFragment();
  const blocks = parseAgentTranscript(raw);

  if (blocks.length === 0) {
    const empty = doc.createElement('div');
    empty.className = 'md-empty';
    empty.textContent = EMPTY_PLACEHOLDER;
    frag.appendChild(empty);
    container.replaceChildren(frag);
    return;
  }

  for (const block of blocks) {
    if (block.type === 'heading') {
      const el = doc.createElement(`h${block.level}`);
      el.className = `md-h${block.level}`;
      appendInlineTokens(el, block.tokens, doc);
      frag.appendChild(el);
    } else if (block.type === 'code') {
      const card = doc.createElement('div');
      card.className = 'md-code-block';

      const hdr = doc.createElement('div');
      hdr.className = 'md-code-header';
      const langWrap = doc.createElement('div');
      const langEl = doc.createElement('span');
      langEl.className = 'md-code-lang';
      langEl.textContent = block.lang;
      langWrap.appendChild(langEl);
      if (!block.closed) {
        const streaming = doc.createElement('span');
        streaming.className = 'md-code-streaming';
        streaming.textContent = 'streaming…';
        langWrap.appendChild(streaming);
      }

      const copyBtn = doc.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'md-copy-btn';
      copyBtn.textContent = 'Copy';
      const codeText = block.code;
      copyBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        copyTextSafely(codeText);
        copyBtn.textContent = 'Copied';
        copyBtn.classList.add('copied');
        setTimeout(() => {
          copyBtn.textContent = 'Copy';
          copyBtn.classList.remove('copied');
        }, 1400);
      });

      hdr.append(langWrap, copyBtn);

      const pre = doc.createElement('pre');
      pre.className = 'md-code-pre';
      const codeLines = block.code.split('\n');
      for (const line of codeLines) {
        const lineEl = doc.createElement('span');
        lineEl.className = 'md-code-line';
        const toks = tokenizeCodeLine(line, block.lang);
        for (const tok of toks) {
          if (tok.kind === 'plain') {
            lineEl.appendChild(doc.createTextNode(tok.text));
          } else {
            const span = doc.createElement('span');
            span.className = `tok-${tok.kind}`;
            span.textContent = tok.text;
            lineEl.appendChild(span);
          }
        }
        pre.appendChild(lineEl);
      }

      card.append(hdr, pre);
      frag.appendChild(card);
    } else if (block.type === 'blockquote') {
      const bq = doc.createElement('blockquote');
      bq.className = 'md-blockquote';
      for (const lineTokens of block.lines) {
        const div = doc.createElement('div');
        div.className = 'md-line';
        appendInlineTokens(div, lineTokens, doc);
        bq.appendChild(div);
      }
      frag.appendChild(bq);
    } else if (block.type === 'list') {
      const list = doc.createElement('div');
      list.className = 'md-list';
      for (const item of block.items) {
        const row = doc.createElement('div');
        row.className = `md-list-item indent-${item.indent}`;
        const marker = doc.createElement('span');
        marker.className = `md-list-marker ${item.marker}`;
        if (item.marker === 'ordered') {
          marker.textContent = item.orderLabel ?? '1.';
        } else if (item.marker === 'task-done') {
          marker.textContent = '✓';
        } else if (item.marker === 'task-active') {
          marker.textContent = '◉';
        } else if (item.marker === 'task-open') {
          marker.textContent = '○';
        } else {
          marker.textContent = '•';
        }
        const body = doc.createElement('div');
        body.className = 'md-list-body';
        appendInlineTokens(body, item.tokens, doc);
        row.append(marker, body);
        list.appendChild(row);
      }
      frag.appendChild(list);
    } else if (block.type === 'table') {
      const wrap = doc.createElement('div');
      wrap.className = 'md-table-wrap';
      const table = doc.createElement('table');
      table.className = 'md-table';
      const thead = doc.createElement('thead');
      const headTr = doc.createElement('tr');
      for (const hTokens of block.headers) {
        const th = doc.createElement('th');
        appendInlineTokens(th, hTokens, doc);
        headTr.appendChild(th);
      }
      thead.appendChild(headTr);
      table.appendChild(thead);

      const tbody = doc.createElement('tbody');
      const colCount = block.headers.length;
      for (const rowCells of block.rows) {
        const tr = doc.createElement('tr');
        for (let c = 0; c < colCount; c += 1) {
          const td = doc.createElement('td');
          const cellTokens = rowCells[c];
          if (cellTokens) {
            appendInlineTokens(td, cellTokens, doc);
          }
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      wrap.appendChild(table);
      frag.appendChild(wrap);
    } else if (block.type === 'hr') {
      const hr = doc.createElement('hr');
      hr.className = 'md-hr';
      frag.appendChild(hr);
    } else if (block.type === 'diff-line') {
      const div = doc.createElement('div');
      div.className = `md-diff-line ${block.kind}`;
      div.textContent = block.text;
      frag.appendChild(div);
    } else if (block.type === 'ansi-line') {
      const div = doc.createElement('div');
      div.className = 'ansi-line';
      appendAnsiSpans(div, block.spans, doc);
      frag.appendChild(div);
    } else if (block.type === 'paragraph') {
      const p = doc.createElement('div');
      p.className = 'md-para';
      for (const line of block.lines) {
        const div = doc.createElement('div');
        div.className = line.status ? `md-line md-line-${line.status}` : 'md-line';
        appendInlineTokens(div, line.tokens, doc);
        p.appendChild(div);
      }
      frag.appendChild(p);
    }
  }

  container.replaceChildren(frag);
}

function renderRawAnsi(container: HTMLElement, raw: string, doc: Document = document): void {
  const frag = doc.createDocumentFragment();
  if (!raw || !stripAnsiAll(raw).trim()) {
    const empty = doc.createElement('div');
    empty.className = 'md-empty';
    empty.textContent = EMPTY_PLACEHOLDER;
    frag.appendChild(empty);
    container.replaceChildren(frag);
    return;
  }
  const lines = parseAnsiTranscript(raw);
  for (const spans of lines) {
    const div = doc.createElement('div');
    div.className = 'ansi-line';
    appendAnsiSpans(div, spans, doc);
    frag.appendChild(div);
  }
  container.replaceChildren(frag);
}

export function mountAgentDock(
  doc: Document = document,
  api: IronAgentDockApi = window.ironAgent,
  win: Window = window,
): void {
  if (!api) return;

  const dockRoot = (doc.getElementById('dock-root') ?? doc.querySelector('.dock-root')) as HTMLElement | null;
  const statusDot = doc.getElementById('status-dot')!;
  const sessionBadge = doc.getElementById('session-badge')!;
  const btnFormatMd = doc.getElementById('btn-format-md');
  const btnModeDocked = doc.getElementById('btn-mode-docked')!;
  const btnModeFloating = doc.getElementById('btn-mode-floating')!;
  const btnModeMin = doc.getElementById('btn-mode-min')!;
  const dragBar = doc.getElementById('dock-drag-bar')!;

  const tabRunning = doc.getElementById('tab-running')!;
  const tabStart = doc.getElementById('tab-start')!;
  const paneRunning = doc.getElementById('pane-running')!;
  const paneStart = doc.getElementById('pane-start')!;
  const presetChips = (doc.getElementById('preset-chips') ??
    paneStart?.querySelector?.('.preset-chips') ??
    null) as HTMLElement | null;
  const btnRefresh = doc.getElementById('btn-refresh-instances')!;
  const btnDisconnect = doc.getElementById('btn-disconnect')!;
  const instanceList = doc.getElementById('instance-list')!;

  const inputCwd = doc.getElementById('input-cwd') as HTMLInputElement;
  const customForm = doc.getElementById('custom-cli-form') as HTMLFormElement;
  const inputCustomCli = doc.getElementById('input-custom-cli') as HTMLInputElement;

  const terminalWrap = doc.getElementById('terminal-wrap')!;
  const terminalScreen = doc.getElementById('terminal-screen')!;
  const btnCopyTranscript = doc.getElementById('btn-copy-transcript') as HTMLButtonElement | null;
  const btnExportTranscript = doc.getElementById('btn-export-transcript') as HTMLButtonElement | null;
  const btnClearTranscript = doc.getElementById('btn-clear-transcript') as HTMLButtonElement | null;
  const btnInsertContext = doc.getElementById('btn-insert-context')!;
  const composerStatus = doc.getElementById('composer-status');
  const chatForm = doc.getElementById('chat-form') as HTMLFormElement;
  const chatInput = doc.getElementById('chat-input') as HTMLTextAreaElement;
  const btnSend = doc.getElementById('btn-send') as HTMLButtonElement | null;

  let currentState: AgentDockState | null = null;
  let rawTranscript = '';
  let markdownEnabled = true;
  let transcriptRafId: number | null = null;
  let deferredForSelection = false;
  let sendingPrompt = false;

  const setComposerStatus = (msg: string | null, isError = false): void => {
    if (!composerStatus) return;
    if (!msg) {
      composerStatus.textContent = '';
      composerStatus.classList.add('hidden');
      composerStatus.classList.remove('error');
      return;
    }
    composerStatus.textContent = msg;
    composerStatus.classList.remove('hidden');
    composerStatus.classList.toggle('error', isError);
  };

  const hasActiveTerminalSelection = (): boolean => {
    const sel = win.getSelection?.();
    if (!sel || sel.isCollapsed || !sel.toString()) return false;
    return (
      (sel.anchorNode !== null && terminalScreen.contains(sel.anchorNode)) ||
      (sel.focusNode !== null && terminalScreen.contains(sel.focusNode))
    );
  };

  const renderTranscriptNow = (force = false) => {
    if (transcriptRafId !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(transcriptRafId);
    }
    transcriptRafId = null;
    if (!force && hasActiveTerminalSelection()) {
      deferredForSelection = true;
      return;
    }
    deferredForSelection = false;
    const stickToBottom =
      terminalWrap.scrollHeight - terminalWrap.scrollTop - terminalWrap.clientHeight < 48;
    terminalScreen.classList.toggle('md-mode', markdownEnabled);
    terminalScreen.classList.toggle('raw-mode', !markdownEnabled);
    if (markdownEnabled) {
      renderFormattedMarkdown(terminalScreen, rawTranscript, doc);
    } else {
      renderRawAnsi(terminalScreen, rawTranscript, doc);
    }
    if (stickToBottom) {
      terminalWrap.scrollTop = terminalWrap.scrollHeight;
    }
  };

  const renderTranscript = () => {
    if (transcriptRafId !== null) return;
    if (typeof requestAnimationFrame === 'function') {
      transcriptRafId = requestAnimationFrame(() => renderTranscriptNow(false));
    } else {
      renderTranscriptNow(false);
    }
  };

  doc.addEventListener('selectionchange', () => {
    if (deferredForSelection && !hasActiveTerminalSelection()) {
      renderTranscript();
    }
  });

  btnFormatMd?.addEventListener('click', () => {
    markdownEnabled = !markdownEnabled;
    btnFormatMd.classList.toggle('active', markdownEnabled);
    btnFormatMd.textContent = markdownEnabled ? 'MD' : 'Raw';
    renderTranscriptNow(true);
  });

  btnCopyTranscript?.addEventListener('click', () => {
    const clean = stripAnsiAll(rawTranscript);
    copyTextSafely(clean);
    void api.copyTranscript?.();
    const prevText = btnCopyTranscript.textContent;
    btnCopyTranscript.textContent = 'Copied';
    setComposerStatus('Transcript copied to clipboard.', false);
    setTimeout(() => {
      btnCopyTranscript.textContent = prevText || 'Copy';
    }, 1200);
  });

  btnExportTranscript?.addEventListener('click', () => {
    void api
      .exportTranscript?.()
      .then((res) => {
        if (!res || res.canceled) return;
        if (res.ok && res.path) {
          const base = res.path.split('/').pop() || res.path;
          setComposerStatus(`Exported ${base}`, false);
        } else {
          setComposerStatus(res.error || 'Failed to export transcript.', true);
        }
      })
      .catch((err) => {
        setComposerStatus(
          `Export error: ${err instanceof Error ? err.message : String(err)}`,
          true,
        );
      });
  });

  btnClearTranscript?.addEventListener('click', () => {
    rawTranscript = '';
    renderTranscriptNow(true);
    setComposerStatus('Transcript cleared.', false);
    void api.clearTranscript?.();
  });

  const renderState = (state: AgentDockState) => {
    currentState = state;
    const live = state.session.active;
    statusDot.classList.toggle('live', live);
    sessionBadge.textContent = live ? state.session.label : 'Idle';
    btnDisconnect.classList.toggle('hidden', !live);
    btnModeDocked.classList.toggle('active', state.mode === 'docked');
    btnModeFloating.classList.toggle('active', state.mode === 'floating');
    dockRoot?.classList.toggle('floating', state.mode === 'floating');
    if (live && composerStatus && !composerStatus.classList.contains('hidden')) {
      setComposerStatus(null);
    }
  };

  const renderInstances = (instances: RunningAgentInstance[]) => {
    instanceList.innerHTML = '';
    if (instances.length === 0) {
      const empty = doc.createElement('div');
      empty.className = 'empty-note';
      empty.textContent =
        'No running agent or terminal instances detected (iron-term or tmux). Switch to "Start CLI Agent" to launch an available CLI or shell.';
      instanceList.appendChild(empty);
      return;
    }
    for (const inst of instances) {
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'instance-item';
      if (currentState?.session.targetPane === inst.target) {
        btn.classList.add('attached');
      }

      const main = doc.createElement('div');
      main.className = 'inst-main';
      const title = doc.createElement('span');
      title.className = 'inst-title';
      const sub = doc.createElement('span');
      sub.className = 'inst-sub';
      const pill = doc.createElement('span');
      pill.className = 'inst-pill';

      if (inst.kind === 'iron-term') {
        title.textContent = `${inst.windowName} · ${inst.sessionId ?? inst.target}`;
        sub.textContent = inst.cwd || (inst.state ? `state: ${inst.state}` : 'iron-term');
        pill.textContent = `iron-term · ${inst.command}`;
      } else {
        title.textContent = `${inst.target} · ${inst.windowName}`;
        sub.textContent = inst.cwd || `pid ${inst.pid}`;
        pill.textContent = inst.command;
      }

      main.append(title, sub);
      btn.append(main, pill);
      btn.addEventListener('click', () => {
        void api.attachInstance(inst.target).then((st) => {
          renderState(st);
          void api.listInstances().then(renderInstances);
          chatInput.focus();
        });
      });
      instanceList.appendChild(btn);
    }
  };

  const computeColsRows = () => {
    const cols = Math.max(40, Math.floor((terminalWrap.clientWidth - 16) / 7.2));
    const rows = Math.max(12, Math.floor((terminalWrap.clientHeight - 16) / 16));
    return { cols, rows };
  };

  tabRunning.addEventListener('click', () => {
    tabRunning.classList.add('active');
    tabStart.classList.remove('active');
    paneRunning.classList.remove('hidden');
    paneStart.classList.add('hidden');
    void api.listInstances().then(renderInstances);
  });

  tabStart.addEventListener('click', () => {
    tabStart.classList.add('active');
    tabRunning.classList.remove('active');
    paneStart.classList.remove('hidden');
    paneRunning.classList.add('hidden');
  });

  btnRefresh.addEventListener('click', () => {
    void api.listInstances().then(renderInstances);
  });

  btnDisconnect.addEventListener('click', () => {
    void api.stop().then((st) => {
      renderState(st);
      void api.listInstances().then(renderInstances);
    });
  });

  btnModeDocked.addEventListener('click', () => void api.setMode('docked').then(renderState));
  btnModeFloating.addEventListener('click', () => void api.setMode('floating').then(renderState));
  btnModeMin.addEventListener('click', () => void api.setMode('minimized').then(renderState));

  // Coalesce rapid pointermove updates to 1 in-flight setFloatBounds IPC at a time.
  let pendingBounds: Partial<Rect> | null = null;
  let boundsInFlight = false;
  let boundsRafId: number | null = null;
  let boundsSeq = 0;

  const flushFloatBounds = () => {
    boundsRafId = null;
    if (boundsInFlight || !pendingBounds) return;
    const next = pendingBounds;
    pendingBounds = null;
    boundsInFlight = true;
    const seq = ++boundsSeq;
    void api
      .setFloatBounds(next)
      .then((st) => {
        if (seq === boundsSeq) {
          renderState(st);
        }
      })
      .catch(() => {})
      .finally(() => {
        boundsInFlight = false;
        if (pendingBounds) {
          flushFloatBounds();
        }
      });
  };

  const scheduleFloatBounds = (next: Partial<Rect>, immediate = false) => {
    pendingBounds = next;
    if (immediate) {
      if (boundsRafId !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(boundsRafId);
        boundsRafId = null;
      }
      flushFloatBounds();
      return;
    }
    if (boundsRafId !== null || boundsInFlight) return;
    if (typeof requestAnimationFrame === 'function') {
      boundsRafId = requestAnimationFrame(flushFloatBounds);
    } else {
      flushFloatBounds();
    }
  };

  // Drag header when floating
  dragBar.addEventListener('pointerdown', (startEv) => {
    if (!currentState || currentState.mode !== 'floating') return;
    if (startEv.button !== 0) return;
    if ((startEv.target as HTMLElement)?.closest('button')) return;
    startEv.preventDefault();
    const startScreenX = startEv.screenX;
    const startScreenY = startEv.screenY;
    const orig = { ...currentState.floatBounds };
    dragBar.setPointerCapture(startEv.pointerId);
    dockRoot?.classList.add('dragging', 'resizing');
    if (doc.body?.style) doc.body.style.cursor = 'grabbing';

    let ended = false;
    const onMove = (ev: PointerEvent) => {
      const nx = orig.x + (ev.screenX - startScreenX);
      const ny = orig.y + (ev.screenY - startScreenY);
      scheduleFloatBounds({ x: nx, y: ny });
    };
    const onEnd = () => {
      if (ended) return;
      ended = true;
      dragBar.removeEventListener('pointermove', onMove);
      dragBar.removeEventListener('pointerup', onEnd);
      dragBar.removeEventListener('pointercancel', onEnd);
      dragBar.removeEventListener('lostpointercapture', onEnd);
      dockRoot?.classList.remove('dragging', 'resizing');
      if (doc.body?.style) doc.body.style.cursor = '';
      if (pendingBounds) {
        scheduleFloatBounds(pendingBounds, true);
      }
    };
    dragBar.addEventListener('pointermove', onMove);
    dragBar.addEventListener('pointerup', onEnd);
    dragBar.addEventListener('pointercancel', onEnd);
    dragBar.addEventListener('lostpointercapture', onEnd);
  });

  // Custom edge & corner resizing when floating
  doc.querySelectorAll<HTMLElement>('.float-resize-handle[data-resize-edge]').forEach((handle) => {
    const rawEdge = handle.dataset.resizeEdge ?? '';
    if (!VALID_RESIZE_EDGES.has(rawEdge)) return;
    const edge = rawEdge as FloatResizeEdge;

    handle.addEventListener('pointerdown', (startEv) => {
      if (!currentState || currentState.mode !== 'floating') return;
      if (startEv.button !== 0) return;
      startEv.preventDefault();
      startEv.stopPropagation();

      const startScreenX = startEv.screenX;
      const startScreenY = startEv.screenY;
      const orig = { ...currentState.floatBounds };
      handle.setPointerCapture(startEv.pointerId);
      handle.classList.add('active');
      dockRoot?.classList.add('resizing');
      if (doc.body?.style) doc.body.style.cursor = RESIZE_CURSORS[edge];

      let ended = false;
      const onMove = (ev: PointerEvent) => {
        const dx = ev.screenX - startScreenX;
        const dy = ev.screenY - startScreenY;
        const next = computeResizedFloatBounds(orig, edge, dx, dy);
        scheduleFloatBounds(next);
      };

      const onEnd = () => {
        if (ended) return;
        ended = true;
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onEnd);
        handle.removeEventListener('pointercancel', onEnd);
        handle.removeEventListener('lostpointercapture', onEnd);
        handle.classList.remove('active');
        dockRoot?.classList.remove('resizing');
        if (doc.body?.style) doc.body.style.cursor = '';
        if (pendingBounds) {
          scheduleFloatBounds(pendingBounds, true);
        }
        const { cols, rows } = computeColsRows();
        void api.resize(cols, rows);
      };

      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onEnd);
      handle.addEventListener('pointercancel', onEnd);
      handle.addEventListener('lostpointercapture', onEnd);
    });
  });

  const bindPresetChip = (
    chip: HTMLButtonElement,
    preset: AgentCliPreset,
    command?: string,
  ): void => {
    chip.addEventListener('click', () => {
      const { cols, rows } = computeColsRows();
      void api
        .startCli({
          preset,
          ...(command ? { customCommand: command } : {}),
          cwd: inputCwd.value.trim() || undefined,
          cols,
          rows,
        })
        .then((st) => {
          renderState(st);
          chatInput.focus();
        })
        .catch((err) => {
          rawTranscript += `\n[Launch error: ${String(err)}]\n`;
          renderTranscript();
        });
    });
  };

  const renderPresetChips = (clis: AgentCliOption[]): void => {
    if (!presetChips || typeof presetChips.replaceChildren !== 'function') return;
    const buttons: HTMLButtonElement[] = [];
    for (const cli of clis) {
      if (!cli.available) continue;
      const btn = doc.createElement('button');
      btn.className = 'chip-btn';
      btn.type = 'button';
      btn.dataset.preset = cli.id;
      btn.textContent = cli.label;
      bindPresetChip(btn, cli.preset, cli.command);
      buttons.push(btn);
    }
    if (buttons.length > 0) {
      presetChips.replaceChildren(...buttons);
    }
  };

  doc.querySelectorAll<HTMLButtonElement>('.chip-btn[data-preset]').forEach((chip) => {
    const preset = (chip.dataset.preset || 'shell') as AgentCliPreset;
    bindPresetChip(chip, preset);
  });

  customForm.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const cmd = inputCustomCli.value.trim();
    if (!cmd) return;
    const { cols, rows } = computeColsRows();
    void api
      .startCli({
        preset: 'custom',
        customCommand: cmd,
        cwd: inputCwd.value.trim() || undefined,
        cols,
        rows,
      })
      .then((st) => {
        renderState(st);
        chatInput.focus();
      })
      .catch((err) => {
        rawTranscript += `\n[Launch error: ${String(err)}]\n`;
        renderTranscript();
      });
  });

  doc.querySelectorAll<HTMLButtonElement>('.qkey[data-skey]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const skey = btn.dataset.skey;
      if (skey) void api.sendSpecialKey(skey);
    });
  });

  btnInsertContext.addEventListener('click', () => {
    void api.getContext().then((snippet) => {
      const prefix = chatInput.value && !chatInput.value.endsWith(' ') ? `${chatInput.value} ` : chatInput.value;
      chatInput.value = `${prefix}${snippet} `;
      chatInput.focus();
    });
  });

  const submitPrompt = async (): Promise<void> => {
    if (sendingPrompt) return;
    const msg = chatInput.value;
    if (!msg.trim()) return;
    sendingPrompt = true;
    if (btnSend) btnSend.disabled = true;
    setComposerStatus(null);
    try {
      const ok = await api.write(msg, true);
      if (ok) {
        if (chatInput.value === msg) {
          chatInput.value = '';
        }
        setComposerStatus(null);
      } else {
        setComposerStatus(
          currentState?.session.active
            ? 'Failed to send input to agent.'
            : 'No active agent session — start or attach an agent first.',
          true,
        );
      }
    } catch (err) {
      setComposerStatus(
        `Send error: ${err instanceof Error ? err.message : String(err)}`,
        true,
      );
    } finally {
      sendingPrompt = false;
      if (btnSend) btnSend.disabled = false;
      chatInput.focus();
    }
  };

  chatInput.addEventListener('input', () => {
    if (composerStatus && !composerStatus.classList.contains('hidden')) {
      setComposerStatus(null);
    }
  });

  chatForm.addEventListener('submit', (ev) => {
    ev.preventDefault();
    void submitPrompt();
  });

  chatInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      void submitPrompt();
    }
  });

  // Direct keyboard passthrough when user clicks/focuses the terminal output pane
  terminalWrap.addEventListener('keydown', (ev) => {
    if (!currentState?.session.active) return;
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'c' && win.getSelection?.()?.toString()) {
      return; // Allow normal copy when text is selected.
    }
    ev.preventDefault();
    if (ev.ctrlKey && ev.key.toLowerCase() === 'c') {
      void api.sendSpecialKey('Interrupt');
      return;
    }
    if (ev.key === 'Enter') {
      void api.sendSpecialKey('Enter');
      return;
    }
    if (ev.key === 'Escape') {
      void api.sendSpecialKey('Escape');
      return;
    }
    if (ev.key === 'ArrowUp') {
      void api.sendSpecialKey('Up');
      return;
    }
    if (ev.key === 'ArrowDown') {
      void api.sendSpecialKey('Down');
      return;
    }
    if (ev.key === 'Tab') {
      void api.sendSpecialKey('Tab');
      return;
    }
    if (ev.key === 'Backspace') {
      void api.write('\x7f', false);
      return;
    }
    if (ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      void api.write(ev.key, false);
    }
  });

  win.addEventListener('resize', () => {
    const { cols, rows } = computeColsRows();
    void api.resize(cols, rows);
  });

  api.onState(renderState);
  api.onOutput(({ chunk, replace }) => {
    rawTranscript = replace ? chunk : rawTranscript + chunk;
    if (rawTranscript.length > 180_000) {
      rawTranscript = rawTranscript.slice(-180_000);
    }
    renderTranscript();
  });
  api.onInjectContext((snippet) => {
    const prefix = chatInput.value && !chatInput.value.endsWith(' ') ? `${chatInput.value} ` : chatInput.value;
    chatInput.value = `${prefix}${snippet} `;
    chatInput.focus();
  });

  void api.getInitial().then((init) => {
    inputCwd.value = init.defaultCwd;
    rawTranscript = init.transcript;
    if (Array.isArray(init.availableClis) && init.availableClis.length > 0) {
      renderPresetChips(init.availableClis);
    }
    renderState(init.state);
    renderInstances(init.instances);
    renderTranscript();
    if (init.instances.length === 0) {
      tabStart.click();
    }
  });
}

if (typeof document !== 'undefined' && document.getElementById('dock-root')) {
  mountAgentDock();
}
