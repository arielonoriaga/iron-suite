import zlib from 'node:zlib';
import type { AcceptanceServerCluster } from './types';

interface WsSocketData {
  connectionId: number;
  subprotocol: string | null;
}

interface ActiveSseClient {
  id: number;
  controller: ReadableStreamDefaultController<Uint8Array>;
  closed: boolean;
}

const encoder = new TextEncoder();

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
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

function buildHtml(title: string, body: string, scriptJs = '', headExtra = ''): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  ${headExtra}
</head>
<body>
${body}
${scriptJs ? `<script>\n${scriptJs}\n</script>` : ''}
</body>
</html>`;
}

export function createAcceptanceServerCluster(): AcceptanceServerCluster {
  let primary: ReturnType<typeof Bun.serve<WsSocketData>> | null = null;
  let secondary: ReturnType<typeof Bun.serve<WsSocketData>> | null = null;

  let httpBaseUrl = '';
  let altOriginBaseUrl = '';
  let wsBaseUrl = '';
  let sseBaseUrl = '';

  let nextLogId = 1;
  let httpLogs: Array<{
    id: number;
    timestampMs: number;
    method: string;
    path: string;
    query: Record<string, string>;
    headers: Record<string, string>;
    bodyText: string;
  }> = [];

  const flakyCounts = new Map<string, number>();
  const authSessions = new Set<string>();

  let nextWsId = 1;
  const activeWs = new Set<Bun.ServerWebSocket<WsSocketData>>();
  let wsTotalConnections = 0;
  const wsMessages: Array<{ data: string | Uint8Array; isBinary: boolean }> = [];

  let nextSseId = 1;
  const activeSse = new Set<ActiveSseClient>();
  let sseTotalConnections = 0;
  const sseLastEventIds: string[] = [];

  const handleHttp = async (req: Request, isAlt: boolean): Promise<Response> => {
    const url = new URL(req.url);
    const pathname = url.pathname;
    const method = req.method.toUpperCase();

    if (pathname === '/sse' && !isAlt) {
      const lastEventId = req.headers.get('last-event-id');
      if (lastEventId) sseLastEventIds.push(lastEventId);
      sseTotalConnections += 1;
      let ref: ActiveSseClient | null = null;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          ref = { id: nextSseId++, controller, closed: false };
          activeSse.add(ref);
          controller.enqueue(encoder.encode(': connected\n\n'));
        },
        cancel() {
          if (ref) {
            ref.closed = true;
            activeSse.delete(ref);
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

    const bodyText = method === 'GET' || method === 'HEAD' ? '' : await req.text();
    if (!isAlt) {
      httpLogs.push({
        id: nextLogId++,
        timestampMs: Date.now(),
        method,
        path: pathname,
        query: queryToRecord(url),
        headers: headersToRecord(req.headers),
        bodyText,
      });
    }

    if (pathname === '/echo') {
      return Response.json(
        {
          ok: true,
          method,
          path: pathname,
          query: queryToRecord(url),
          headers: headersToRecord(req.headers),
          bodyText,
          origin: isAlt ? 'alt' : 'primary',
        },
        { headers: { 'Access-Control-Allow-Origin': '*' } },
      );
    }

    if (pathname === '/spa' || pathname.startsWith('/spa/')) {
      const html = buildHtml(
        'Acceptance SPA',
        `
        <main id="spa-root">
          <h1 id="spa-title">SPA Home</h1>
          <nav>
            <a id="nav-dashboard" href="/spa/dashboard">Dashboard</a>
            <a id="nav-settings" href="/spa/settings">Settings</a>
            <button id="btn-async-route" type="button">Load Async</button>
          </nav>
          <div id="spa-route">${escapeHtml(pathname)}</div>
          <div id="spa-content">initial</div>
        </main>
        `,
        `
        const routeEl = document.getElementById('spa-route');
        const contentEl = document.getElementById('spa-content');
        function renderRoute(path) {
          routeEl.textContent = path;
          if (path === '/spa/dashboard') contentEl.textContent = 'Dashboard Ready';
          else if (path === '/spa/settings') contentEl.textContent = 'Settings Ready';
          else contentEl.textContent = 'Home Ready';
        }
        renderRoute(location.pathname);
        window.addEventListener('popstate', () => renderRoute(location.pathname));
        document.getElementById('nav-dashboard').addEventListener('click', (e) => {
          e.preventDefault();
          history.pushState({}, '', '/spa/dashboard');
          renderRoute('/spa/dashboard');
        });
        document.getElementById('nav-settings').addEventListener('click', (e) => {
          e.preventDefault();
          history.pushState({}, '', '/spa/settings');
          renderRoute('/spa/settings');
        });
        document.getElementById('btn-async-route').addEventListener('click', () => {
          contentEl.textContent = 'Loading...';
          setTimeout(() => {
            const box = document.createElement('div');
            box.id = 'async-loaded';
            box.textContent = 'Async Panel Ready';
            contentEl.replaceChildren(box);
          }, 120);
        });
        `,
      );
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    if (pathname === '/webgl') {
      const html = buildHtml(
        'Acceptance WebGL + Canvas',
        `
        <div id="hud-overlay" style="position:fixed;top:8px;left:8px;z-index:30;transform:translateZ(0);background:rgba(15,23,42,0.85);color:#fff;padding:4px 8px;">HUD</div>
        <canvas id="gl-stage" width="320" height="200" tabindex="0" style="position:relative;z-index:2;display:block;"></canvas>
        <div id="gl-stats">0</div>
        `,
        `
        window.__keyLog = [];
        const canvas = document.getElementById('gl-stage');
        canvas.addEventListener('keydown', (e) => window.__keyLog.push('down:' + e.key));
        const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
        if (gl) {
          const vs = gl.createShader(gl.VERTEX_SHADER);
          gl.shaderSource(vs, 'attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }');
          gl.compileShader(vs);
          const fs = gl.createShader(gl.FRAGMENT_SHADER);
          gl.shaderSource(fs, 'precision mediump float; void main(){ gl_FragColor = vec4(0.2, 0.8, 0.5, 1.0); }');
          gl.compileShader(fs);
          const prog = gl.createProgram();
          gl.attachShader(prog, vs);
          gl.attachShader(prog, fs);
          gl.linkProgram(prog);
          const buf = gl.createBuffer();
          gl.bindBuffer(gl.ARRAY_BUFFER, buf);
          gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.5,-0.5, 0.5,-0.5, 0.0,0.5]), gl.STATIC_DRAW);
          const loc = gl.getAttribLocation(prog, 'p');
          gl.enableVertexAttribArray(loc);
          gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
          let frames = 0;
          let rafFired = false;
          function renderOnce() {
            frames += 1;
            gl.viewport(0, 0, 320, 200);
            gl.useProgram(prog);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            document.getElementById('gl-stats').textContent = String(frames);
          }
          function loop() {
            rafFired = true;
            renderOnce();
            requestAnimationFrame(loop);
          }
          requestAnimationFrame(loop);
          // Unmapped --smoke X11 windows pause rAF vsync after initial commit.
          setInterval(() => {
            if (!rafFired) renderOnce();
            rafFired = false;
          }, 32);
        }
        `,
      );
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    if (pathname === '/auth') {
      const html = buildHtml(
        'Acceptance Auth',
        `
        <form id="login-form">
          <input id="auth-user" type="text" value="devuser" />
          <input id="auth-pass" type="password" value="s3cr3t!" />
          <button id="btn-login" type="submit">Sign In</button>
        </form>
        <div id="auth-status">logged-out</div>
        `,
        `
        document.getElementById('login-form').addEventListener('submit', async (e) => {
          e.preventDefault();
          const u = document.getElementById('auth-user').value;
          const p = document.getElementById('auth-pass').value;
          const res = await fetch('/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user: u, pass: p }),
          });
          const data = await res.json();
          localStorage.setItem('auth_user', data.user || '');
          sessionStorage.setItem('auth_token', data.token || '');
          document.getElementById('auth-status').textContent = data.ok ? 'logged-in:' + data.user : 'failed';
        });
        `,
      );
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    if (pathname === '/auth/login' && method === 'POST') {
      let parsed: { user?: string } = {};
      try {
        parsed = JSON.parse(bodyText) as { user?: string };
      } catch {
        // Ignore.
      }
      const user = parsed.user || 'devuser';
      const token = `tok-${user}-1`;
      authSessions.add(token);
      return new Response(JSON.stringify({ ok: true, user, token }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Set-Cookie': `ib_session=${token}; Path=/; SameSite=Lax`,
        },
      });
    }

    if (pathname === '/auth/me') {
      const cookie = req.headers.get('cookie') ?? '';
      const match = cookie.match(/ib_session=([^;]+)/);
      const token = match?.[1] ?? '';
      if (!token || !authSessions.has(token)) {
        return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
      }
      return Response.json({ ok: true, token }, { status: 200 });
    }

    if (pathname === '/flaky') {
      const key = url.searchParams.get('key') ?? 'default';
      const failUntil = Number.parseInt(url.searchParams.get('fail_until') ?? '1', 10);
      const hit = (flakyCounts.get(key) ?? 0) + 1;
      flakyCounts.set(key, hit);
      if (hit <= failUntil) {
        return new Response(`Temporary failure #${hit}`, {
          status: 500,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      }
      return new Response(
        buildHtml('Recovered Page', `<h1 id="recovered-ok">Recovered on attempt ${hit}</h1>`),
        { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
      );
    }

    if (pathname === '/stream-ui') {
      const html = buildHtml(
        'Acceptance WS+SSE',
        `
        <div id="ws-state">idle</div>
        <div id="ws-msgs"></div>
        <div id="sse-msgs"></div>
        `,
        `
        window.__wsLog = [];
        window.__sseLog = [];
        const ws = new WebSocket(${JSON.stringify(wsBaseUrl)});
        ws.addEventListener('open', () => {
          document.getElementById('ws-state').textContent = 'open';
          ws.send('hello-ws');
        });
        ws.addEventListener('message', (ev) => {
          window.__wsLog.push(ev.data);
          document.getElementById('ws-msgs').textContent = window.__wsLog.join(',');
        });
        const es = new EventSource('/sse');
        es.addEventListener('tick', (ev) => {
          window.__sseLog.push(ev.data);
          document.getElementById('sse-msgs').textContent = window.__sseLog.join(',');
        });
        `,
      );
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    if (pathname === '/responsive') {
      const html = buildHtml(
        'Acceptance Responsive',
        `
        <div id="vp-badge">desktop</div>
        <div id="layout-box">Responsive Content</div>
        `,
        `
        function syncMode() {
          const isMobile = window.matchMedia('(max-width: 600px)').matches;
          document.getElementById('vp-badge').textContent = isMobile ? 'mobile' : 'desktop';
          document.body.dataset.viewportMode = isMobile ? 'mobile' : 'desktop';
        }
        window.addEventListener('resize', syncMode);
        syncMode();
        `,
        `<style>
          body { margin: 0; padding: 12px; font-family: sans-serif; }
          #layout-box { width: 100%; box-sizing: border-box; padding: 16px; background: #1e293b; color: #fff; }
          @media (max-width: 600px) { #layout-box { background: #0f766e; } }
        </style>`,
      );
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    if (pathname === '/find') {
      const html = buildHtml(
        'Acceptance Find & Zoom',
        `
        <h1 id="find-heading">Acceptance Target Alpha</h1>
        <p class="find-item">First needle occurrence: needle-alpha</p>
        <p class="find-item">Second needle occurrence: needle-alpha</p>
        <p class="find-item">Third needle occurrence: needle-alpha</p>
        <div id="zoom-probe" style="width:200px;height:40px;background:#334155;color:#fff;">Zoom Probe</div>
        `,
      );
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    if (pathname === '/download/sample.csv') {
      const csv = 'id,service,status\n1,spa,ok\n2,webgl,ok\n';
      return new Response(csv, {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="sample.csv"',
        },
      });
    }

    if (pathname === '/download-trigger') {
      const html = buildHtml(
        'Acceptance Download Trigger',
        `<a id="dl-link" href="/download/sample.csv" download="sample.csv">Download CSV</a>`,
      );
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    if (pathname === '/subframe-fail') {
      const html = buildHtml(
        'Acceptance Subframe Fail',
        `<h1 id="main-ok">Main Frame OK</h1><iframe id="bad-frame" src="http://127.0.0.1:1/unreachable"></iframe>`,
      );
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    if (pathname === '/broken') {
      const html = buildHtml(
        'Acceptance Broken Page',
        `<h1 id="broken-h1">Broken</h1><button id="btn-fix-later" type="button">Probe</button>`,
        `console.error('E2E_CONSOLE_ERR: broken widget init');
         fetch('/status/500').catch(() => {});`,
      );
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    if (pathname === '/mutate-gzip') {
      const payload = Buffer.from(JSON.stringify({ ok: true, compressed: 'gzip' }), 'utf8');
      return new Response(zlib.gzipSync(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
      });
    }

    if (pathname.startsWith('/status/')) {
      const code = Number.parseInt(pathname.slice('/status/'.length), 10) || 400;
      return Response.json({ status: code }, { status: code });
    }

    return new Response('Not Found', { status: 404 });
  };

  return {
    get httpBaseUrl() {
      return httpBaseUrl;
    },
    get altOriginBaseUrl() {
      return altOriginBaseUrl;
    },
    get wsBaseUrl() {
      return wsBaseUrl;
    },
    get sseBaseUrl() {
      return sseBaseUrl;
    },
    async start() {
      if (primary || secondary) return;
      secondary = Bun.serve<WsSocketData>({
        hostname: '127.0.0.1',
        port: 0,
        idleTimeout: 0,
        fetch: (req) => handleHttp(req, true),
        websocket: { message: () => {} },
      });
      altOriginBaseUrl = `http://127.0.0.1:${secondary.port}`;

      primary = Bun.serve<WsSocketData>({
        hostname: '127.0.0.1',
        port: 0,
        idleTimeout: 0,
        fetch: (req, server) => {
          const url = new URL(req.url);
          if (url.pathname === '/ws') {
            const proto = req.headers.get('sec-websocket-protocol')?.split(',')[0]?.trim() || null;
            const connectionId = nextWsId++;
            if (
              server.upgrade(req, {
                data: { connectionId, subprotocol: proto },
                ...(proto ? { headers: { 'Sec-WebSocket-Protocol': proto } } : {}),
              })
            ) {
              return undefined;
            }
            return new Response('WS upgrade failed', { status: 400 });
          }
          return handleHttp(req, false);
        },
        websocket: {
          open(ws) {
            activeWs.add(ws);
            wsTotalConnections += 1;
          },
          message(ws, message) {
            const isBinary = typeof message !== 'string';
            wsMessages.push({
              data: isBinary ? new Uint8Array(message) : message,
              isBinary,
            });
            ws.send(message);
          },
          close(ws) {
            activeWs.delete(ws);
          },
        },
      });

      httpBaseUrl = `http://127.0.0.1:${primary.port}`;
      wsBaseUrl = `ws://127.0.0.1:${primary.port}/ws`;
      sseBaseUrl = `http://127.0.0.1:${primary.port}/sse`;
    },
    async stop() {
      for (const client of [...activeSse]) {
        client.closed = true;
        try {
          client.controller.close();
        } catch {
          // Ignore.
        }
        activeSse.delete(client);
      }
      for (const ws of [...activeWs]) {
        try {
          ws.close(1000, 'server-stop');
        } catch {
          // Ignore.
        }
        activeWs.delete(ws);
      }
      const stopOne = async (srv: ReturnType<typeof Bun.serve<WsSocketData>> | null) => {
        if (!srv) return;
        try {
          srv.unref();
        } catch {
          // Ignore.
        }
        await Promise.race([
          Promise.resolve(srv.stop(true)).catch(() => {}),
          new Promise<void>((r) => setTimeout(r, 200)),
        ]);
      };
      await Promise.all([stopOne(primary), stopOne(secondary)]);
      primary = null;
      secondary = null;
      httpBaseUrl = '';
      altOriginBaseUrl = '';
      wsBaseUrl = '';
      sseBaseUrl = '';
    },
    getHttpLogs(pathPrefix?: string) {
      return pathPrefix ? httpLogs.filter((l) => l.path.startsWith(pathPrefix)) : [...httpLogs];
    },
    resetHttpLogs() {
      httpLogs = [];
    },
    resetFlaky(key?: string) {
      if (key) flakyCounts.delete(key);
      else flakyCounts.clear();
    },
    getFlakyCount(key = 'default') {
      return flakyCounts.get(key) ?? 0;
    },
    broadcastWs(data: string | Uint8Array) {
      let sent = 0;
      for (const ws of activeWs) {
        ws.send(data);
        sent += 1;
      }
      return sent;
    },
    getWsStats() {
      return {
        activeConnections: activeWs.size,
        totalConnections: wsTotalConnections,
        receivedMessages: [...wsMessages],
      };
    },
    pushSseEvent(eventName: string | null, data: string, id?: string) {
      let payload = '';
      if (id !== undefined) payload += `id: ${id}\n`;
      if (eventName) payload += `event: ${eventName}\n`;
      for (const line of data.split('\n')) {
        payload += `data: ${line}\n`;
      }
      payload += '\n';
      const bytes = encoder.encode(payload);
      let delivered = 0;
      for (const c of [...activeSse]) {
        if (c.closed) continue;
        try {
          c.controller.enqueue(bytes);
          delivered += 1;
        } catch {
          c.closed = true;
          activeSse.delete(c);
        }
      }
      return delivered;
    },
    getSseStats() {
      return {
        activeConnections: activeSse.size,
        totalConnections: sseTotalConnections,
        lastEventIdsReceived: [...sseLastEventIds],
      };
    },
    closeAllSse() {
      for (const c of [...activeSse]) {
        c.closed = true;
        try {
          c.controller.close();
        } catch {
          // Ignore.
        }
        activeSse.delete(c);
      }
    },
  };
}
