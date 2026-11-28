import assert from 'node:assert/strict';
import http from 'node:http';
import { launchElectronSession } from './lib/electron-harness';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runKeyboardWebGlAgentE2E(): Promise<void> {
  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Keyboard + WebGL + RenderOrder E2E</title>
  <style>
    body { margin: 0; background: #0b1320; color: #fff; font-family: sans-serif; }
    #hud-overlay {
      position: fixed;
      top: 8px;
      left: 8px;
      width: 220px;
      height: 36px;
      z-index: 30;
      transform: translateZ(0);
      background: rgba(17, 28, 45, 0.85);
    }
    #gl-stage {
      position: relative;
      z-index: 2;
      width: 320px;
      height: 200px;
      display: block;
    }
  </style>
</head>
<body>
  <div id="hud-overlay">HUD</div>
  <canvas id="gl-stage" width="320" height="200" tabindex="0"></canvas>
  <input id="secret-field" type="password" aria-label="Secret" />
  <script>
    window.__keyLog = [];
    const canvas = document.getElementById('gl-stage');
    canvas.addEventListener('keydown', (e) => window.__keyLog.push('down:' + e.key + ':' + e.code));
    canvas.addEventListener('keyup', (e) => window.__keyLog.push('up:' + e.key + ':' + e.code));

    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (gl) {
      const vs = gl.createShader(gl.VERTEX_SHADER);
      gl.shaderSource(vs, 'attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }');
      gl.compileShader(vs);
      const fs = gl.createShader(gl.FRAGMENT_SHADER);
      gl.shaderSource(fs, 'precision mediump float; void main(){ gl_FragColor = vec4(0.1, 0.7, 0.6, 1.0); }');
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

      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 16, 16, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);

      let rafFired = false;
      function renderOnce() {
        // Pass 0: FBO offscreen pass
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.viewport(0, 0, 16, 16);
        gl.useProgram(prog);
        gl.drawArrays(gl.TRIANGLES, 0, 3);

        // Pass 1: Screen pass (2 draws)
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, 320, 200);
        gl.enable(gl.BLEND);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      function renderLoop() {
        rafFired = true;
        renderOnce();
        requestAnimationFrame(renderLoop);
      }
      requestAnimationFrame(renderLoop);
      // Unmapped --smoke X11 windows do not receive compositor BeginFrame vsync after initial commit;
      // drive fallback 24ms ticks whenever rAF is paused by the window manager.
      setInterval(() => {
        if (!rafFired) renderOnce();
        rafFired = false;
      }, 32);
    }
  </script>
</body>
</html>`;

  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/`;

  const session = await launchElectronSession({ smoke: true });
  try {
    const opened = await session.ctl.open(url, { mode: 'dual', session: 'shared' });
    const tabId = opened.tab!.id;
    await session.ctl.waitForTabReady(tabId, { expectedUrlIncludes: `:${port}` });
    await sleep(250);

    // 1. Verify browser_webgl capture_frame reports draw calls, passes, and rendering order!
    const webglCapture = await session.ctl.request<{
      ok: boolean;
      viewports: Record<
        string,
        {
          summary: { contexts: number; drawCallsPerFrame: number; trianglesPerFrame: number };
          renderingOrder: Array<{ selector: string; zIndex: string }>;
          capture?: { passes: Array<{ fboTarget: string; drawCalls: number }>; drawCalls: unknown[] };
        }
      >;
    }>('browser_webgl', {
      tab_id: tabId,
      viewport: 'both',
      action: 'capture_frame',
      max_calls: 64,
    });
    assert.equal(webglCapture.ok, true);
    const lGl = webglCapture.viewports.landscape!;
    assert.ok(lGl, 'expected landscape WebGL inspection');
    const selectors = lGl.renderingOrder.map((r) => r.selector);
    assert.ok(
      selectors.indexOf('canvas#gl-stage') < selectors.indexOf('div#hud-overlay'),
      `expected canvas#gl-stage before div#hud-overlay in paint order, got ${JSON.stringify(selectors)}`,
    );
    if (lGl.summary.contexts > 0) {
      assert.equal(lGl.summary.drawCallsPerFrame, 3);
      assert.equal(lGl.summary.trianglesPerFrame, 3);
      assert.equal(lGl.capture?.passes.length, 2);
      assert.equal(lGl.capture?.passes[0]?.fboTarget, 'fbo#4');
      assert.equal(lGl.capture?.passes[1]?.fboTarget, 'screen');
    }

    // 2. Verify keyboard interaction + navigation keys + secret redaction on TabEventBus!
    await session.ctl.interact({
      tabId,
      viewport: 'landscape',
      action: 'click',
      selector: '#gl-stage',
      mirror: true,
    });
    for (const k of ['ArrowRight', 'Home', 'F2']) {
      await session.ctl.interact({
        tabId,
        viewport: 'landscape',
        action: 'key',
        key: k,
        mirror: true,
      });
    }
    await session.ctl.interact({
      tabId,
      viewport: 'landscape',
      action: 'type',
      selector: '#secret-field',
      text: 'hunter42secret',
      mirror: true,
    });
    await sleep(150);

    const pKeysRaw = await session.ctl.evalJs('JSON.stringify(window.__keyLog)', 'portrait', tabId);
    const lKeysRaw = await session.ctl.evalJs('JSON.stringify(window.__keyLog)', 'landscape', tabId);
    for (const k of ['down:ArrowRight', 'down:Home', 'down:F2']) {
      assert.ok(pKeysRaw.value.includes(k), `portrait missed key ${k}: ${pKeysRaw.value}`);
      assert.ok(lKeysRaw.value.includes(k), `landscape missed key ${k}: ${lKeysRaw.value}`);
    }

    const busRes = await session.ctl.request<{
      events: Array<{ kind: string; summary: string }>;
    }>('browser_events', {
      tab_id: tabId,
      domain: 'gesture',
      limit: 100,
    });
    const fullDump = JSON.stringify(busRes.events);
    assert.ok(!fullDump.includes('hunter42secret'), 'password input keystrokes must never leak to TabEventBus');

    console.log(
      `PASS keyboard-webgl-agent.e2e.ts (webglContexts=${lGl.summary.contexts}, drawCalls=${lGl.summary.drawCallsPerFrame}, layers=${selectors.join(' -> ')})`,
    );
  } finally {
    await session.close();
    server.close();
  }
}

runKeyboardWebGlAgentE2E().catch((err) => {
  console.error('FAIL keyboard-webgl-agent.e2e.ts:', err);
  process.exit(1);
});
