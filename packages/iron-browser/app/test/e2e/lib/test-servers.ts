import zlib from 'node:zlib';
import type {
  HttpLogEntry,
  SseStats,
  TestServerCluster,
  WsReceivedMessage,
  WsStats,
} from './types';

interface WsSocketData {
  connectionId: number;
  subprotocol: string | null;
}

interface ActiveSseClient {
  id: number;
  controller: ReadableStreamDefaultController<Uint8Array>;
  closed: boolean;
}

const CORRELATION_KEYS = new Set([
  'idempotencyKey',
  'clientRequestId',
  'requestId',
  'clientBetId',
  'clientTxId',
  'correlationId',
  'traceId',
  'timestamp',
  'ts',
  'clientTime',
  'clientTimestamp',
  'sentAt',
]);

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const encoder = new TextEncoder();

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function extractCorrelation(parsed: unknown): Record<string, unknown> {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (CORRELATION_KEYS.has(k)) {
      out[k] = v;
    }
  }
  return out;
}

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

function queryToRecord(url: URL): Record<string, string> {
  const out: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function buildPageHtml(title: string, bodyHtml: string, scriptJs = ''): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: sans-serif; margin: 16px; }
    .spacer { height: 1400px; background: linear-gradient(#f4f6f9, #dbe3ee); }
    #inner-scroll { height: 120px; width: 280px; overflow: auto; border: 1px solid #888; }
    #inner-scroll-content { height: 500px; padding: 8px; }
    #draw-canvas { border: 1px solid #333; display: block; touch-action: none; }
    [aria-pressed="true"], [data-state="open"] { background: #1e66f5; color: #fff; }
  </style>
</head>
<body>
${bodyHtml}
${scriptJs ? `<script>\n${scriptJs}\n</script>` : ''}
</body>
</html>`;
}

export class LocalTestServerCluster implements TestServerCluster {
  private primaryServer: ReturnType<typeof Bun.serve<WsSocketData>> | null = null;
  private secondaryServer: ReturnType<typeof Bun.serve<WsSocketData>> | null = null;

  private _httpBaseUrl = '';
  private _altOriginBaseUrl = '';
  private _wsBaseUrl = '';
  private _sseBaseUrl = '';

  private nextLogId = 1;
  private httpLogs: HttpLogEntry[] = [];
  private pathCounts = new Map<string, number>();
  private mutationCounts = new Map<string, number>();
  private cacheSeq = 0;

  private nextWsId = 1;
  private activeWs = new Set<Bun.ServerWebSocket<WsSocketData>>();
  private wsTotalConnections = 0;
  private wsMessages: WsReceivedMessage[] = [];

  private nextSseId = 1;
  private activeSse = new Set<ActiveSseClient>();
  private sseTotalConnections = 0;
  private sseLastEventIds: string[] = [];

  get httpBaseUrl(): string {
    return this._httpBaseUrl;
  }

  get altOriginBaseUrl(): string {
    return this._altOriginBaseUrl;
  }

  get wsBaseUrl(): string {
    return this._wsBaseUrl;
  }

  get sseBaseUrl(): string {
    return this._sseBaseUrl;
  }

  async start(): Promise<void> {
    if (this.primaryServer || this.secondaryServer) return;

    this.secondaryServer = Bun.serve<WsSocketData>({
      hostname: '127.0.0.1',
      port: 0,
      idleTimeout: 0,
      fetch: (req) => this.handleHttpRequest(req, true),
      websocket: {
        message: () => {},
      },
    });

    this._altOriginBaseUrl = `http://127.0.0.1:${this.secondaryServer.port}`;

    this.primaryServer = Bun.serve<WsSocketData>({
      hostname: '127.0.0.1',
      port: 0,
      idleTimeout: 0,
      fetch: (req, server) => {
        const url = new URL(req.url);
        if (url.pathname === '/ws') {
          const rawProto = req.headers.get('sec-websocket-protocol');
          const firstProto = rawProto
            ? rawProto
                .split(',')
                .map((p) => p.trim())
                .find((p) => p.length > 0) ?? null
            : null;
          const connectionId = this.nextWsId++;
          const upgradeOpts: {
            headers?: Record<string, string>;
            data: WsSocketData;
          } = {
            data: { connectionId, subprotocol: firstProto },
          };
          if (firstProto) {
            upgradeOpts.headers = { 'Sec-WebSocket-Protocol': firstProto };
          }
          if (server.upgrade(req, upgradeOpts)) {
            return undefined;
          }
          return new Response('WebSocket upgrade failed', { status: 400 });
        }
        return this.handleHttpRequest(req, false);
      },
      websocket: {
        open: (ws) => {
          this.activeWs.add(ws);
          this.wsTotalConnections += 1;
        },
        message: (ws, message) => {
          const isBinary = typeof message !== 'string';
          const data: string | Uint8Array = isBinary
            ? new Uint8Array(message)
            : message;
          this.wsMessages.push({
            ts: Date.now(),
            data,
            isBinary,
            subprotocol: ws.data.subprotocol,
            connectionId: ws.data.connectionId,
          });
          ws.send(message);
        },
        close: (ws) => {
          this.activeWs.delete(ws);
        },
      },
    });

    this._httpBaseUrl = `http://127.0.0.1:${this.primaryServer.port}`;
    this._wsBaseUrl = `ws://127.0.0.1:${this.primaryServer.port}/ws`;
    this._sseBaseUrl = `http://127.0.0.1:${this.primaryServer.port}/sse`;
  }

  async stop(): Promise<void> {
    this.closeAllSse();
    this.closeAllWs(1000, 'server-stop');

    const stopBounded = async (
      srv: ReturnType<typeof Bun.serve<WsSocketData>>,
    ): Promise<void> => {
      try {
        srv.unref();
      } catch {
        // Ignore if already stopped.
      }
      let timer: ReturnType<typeof setTimeout> | null = null;
      await Promise.race([
        Promise.resolve(srv.stop(true)).catch(() => {}),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 200);
        }),
      ]);
      if (timer !== null) {
        clearTimeout(timer);
      }
    };

    const stops: Array<Promise<void>> = [];
    if (this.primaryServer) {
      const srv = this.primaryServer;
      this.primaryServer = null;
      stops.push(stopBounded(srv));
    }
    if (this.secondaryServer) {
      const srv = this.secondaryServer;
      this.secondaryServer = null;
      stops.push(stopBounded(srv));
    }
    await Promise.all(stops);

    this._httpBaseUrl = '';
    this._altOriginBaseUrl = '';
    this._wsBaseUrl = '';
    this._sseBaseUrl = '';
  }

  getHttpLogs(pathPrefix?: string): HttpLogEntry[] {
    if (!pathPrefix) return [...this.httpLogs];
    return this.httpLogs.filter((entry) => entry.path.startsWith(pathPrefix));
  }

  resetHttpLogs(): void {
    this.httpLogs = [];
    this.pathCounts.clear();
    this.mutationCounts.clear();
  }

  getMutationCount(pathPrefix?: string): number {
    if (!pathPrefix) {
      let total = 0;
      for (const n of this.mutationCounts.values()) total += n;
      return total;
    }
    let total = 0;
    for (const [k, n] of this.mutationCounts.entries()) {
      if (k.startsWith(pathPrefix)) total += n;
    }
    return total;
  }

  broadcastWs(data: string | Uint8Array): number {
    let sent = 0;
    for (const ws of this.activeWs) {
      ws.send(data);
      sent += 1;
    }
    return sent;
  }

  closeAllWs(code = 1012, reason = 'restart'): number {
    let closed = 0;
    for (const ws of [...this.activeWs]) {
      try {
        ws.close(code, reason);
        closed += 1;
      } catch {
        // Ignore close races.
      }
      this.activeWs.delete(ws);
    }
    return closed;
  }

  closeFirstWsOwner(code = 1012, reason = 'owner-teardown'): boolean {
    const first = this.activeWs.values().next().value;
    if (!first) return false;
    try {
      first.close(code, reason);
    } catch {
      // Ignore close races.
    }
    this.activeWs.delete(first);
    return true;
  }

  getWsStats(): WsStats {
    return {
      activeConnections: this.activeWs.size,
      totalConnections: this.wsTotalConnections,
      receivedMessages: [...this.wsMessages],
    };
  }

  resetWsStats(): void {
    this.wsTotalConnections = this.activeWs.size;
    this.wsMessages = [];
  }

  pushSseEvent(eventName: string | null, data: string, id?: string): number {
    let chunkStr = '';
    if (id !== undefined) {
      chunkStr += `id: ${id}\n`;
    }
    if (eventName !== null && eventName.length > 0) {
      chunkStr += `event: ${eventName}\n`;
    }
    for (const line of data.split('\n')) {
      chunkStr += `data: ${line}\n`;
    }
    chunkStr += '\n';

    const bytes = encoder.encode(chunkStr);
    let delivered = 0;
    for (const client of [...this.activeSse]) {
      if (client.closed) continue;
      try {
        client.controller.enqueue(bytes);
        delivered += 1;
      } catch {
        client.closed = true;
        this.activeSse.delete(client);
      }
    }
    return delivered;
  }

  getSseStats(): SseStats {
    return {
      activeConnections: this.activeSse.size,
      totalConnections: this.sseTotalConnections,
      lastEventIdsReceived: [...this.sseLastEventIds],
    };
  }

  resetSseStats(): void {
    this.sseTotalConnections = this.activeSse.size;
    this.sseLastEventIds = [];
  }

  closeAllSse(): void {
    for (const client of [...this.activeSse]) {
      if (!client.closed) {
        client.closed = true;
        try {
          client.controller.close();
        } catch {
          // Ignore already-closed streams.
        }
      }
      this.activeSse.delete(client);
    }
  }

  private async handleHttpRequest(
    req: Request,
    isAltOrigin: boolean,
  ): Promise<Response> {
    const url = new URL(req.url);
    const pathname = url.pathname;
    const method = req.method.toUpperCase();

    if (pathname === '/sse' && !isAltOrigin) {
      return this.handleSseRequest(req);
    }

    const bodyText =
      method === 'GET' || method === 'HEAD' ? '' : await req.text();

    if (!isAltOrigin) {
      this.httpLogs.push({
        id: this.nextLogId++,
        timestampMs: Date.now(),
        method,
        path: pathname,
        query: queryToRecord(url),
        headers: headersToRecord(req.headers),
        bodyText,
      });
    }

    const nextCount = (this.pathCounts.get(pathname) ?? 0) + 1;
    this.pathCounts.set(pathname, nextCount);

    if (pathname === '/echo') {
      return Response.json(
        {
          method,
          path: pathname,
          query: queryToRecord(url),
          headers: headersToRecord(req.headers),
          bodyText,
          count: nextCount,
          origin: isAltOrigin ? 'alt' : 'primary',
        },
        {
          headers: { 'Access-Control-Allow-Origin': '*' },
        },
      );
    }

    if (
      pathname === '/mutate' ||
      pathname === '/mutate-gzip' ||
      pathname === '/mutate-br' ||
      pathname === '/mutate-deflate'
    ) {
      if (!MUTATION_METHODS.has(method)) {
        return new Response('Method Not Allowed', { status: 405 });
      }
      const mutCount = (this.mutationCounts.get(pathname) ?? 0) + 1;
      this.mutationCounts.set(pathname, mutCount);

      let parsed: unknown = null;
      if (bodyText.trim().length > 0) {
        try {
          parsed = JSON.parse(bodyText);
        } catch {
          parsed = bodyText;
        }
      }

      const payload = {
        ok: true,
        count: mutCount,
        method,
        path: pathname,
        correlation: extractCorrelation(parsed),
        received: parsed,
      };
      const jsonBytes = Buffer.from(JSON.stringify(payload), 'utf8');

      if (pathname === '/mutate-gzip') {
        const compressed = zlib.gzipSync(jsonBytes);
        return new Response(compressed, {
          status: 200,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Encoding': 'gzip',
            'Access-Control-Allow-Origin': '*',
          },
        });
      }
      if (pathname === '/mutate-br') {
        const compressed = zlib.brotliCompressSync(jsonBytes);
        return new Response(compressed, {
          status: 200,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Encoding': 'br',
            'Access-Control-Allow-Origin': '*',
          },
        });
      }
      if (pathname === '/mutate-deflate') {
        const compressed = zlib.deflateSync(jsonBytes);
        return new Response(compressed, {
          status: 200,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Encoding': 'deflate',
            'Access-Control-Allow-Origin': '*',
          },
        });
      }

      return Response.json(payload, {
        headers: { 'Access-Control-Allow-Origin': '*' },
      });
    }

    if (pathname.startsWith('/status/')) {
      const codeStr = pathname.slice('/status/'.length);
      const code = Number.parseInt(codeStr, 10);
      if (!Number.isInteger(code) || code < 200 || code > 599) {
        return new Response('Invalid status code', { status: 400 });
      }
      if (code === 204 || code === 205 || code === 304) {
        return new Response(null, { status: code });
      }
      if (code === 302 || code === 301 || code === 307 || code === 308) {
        return new Response(null, {
          status: code,
          headers: { Location: '/echo' },
        });
      }
      return Response.json(
        { status: code, path: pathname, count: nextCount },
        { status: code },
      );
    }

    if (pathname === '/large') {
      const sizeBytes = 2_306_867; // > 2 MiB
      const body = Buffer.alloc(sizeBytes, 0x41);
      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(sizeBytes),
        },
      });
    }

    if (pathname === '/stream') {
      const streamType = url.searchParams.get('type') ?? 'ndjson';
      const isBinary = streamType === 'bin';
      const contentType = isBinary
        ? 'application/octet-stream'
        : 'application/x-ndjson';
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          if (isBinary) {
            controller.enqueue(new Uint8Array([1, 2, 3, 4]));
            controller.enqueue(new Uint8Array([5, 6, 7, 8]));
          } else {
            controller.enqueue(encoder.encode('{"seq":1}\n'));
            controller.enqueue(encoder.encode('{"seq":2}\n'));
          }
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': contentType },
      });
    }

    if (pathname === '/cacheable') {
      this.cacheSeq += 1;
      const seq = this.cacheSeq;
      const format = url.searchParams.get('format');
      const accept = req.headers.get('accept') ?? '';
      const wantsHtml =
        format === 'html' || (format !== 'json' && accept.includes('text/html'));
      const headers = {
        'Cache-Control': 'public, max-age=3600',
        ETag: `"seq-${seq}"`,
      };
      if (wantsHtml) {
        return new Response(
          buildPageHtml(
            `Cacheable ${seq}`,
            `<div id="cache-seq" data-seq="${seq}">${seq}</div>`,
          ),
          {
            status: 200,
            headers: {
              ...headers,
              'Content-Type': 'text/html; charset=utf-8',
            },
          },
        );
      }
      return Response.json(
        { seq, etag: `seq-${seq}` },
        { status: 200, headers },
      );
    }

    if (pathname.startsWith('/page/')) {
      return this.handlePageFixture(pathname, isAltOrigin);
    }

    return new Response('Not Found', { status: 404 });
  }

  private handleSseRequest(req: Request): Response {
    const lastEventId = req.headers.get('last-event-id');
    if (lastEventId !== null && lastEventId.length > 0) {
      this.sseLastEventIds.push(lastEventId);
    }

    this.sseTotalConnections += 1;
    let clientRef: ActiveSseClient | null = null;

    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        clientRef = {
          id: this.nextSseId++,
          controller,
          closed: false,
        };
        this.activeSse.add(clientRef);
        controller.enqueue(encoder.encode(': connected\n\n'));
      },
      cancel: () => {
        if (clientRef) {
          clientRef.closed = true;
          this.activeSse.delete(clientRef);
        }
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  private handlePageFixture(pathname: string, isAltOrigin: boolean): Response {
    let html = '';

    switch (pathname) {
      case '/page/interactions':
        html = buildPageHtml(
          'Interactions Fixture',
          `
          <h1 id="page-title">Interactions</h1>
          <button id="btn-inc" data-testid="btn-inc" type="button">Increment</button>
          <span id="inc-count">0</span>

          <div class="toggles">
            <button id="btn-toggle-pressed" type="button" aria-pressed="false">Pressed</button>
            <button id="btn-toggle-checked" role="checkbox" type="button" aria-checked="false">Checked</button>
            <button id="btn-toggle-selected" role="tab" type="button" aria-selected="false">Selected</button>
            <button id="btn-toggle-state" type="button" data-state="closed">DataState</button>
          </div>

          <div>
            <select id="color-select">
              <option value="red">Red</option>
              <option value="green">Green</option>
              <option value="blue">Blue</option>
            </select>
            <span id="select-val">red</span>
          </div>

          <div>
            <input id="range-slider" type="range" min="0" max="100" value="25" />
            <span id="range-val">25</span>
            <div id="aria-slider" role="slider" aria-valuemin="0" aria-valuemax="100" aria-valuenow="50" tabindex="0">ARIA Slider</div>
          </div>

          <canvas id="draw-canvas" width="240" height="120"></canvas>

          <div id="inner-scroll">
            <div id="inner-scroll-content">Inner scrollable area</div>
          </div>

          <div class="mutations">
            <button id="btn-fetch-mutate" type="button">Fetch Mutate</button>
            <button id="btn-fetch-gzip" type="button">Fetch Gzip</button>
            <pre id="mutate-result"></pre>
          </div>

          <div class="spacer"></div>
          <div id="bottom-marker">Bottom</div>
          `,
          `
          let count = 0;
          window.__canvasPoints = [];
          document.getElementById('btn-inc').addEventListener('click', () => {
            count += 1;
            document.getElementById('inc-count').textContent = String(count);
          });
          document.getElementById('btn-toggle-pressed').addEventListener('click', (e) => {
            const b = e.currentTarget;
            b.setAttribute('aria-pressed', b.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
          });
          document.getElementById('btn-toggle-checked').addEventListener('click', (e) => {
            const b = e.currentTarget;
            b.setAttribute('aria-checked', b.getAttribute('aria-checked') === 'true' ? 'false' : 'true');
          });
          document.getElementById('btn-toggle-selected').addEventListener('click', (e) => {
            const b = e.currentTarget;
            b.setAttribute('aria-selected', b.getAttribute('aria-selected') === 'true' ? 'false' : 'true');
          });
          document.getElementById('btn-toggle-state').addEventListener('click', (e) => {
            const b = e.currentTarget;
            b.setAttribute('data-state', b.getAttribute('data-state') === 'open' ? 'closed' : 'open');
          });
          document.getElementById('color-select').addEventListener('change', (e) => {
            document.getElementById('select-val').textContent = e.target.value;
          });
          document.getElementById('range-slider').addEventListener('input', (e) => {
            document.getElementById('range-val').textContent = e.target.value;
          });
          const canvas = document.getElementById('draw-canvas');
          for (const evName of ['pointerdown', 'pointermove', 'pointerup']) {
            canvas.addEventListener(evName, (ev) => {
              window.__canvasPoints.push({ type: evName, x: Math.round(ev.offsetX), y: Math.round(ev.offsetY) });
            });
          }
          async function runMutate(path) {
            const res = await fetch(path, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'bet', idempotencyKey: 'key-' + Math.random().toString(36).slice(2), ts: Date.now() }),
            });
            const body = await res.json();
            document.getElementById('mutate-result').textContent = JSON.stringify({
              status: res.status,
              dedupHeader: res.headers.get('x-iron-browser-dedup'),
              body,
            });
          }
          document.getElementById('btn-fetch-mutate').addEventListener('click', () => runMutate('/mutate'));
          document.getElementById('btn-fetch-gzip').addEventListener('click', () => runMutate('/mutate-gzip'));
          `,
        );
        break;

      case '/page/shadow':
        html = buildPageHtml(
          'Shadow DOM Fixture',
          `
          <div id="shadow-host"></div>
          <div id="shadow-output">0</div>
          `,
          `
          const host = document.getElementById('shadow-host');
          const r1 = host.attachShadow({ mode: 'open' });
          const innerHost = document.createElement('div');
          innerHost.id = 'nested-shadow-host';
          r1.appendChild(innerHost);
          const r2 = innerHost.attachShadow({ mode: 'open' });
          r2.innerHTML = '<button id="shadow-btn" type="button">Shadow Click</button><input id="shadow-input" type="text" />';
          let clicks = 0;
          r2.getElementById('shadow-btn').addEventListener('click', () => {
            clicks += 1;
            document.getElementById('shadow-output').textContent = String(clicks);
          });
          r2.getElementById('shadow-input').addEventListener('input', (e) => {
            document.getElementById('shadow-output').setAttribute('data-input', e.target.value);
          });
          `,
        );
        break;

      case '/page/iframe-same':
        html = buildPageHtml(
          'Same-Origin Iframe Fixture',
          `<iframe id="child-frame" src="/page/iframe-child" width="320" height="180"></iframe>`,
        );
        break;

      case '/page/iframe-cross':
        html = buildPageHtml(
          'Cross-Origin Iframe Fixture',
          `<iframe id="cross-frame" src="${escapeHtml(this._altOriginBaseUrl)}/page/iframe-child" width="320" height="180"></iframe>`,
        );
        break;

      case '/page/iframe-child':
        html = buildPageHtml(
          isAltOrigin ? 'Alt Origin Iframe Child' : 'Same Origin Iframe Child',
          `
          <button id="iframe-btn" data-testid="iframe-btn" type="button">Click Iframe</button>
          <input id="iframe-input" type="text" />
          <span id="iframe-count">0</span>
          `,
          `
          let n = 0;
          document.getElementById('iframe-btn').addEventListener('click', () => {
            n += 1;
            document.getElementById('iframe-count').textContent = String(n);
          });
          `,
        );
        break;

      case '/page/password':
        html = buildPageHtml(
          'Password Redaction Fixture',
          `
          <form id="login-form">
            <input id="secret-pass" type="password" value="s3cr3t-pw" />
            <input id="secret-token" type="text" value="tok-abc" />
            <button id="unmirrored-miss-target" type="button">Missing Target</button>
          </form>
          `,
        );
        break;

      case '/page/ws-sse':
        html = buildPageHtml(
          'WS & SSE Fixture',
          `
          <div id="ws-status">idle</div>
          <pre id="ws-messages">[]</pre>
          <div id="sse-status">idle</div>
          <pre id="sse-messages">[]</pre>
          `,
          `
          window.__wsLog = [];
          window.__sseLog = [];
          window.__ws = null;
          window.__es = null;
          window.__wsOpen = (url, proto) => {
            window.__ws = proto ? new WebSocket(url, proto) : new WebSocket(url);
            window.__ws.binaryType = 'arraybuffer';
            document.getElementById('ws-status').textContent = 'connecting';
            window.__ws.addEventListener('open', () => {
              document.getElementById('ws-status').textContent = 'open:' + (window.__ws.protocol || '');
            });
            window.__ws.addEventListener('message', (ev) => {
              const val = ev.data instanceof ArrayBuffer
                ? { binary: Array.from(new Uint8Array(ev.data)) }
                : ev.data;
              window.__wsLog.push(val);
              document.getElementById('ws-messages').textContent = JSON.stringify(window.__wsLog);
            });
            window.__ws.addEventListener('close', (ev) => {
              document.getElementById('ws-status').textContent = 'closed:' + ev.code;
            });
          };
          window.__wsSend = (data) => {
            if (window.__ws) window.__ws.send(data);
          };
          window.__wsSendBinary = (arr) => {
            if (window.__ws) window.__ws.send(new Uint8Array(arr));
          };
          window.__wsClose = () => {
            if (window.__ws) window.__ws.close(1000, 'client-close');
          };
          window.__sseOpen = (url, eventNames = ['ping-evt', 'room_state']) => {
            window.__es = new EventSource(url);
            document.getElementById('sse-status').textContent = 'connecting';
            window.__es.addEventListener('open', () => {
              document.getElementById('sse-status').textContent = 'open';
            });
            const record = (type, ev) => {
              window.__sseLog.push({ type, data: ev.data, lastEventId: ev.lastEventId || '' });
              document.getElementById('sse-messages').textContent = JSON.stringify(window.__sseLog);
            };
            window.__es.addEventListener('message', (ev) => record('message', ev));
            for (const name of eventNames) {
              window.__es.addEventListener(name, (ev) => record(name, ev));
            }
            window.__es.addEventListener('error', () => {
              document.getElementById('sse-status').textContent = 'error:rs=' + window.__es.readyState;
            });
          };
          `,
        );
        break;

      default:
        return new Response('Unknown fixture page', { status: 404 });
    }

    return new Response(html, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
}

export function createTestServerCluster(): TestServerCluster {
  return new LocalTestServerCluster();
}
