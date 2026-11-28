import assert from 'node:assert/strict';
import { launchElectronSession } from './lib/electron-harness';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildMinimalSfsPacket(controller: number, action: number, cmd?: string, extraKey?: string, extraVal?: string): Uint8Array {
  const enc = new TextEncoder();
  const putKey = (k: string) => {
    const kb = enc.encode(k);
    const b = new Uint8Array(2 + kb.length);
    new DataView(b.buffer).setUint16(0, kb.length, false);
    b.set(kb, 2);
    return b;
  };
  const putUtf = (s: string) => {
    const sb = enc.encode(s);
    const b = new Uint8Array(3 + sb.length);
    b[0] = 8;
    new DataView(b.buffer).setUint16(1, sb.length, false);
    b.set(sb, 3);
    return b;
  };

  const pEntries: Uint8Array[] = [];
  let pCount = 0;
  if (cmd !== undefined) {
    pEntries.push(putKey('c'), putUtf(cmd));
    pCount += 1;
  }
  if (extraKey !== undefined && extraVal !== undefined) {
    pEntries.push(putKey(extraKey), putUtf(extraVal));
    pCount += 1;
  }
  const pHdr = new Uint8Array(3);
  pHdr[0] = 18;
  new DataView(pHdr.buffer).setUint16(1, pCount, false);

  const rootHdr = new Uint8Array(3);
  rootHdr[0] = 18;
  new DataView(rootHdr.buffer).setUint16(1, 3, false);

  const cVal = new Uint8Array([2, controller & 0xff]);
  const aVal = new Uint8Array(3);
  aVal[0] = 3;
  new DataView(aVal.buffer).setInt16(1, action, false);

  const bodyParts = [
    rootHdr,
    putKey('c'),
    cVal,
    putKey('a'),
    aVal,
    putKey('p'),
    pHdr,
    ...pEntries,
  ];
  const bodyLen = bodyParts.reduce((s, p) => s + p.byteLength, 0);
  const pkt = new Uint8Array(3 + bodyLen);
  pkt[0] = 0x80;
  new DataView(pkt.buffer).setUint16(1, bodyLen, false);
  let off = 3;
  for (const p of bodyParts) {
    pkt.set(p, off);
    off += p.byteLength;
  }
  return pkt;
}

async function runSfsWsDedupE2E(): Promise<void> {
  let launchCounter = 1000;
  let mobileRedirectHits = 0;
  let totalWsConnections = 0;
  let totalHandshakes = 0;
  let totalLogins = 0;
  let totalBets = 0;
  let duplicateLoginKicks = 0;

  const gameHtml = (wsPort: number) => `<!doctype html>
<html>
<head><meta charset="utf-8"><title>SFS Crash Game</title></head>
<body>
  <div id="status">Connection...</div>
  <div id="balance">30000</div>
  <button id="btn-bet" style="width:160px;height:48px;">Bet 1.00 USD</button>
  <button id="btn-popup" style="width:160px;height:40px;">Open Rules</button>
  <script>
    const params = new URLSearchParams(location.search);
    window.__gameState = {
      user: params.get('user'),
      token: params.get('token'),
      status: 'connecting',
      balance: 30000,
      ticks: 0,
      closedCode: null,
    };

    function encUtf(s) {
      const sb = new TextEncoder().encode(s);
      const out = new Uint8Array(3 + sb.length);
      out[0] = 8;
      new DataView(out.buffer).setUint16(1, sb.length, false);
      out.set(sb, 3);
      return out;
    }
    function encKey(k) {
      const kb = new TextEncoder().encode(k);
      const out = new Uint8Array(2 + kb.length);
      new DataView(out.buffer).setUint16(0, kb.length, false);
      out.set(kb, 2);
      return out;
    }
    function makeSfs(c, a, fields) {
      const entries = Object.entries(fields);
      const pHdr = new Uint8Array(3);
      pHdr[0] = 18;
      new DataView(pHdr.buffer).setUint16(1, entries.length, false);
      const parts = [pHdr];
      for (const [k, v] of entries) {
        parts.push(encKey(k), encUtf(String(v)));
      }
      const pLen = parts.reduce((n, b) => n + b.length, 0);
      const pBuf = new Uint8Array(pLen);
      let po = 0;
      for (const b of parts) { pBuf.set(b, po); po += b.length; }

      const rootHdr = new Uint8Array([18, 0, 3]);
      const cKey = encKey('c'), cVal = new Uint8Array([2, c]);
      const aKey = encKey('a'), aVal = new Uint8Array([3, 0, a]);
      const pKey = encKey('p');
      const all = [rootHdr, cKey, cVal, aKey, aVal, pKey, pBuf];
      const bodyLen = all.reduce((n, b) => n + b.length, 0);
      const pkt = new Uint8Array(3 + bodyLen);
      pkt[0] = 0x80;
      new DataView(pkt.buffer).setUint16(1, bodyLen, false);
      let off = 3;
      for (const b of all) { pkt.set(b, off); off += b.length; }
      return pkt;
    }

    const ws = new WebSocket('ws://127.0.0.1:${wsPort}/BlueBox/websocket');
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      ws.send(makeSfs(0, 0, { api: '1.8.6', cl: 'JavaScript' }));
    };
    ws.onmessage = (ev) => {
      const txt = new TextDecoder().decode(new Uint8Array(ev.data));
      if (txt.includes('hs_ok')) {
        const isMob = innerWidth < 600 ? 'MOBILE' : 'DESKTOP';
        const stk = Math.random().toString(16).slice(2);
        ws.send(makeSfs(0, 1, {
          un: window.__gameState.user + '&&demo',
          token: window.__gameState.token,
          sessionToken: stk,
          deviceType: isMob,
        }));
      } else if (txt.includes('init_ready')) {
        window.__gameState.status = 'gameReady';
        document.getElementById('status').textContent = 'gameReady';
      } else if (txt.includes('bet_accepted')) {
        window.__gameState.balance -= 1;
        document.getElementById('balance').textContent = String(window.__gameState.balance);
      }
    };
    ws.onclose = (ev) => {
      window.__gameState.closedCode = ev.code;
      window.__gameState.status = 'closed:' + ev.code;
    };

    document.getElementById('btn-bet').addEventListener('click', () => {
      // Rotate localStorage clientSeed just like Provably Fair games!
      const prevSeed = localStorage.getItem('pf_seed') || 'init-seed';
      localStorage.setItem('pf_seed', 'seed-' + Math.random().toString(36).slice(2));
      ws.send(makeSfs(1, 13, {
        c: 'betHandler',
        betId: '1',
        bet: '1.00',
        clientSeed: prevSeed,
        currentTimestamp: String(Date.now()),
      }));
    });

    document.getElementById('btn-popup').addEventListener('click', () => {
      window.open(location.origin + '/rules', '_blank');
    });
  </script>
</body>
</html>`;

  interface SfsWsData {
    loggedInOnSocket: boolean;
  }

  const openSockets = new Set<Bun.ServerWebSocket<SfsWsData>>();

  const server = Bun.serve<SfsWsData>({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 0,
    fetch: (req, srv) => {
      const u = new URL(req.url);
      if (u.pathname.startsWith('/BlueBox/websocket')) {
        if (srv.upgrade(req, { data: { loggedInOnSocket: false } })) {
          return undefined;
        }
        return new Response('WebSocket upgrade failed', { status: 400 });
      }
      if (u.pathname === '/launch') {
        const mintedUser = String(++launchCounter);
        const mintedToken = `tok-${mintedUser}-${Math.random().toString(36).slice(2, 10)}`;
        return new Response(null, {
          status: 302,
          headers: {
            Location: `/game?user=${mintedUser}&token=${mintedToken}`,
          },
        });
      }
      if (u.pathname === '/short-launch') {
        return new Response(null, {
          status: 302,
          headers: { Location: '/desktop-landing' },
        });
      }
      if (u.pathname === '/desktop-landing') {
        return new Response(
          `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><script>window.addEventListener('load', () => setTimeout(() => { if (innerWidth < 600) location.replace('/mobile-landing'); }, 20));</script><h1>Desktop</h1></body></html>`,
          {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          },
        );
      }
      if (u.pathname === '/mobile-landing') {
        mobileRedirectHits += 1;
        return new Response('<h1>Mobile</h1>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        });
      }
      if (u.pathname === '/rules') {
        return new Response('<h1>Rules</h1>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        });
      }
      const port = srv.port ?? 0;
      return new Response(gameHtml(port), {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      });
    },
    websocket: {
      open: (ws) => {
        totalWsConnections += 1;
        openSockets.add(ws);
      },
      message: (ws, message) => {
        if (typeof message === 'string') return;
        const txt = new TextDecoder().decode(message);
        if (txt.includes('JavaScript')) {
          totalHandshakes += 1;
          ws.send(buildMinimalSfsPacket(0, 0, undefined, 'tk', 'hs_ok'));
        } else if (txt.includes('&&demo')) {
          totalLogins += 1;
          if (ws.data.loggedInOnSocket) {
            // Real SFS2X kicks duplicate LoginRequest on an already-logged-in session!
            duplicateLoginKicks += 1;
            ws.close(1000);
            return;
          }
          ws.data.loggedInOnSocket = true;
          ws.send(buildMinimalSfsPacket(0, 1, undefined, 'zn', 'login_ok'));
          ws.send(buildMinimalSfsPacket(1, 13, 'init', 'st', 'init_ready'));
        } else if (txt.includes('betHandler')) {
          totalBets += 1;
          ws.send(buildMinimalSfsPacket(1, 13, 'bet', 'res', 'bet_accepted'));
        }
      },
      close: (ws) => {
        openSockets.delete(ws);
      },
    },
  });

  assert(typeof server.port === 'number' && server.port > 0);
  const baseUrl = `http://127.0.0.1:${server.port}`;

  interface GameStateDto {
    user: string;
    token: string;
    status: string;
    balance: number;
  }

  const readGameState = async (
    ctl: typeof session.ctl,
    role: 'portrait' | 'landscape',
    tabId?: string,
  ): Promise<GameStateDto | null> => {
    try {
      const res = await ctl.evalJs('JSON.stringify(window.__gameState)', role, tabId);
      return JSON.parse(res.value) as GameStateDto;
    } catch {
      return null;
    }
  };

  const session = await launchElectronSession({ smoke: true });
  try {
    // 1. Navigate to 302 launcher URL -> both viewports must converge on ONE minted user/token and ONE SFS2X WS session!
    const navRes = await session.ctl.navigate(`${baseUrl}/launch`);
    const gameTabId = navRes.tab?.id ?? 'tab-1';
    await session.ctl.waitForTabReady(gameTabId, { expectedUrlIncludes: '/game?user=' });

    let pState: GameStateDto | null = null;
    let lState: GameStateDto | null = null;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      pState = await readGameState(session.ctl, 'portrait', gameTabId);
      lState = await readGameState(session.ctl, 'landscape', gameTabId);
      if (
        pState?.status === 'gameReady' &&
        lState?.status === 'gameReady' &&
        pState.token === lState.token
      ) {
        break;
      }
      await sleep(120);
    }

    assert.ok(pState && lState, 'expected game states in both viewports');
    assert.equal(pState.user, lState.user, 'both viewports must converge on identical user');
    assert.equal(pState.token, lState.token, 'both viewports must converge on identical token');
    assert.equal(pState.status, 'gameReady');
    assert.equal(lState.status, 'gameReady');
    assert.equal(duplicateLoginKicks, 0, 'duplicate SFS2X LoginRequest must never hit upstream');
    assert.equal(totalLogins, 1, 'only 1 upstream SFS2X LoginRequest should execute');

    // 2. Click mirrored Bet button -> only 1 upstream bet sent despite rotated localStorage clientSeed + timestamp!
    await session.ctl.interact({
      tabId: gameTabId,
      action: 'click',
      selector: '#btn-bet',
      viewport: 'portrait',
      mirror: true,
    });

    const betDeadline = Date.now() + 4000;
    while (Date.now() < betDeadline) {
      pState = await readGameState(session.ctl, 'portrait', gameTabId);
      lState = await readGameState(session.ctl, 'landscape', gameTabId);
      if (pState?.balance === 29999 && lState?.balance === 29999) break;
      await sleep(80);
    }

    assert.equal(totalBets, 1, 'mirrored bet must hit upstream SFS2X server once');
    assert.equal(pState?.balance, 29999);
    assert.equal(lState?.balance, 29999);

    const tabsAfterBet = await session.ctl.tabs();
    const gameTabSnap = tabsAfterBet.tabs.find((t) => t.id === gameTabId);
    assert.ok(
      (gameTabSnap?.dedupCount ?? 0) >= 3,
      `expected dedupCount >= 3 (ws follower + hs + login + bet), got ${gameTabSnap?.dedupCount}`,
    );

    // 3. Reload both viewports -> both reconnect cleanly to gameReady without stale socketLookup or duplicate login kicks!
    await Promise.all([
      session.ctl.evalJs('window.location.reload()', 'portrait', gameTabId),
      session.ctl.evalJs('window.location.reload()', 'landscape', gameTabId),
    ]);
    await sleep(250);

    const reloadDeadline = Date.now() + 8000;
    while (Date.now() < reloadDeadline) {
      pState = await readGameState(session.ctl, 'portrait', gameTabId);
      lState = await readGameState(session.ctl, 'landscape', gameTabId);
      if (pState?.status === 'gameReady' && lState?.status === 'gameReady' && pState.balance === 30000) {
        break;
      }
      await sleep(120);
    }
    assert.equal(pState?.status, 'gameReady', 'portrait must reconnect after reload');
    assert.equal(lState?.status, 'gameReady', 'landscape must reconnect after reload');
    assert.equal(duplicateLoginKicks, 0, 'zero duplicate login kicks after reload');

    // 4. Click mirrored window.open popup button -> spawns strictly ONE new tab instead of two duplicate tabs!
    await session.ctl.interact({
      tabId: gameTabId,
      action: 'click',
      selector: '#btn-popup',
      viewport: 'portrait',
      mirror: true,
    });
    await sleep(500);
    const tabsAfterPopup = await session.ctl.tabs();
    assert.equal(
      tabsAfterPopup.tabs.length,
      2,
      `expected exactly 2 tabs after mirrored window.open, got ${tabsAfterPopup.tabs.length}`,
    );

    // 5. Pass 7 F-11: initial 302 redirect followed by mobile-only portrait redirect must converge ONCE with zero ping-pong!
    const f11Open = await session.ctl.open(`${baseUrl}/short-launch`, {
      mode: 'dual',
      session: 'shared',
    });
    const f11TabId = f11Open.tab?.id ?? 'tab-3';
    await sleep(600);
    const pHref = (await session.ctl.evalJs('location.pathname', 'portrait', f11TabId)).value;
    const lHref = (await session.ctl.evalJs('location.pathname', 'landscape', f11TabId)).value;
    assert.equal(lHref, '/desktop-landing', 'landscape stays on /desktop-landing');
    assert.equal(pHref, '/mobile-landing', 'portrait settles on /mobile-landing');
    assert.ok(
      mobileRedirectHits <= 2,
      `expected bounded mobile redirect hits (<=2, zero ping-pong), got ${mobileRedirectHits}`,
    );

    console.log(
      `PASS sfs-ws-dedup.e2e.ts (wsConns=${totalWsConnections}, handshakes=${totalHandshakes}, logins=${totalLogins}, bets=${totalBets}, kicks=${duplicateLoginKicks})`,
    );
  } finally {
    await session.close();
    for (const ws of [...openSockets]) {
      try {
        ws.close(1000, 'server-stop');
      } catch {
        // Ignore close races.
      }
      openSockets.delete(ws);
    }
    try {
      server.unref();
    } catch {
      // Ignore if already stopped.
    }
    let stopTimer: ReturnType<typeof setTimeout> | null = null;
    await Promise.race([
      Promise.resolve(server.stop(true)).catch(() => {}),
      new Promise<void>((resolve) => {
        stopTimer = setTimeout(resolve, 200);
      }),
    ]);
    if (stopTimer !== null) {
      clearTimeout(stopTimer);
    }
  }
}

await runSfsWsDedupE2E();
