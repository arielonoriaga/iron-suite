import { describe, expect, spyOn, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MAX_HISTORY_ENTRIES,
  MAX_PERSISTED_TABS,
  MAX_PERSISTED_TITLE_LENGTH,
  MAX_PERSISTED_URL_LENGTH,
  capPersistedTabs,
  isPersistableHttpUrl,
  isPlaceholderTitle,
  recordHistoryEntry,
  removeHistoryEntry,
  sanitizePersistedSession,
  truncatePersistedTitle,
  updateHistoryTitle,
  type PersistedSession,
  type PersistedTab,
} from '../src/shared/session-store';
import { loadPersistedSession, savePersistedSession } from '../src/main/session-file';

describe('session-store short history', () => {
  test('only accepts http and https URLs', () => {
    expect(isPersistableHttpUrl('http://127.0.0.1:18382/?room=aviador')).toBe(true);
    expect(isPersistableHttpUrl('https://example.com/path')).toBe(true);
    expect(isPersistableHttpUrl('file:///home/dev/welcome.html')).toBe(false);
    expect(isPersistableHttpUrl('about:blank')).toBe(false);
    expect(isPersistableHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isPersistableHttpUrl('data:text/html,hi')).toBe(false);
  });

  test('deduplicates, orders by recency, suppresses <5s double-count, and caps at max', () => {
    let hist = recordHistoryEntry([], 'http://localhost:3000/a', 'Page A', 10_000);
    // Immediate duplicate navigation (<5s) refreshes timestamp without double-counting visitCount
    hist = recordHistoryEntry(hist, 'http://localhost:3000/a', undefined, 10_500);
    expect(hist.length).toBe(1);
    expect(hist[0]?.title).toBe('Page A');
    expect(hist[0]?.visitCount).toBe(1);

    hist = recordHistoryEntry(hist, 'http://localhost:3000/b', 'Page B', 20_000);
    hist = recordHistoryEntry(hist, 'http://localhost:3000/a', undefined, 30_000);
    expect(hist.map((h) => h.url)).toEqual([
      'http://localhost:3000/a',
      'http://localhost:3000/b',
    ]);
    expect(hist[0]?.visitCount).toBe(2);
    expect(hist[0]?.title).toBe('Page A');

    // Title update preserves order
    hist = updateHistoryTitle(hist, 'http://localhost:3000/b', 'Updated B');
    expect(hist[1]?.title).toBe('Updated B');

    // Remove single item
    hist = removeHistoryEntry(hist, 'http://localhost:3000/a');
    expect(hist.length).toBe(1);
    expect(hist[0]?.url).toBe('http://localhost:3000/b');

    // Cap at MAX_HISTORY_ENTRIES
    let many = hist;
    for (let i = 0; i < MAX_HISTORY_ENTRIES + 10; i++) {
      many = recordHistoryEntry(many, `http://localhost:4000/p/${i}`, `P${i}`, 50_000 + i * 10_000);
    }
    expect(many.length).toBe(MAX_HISTORY_ENTRIES);
    expect(many[0]?.url).toBe(`http://localhost:4000/p/${MAX_HISTORY_ENTRIES + 9}`);
  });
});

describe('session-store persistence & sanitization', () => {
  test('sanitizes invalid URLs, unknown presets, out-of-range bounds, and caps tabs', () => {
    const rawTabs = [
      {
        url: 'file:///etc/passwd',
        title: 'Bad',
        mode: 'dual',
      },
      {
        url: 'http://127.0.0.1:18382/?room=aviador',
        title: 'Origami Rush',
        mode: 'dual',
        mirror: true,
        session: 'shared',
        sleeping: false,
        portraitPresetId: 'nonexistent-preset',
        landscapePresetId: 'desktop-hd',
        devtoolsTarget: 'portrait',
        audioSource: 'landscape',
      },
      ...Array.from({ length: MAX_PERSISTED_TABS + 5 }, (_, i) => ({
        url: `https://example.com/${i}`,
        title: `Tab ${i}`,
        mode: 'single',
      })),
    ];

    const clean = sanitizePersistedSession({
      version: 1,
      savedAt: 12345,
      window: { x: 100, y: 50, width: 200, height: 100, maximized: true },
      railCollapsed: true,
      dockOpen: false,
      dockHeight: 99999,
      splitRatio: 0.99,
      theme: 'light',
      activeTabIndex: 999,
      tabs: rawTabs,
      history: [
        { url: 'javascript:alert(1)', title: 'XSS', visitedAt: 200, visitCount: 1 },
        { url: 'http://localhost:8080/one', title: 'One', visitedAt: 100, visitCount: 2 },
        { url: 'http://localhost:8080/two', title: 'Two', visitedAt: 300, visitCount: 1 },
      ],
    });

    expect(clean).not.toBeNull();
    expect(clean!.tabs.length).toBe(MAX_PERSISTED_TABS);
    expect(clean!.tabs[0]?.url).toBe('http://127.0.0.1:18382/?room=aviador');
    expect(clean!.tabs[0]?.portraitPresetId).toBe('iphone-15');
    expect(clean!.activeTabIndex).toBe(MAX_PERSISTED_TABS - 1);
    expect(clean!.window?.width).toBe(760);
    expect(clean!.window?.height).toBe(520);
    expect(clean!.window?.maximized).toBe(true);
    expect(clean!.splitRatio).toBeLessThanOrEqual(0.68);
    expect(clean!.history.map((h) => h.url)).toEqual([
      'http://localhost:8080/two',
      'http://localhost:8080/one',
    ]);
  });

  test('round-trips atomically to disk with 0600 permissions and ignores corrupt files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iron-browser-session-test-'));
    const file = path.join(dir, 'session-state.json');
    try {
      const sample: PersistedSession = {
        version: 1,
        savedAt: 1_700_000_000_000,
        window: { x: 20, y: 40, width: 1400, height: 900, maximized: false },
        railCollapsed: false,
        dockOpen: true,
        dockHeight: 280,
        splitRatio: 0.35,
        theme: 'dark',
        ecoMode: true,
        autoSleep: false,
        activeTabIndex: 0,
        tabs: [
          {
            url: 'http://127.0.0.1:18382/?room=aviador',
            title: 'Origami Rush',
            mode: 'dual',
            mirror: true,
            dedup: true,
            session: 'shared',
            sleeping: false,
            portraitPresetId: 'iphone-15',
            landscapePresetId: 'desktop-hd',
            devtoolsTarget: 'portrait',
            audioSource: 'landscape',
          },
        ],
        history: [
          {
            url: 'http://127.0.0.1:18382/?room=aviador',
            title: 'Origami Rush',
            visitedAt: 1_700_000_000_000,
            visitCount: 3,
          },
        ],
      };

      savePersistedSession(file, sample);
      const stat = fs.statSync(file);
      expect(stat.mode & 0o777).toBe(0o600);

      const loaded = loadPersistedSession(file);
      expect(loaded).toEqual(sample);

      fs.writeFileSync(file, '{corrupt json', 'utf8');
      expect(loadPersistedSession(file)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('R5 session-store & session-file security and edge cases', () => {
  test('isPersistableHttpUrl enforces 4096-char cap and rejects embedded credentials', () => {
    const base = 'https://example.com/';
    const exact4096 = `${base}${'a'.repeat(MAX_PERSISTED_URL_LENGTH - base.length)}`;
    const over4096 = `${base}${'a'.repeat(MAX_PERSISTED_URL_LENGTH - base.length + 1)}`;

    expect(exact4096.length).toBe(MAX_PERSISTED_URL_LENGTH);
    expect(isPersistableHttpUrl(exact4096)).toBe(true);
    expect(isPersistableHttpUrl(over4096)).toBe(false);
    expect(isPersistableHttpUrl('https://user:secret@example.com/path')).toBe(false);
    expect(isPersistableHttpUrl('http://admin@localhost:3000/')).toBe(false);

    const sanitized = sanitizePersistedSession({
      version: 1,
      tabs: [
        { url: 'https://user:pass@example.com/secret', title: 'Creds' },
        { url: over4096, title: 'TooLong' },
        { url: 'https://example.com/ok', title: 'Safe' },
      ],
      history: [
        { url: 'https://user:pass@example.com/secret', title: 'Creds', visitedAt: 100, visitCount: 1 },
        { url: over4096, title: 'TooLong', visitedAt: 200, visitCount: 1 },
        { url: 'https://example.com/ok', title: 'Safe', visitedAt: 300, visitCount: 1 },
      ],
    });
    expect(sanitized?.tabs.map((t) => t.url)).toEqual(['https://example.com/ok']);
    expect(sanitized?.history.map((h) => h.url)).toEqual(['https://example.com/ok']);
  });

  test('ignores placeholder titles before overwriting existing real titles', () => {
    expect(isPlaceholderTitle('IronBrowser')).toBe(true);
    expect(isPlaceholderTitle('IronBrowser — Ready')).toBe(true);
    expect(isPlaceholderTitle('https://example.com/app', 'https://example.com/app')).toBe(true);
    expect(isPlaceholderTitle('Real App Title', 'https://example.com/app')).toBe(false);

    let hist = recordHistoryEntry([], 'https://example.com/app', 'Real App Title', 10_000);
    hist = recordHistoryEntry(hist, 'https://example.com/app', 'IronBrowser', 20_000);
    expect(hist[0]?.title).toBe('Real App Title');

    hist = recordHistoryEntry(hist, 'https://example.com/app', 'IronBrowser — Ready', 30_000);
    expect(hist[0]?.title).toBe('Real App Title');

    hist = updateHistoryTitle(hist, 'https://example.com/app', 'IronBrowser');
    expect(hist[0]?.title).toBe('Real App Title');

    hist = updateHistoryTitle(hist, 'https://example.com/app', 'IronBrowser — Ready');
    expect(hist[0]?.title).toBe('Real App Title');

    const fresh = recordHistoryEntry([], 'https://example.com/fresh', 'IronBrowser — Ready', 40_000);
    expect(fresh[0]?.title).toBe('example.com/fresh');
  });

  test('truncates oversized titles, coerces single-mode portrait audio, and defaults autoSleep to false', () => {
    const longTitle = 'X'.repeat(200);
    expect(truncatePersistedTitle(longTitle).length).toBe(MAX_PERSISTED_TITLE_LENGTH);

    const sanitized = sanitizePersistedSession({
      version: 1,
      tabs: [
        {
          url: 'https://example.com/single',
          title: longTitle,
          mode: 'single',
          audioSource: 'portrait',
        },
        {
          url: 'https://example.com/single-muted',
          title: 'Muted',
          mode: 'single',
          audioSource: 'muted',
        },
        {
          url: 'https://example.com/dual',
          title: 'Dual',
          mode: 'dual',
          audioSource: 'portrait',
        },
      ],
    });

    expect(sanitized?.autoSleep).toBe(false);
    expect(sanitized?.tabs[0]?.title.length).toBe(MAX_PERSISTED_TITLE_LENGTH);
    expect(sanitized?.tabs[0]?.audioSource).toBe('landscape');
    expect(sanitized?.tabs[1]?.audioSource).toBe('muted');
    expect(sanitized?.tabs[2]?.audioSource).toBe('portrait');

    const withAutoSleep = sanitizePersistedSession({
      version: 1,
      autoSleep: true,
      tabs: [],
    });
    expect(withAutoSleep?.autoSleep).toBe(true);
  });

  test('capPersistedTabs preserves active tab even when index >= MAX_PERSISTED_TABS', () => {
    const tabs: PersistedTab[] = Array.from({ length: MAX_PERSISTED_TABS + 4 }, (_, i) => ({
      url: `https://example.com/tab/${i}`,
      title: `Tab ${i}`,
      mode: 'dual',
      mirror: true,
      dedup: true,
      session: 'shared',
      sleeping: false,
      portraitPresetId: 'iphone-15',
      landscapePresetId: 'desktop-hd',
      devtoolsTarget: 'portrait',
      audioSource: 'landscape',
    }));
    const activeIdx = MAX_PERSISTED_TABS + 2;
    const capped = capPersistedTabs(tabs, activeIdx, MAX_PERSISTED_TABS);
    expect(capped.tabs.length).toBe(MAX_PERSISTED_TABS);
    expect(capped.activeTabIndex).toBe(MAX_PERSISTED_TABS - 1);
    expect(capped.tabs[capped.activeTabIndex]?.url).toBe(`https://example.com/tab/${activeIdx}`);
  });

  test('session-file rejects symlinks, directories, and >512KB files, and unlinks tmp on error', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iron-browser-session-sec-'));
    try {
      const targetFile = path.join(dir, 'real.json');
      const sample = sanitizePersistedSession({
        version: 1,
        tabs: [{ url: 'https://example.com/1', title: 'One' }],
      })!;
      savePersistedSession(targetFile, sample);

      const symlinkPath = path.join(dir, 'link.json');
      fs.symlinkSync(targetFile, symlinkPath);
      expect(loadPersistedSession(symlinkPath)).toBeNull();
      expect(() => savePersistedSession(symlinkPath, sample)).toThrow();

      const subDir = path.join(dir, 'subdir');
      fs.mkdirSync(subDir);
      expect(loadPersistedSession(subDir)).toBeNull();
      expect(() => savePersistedSession(subDir, sample)).toThrow();
      const leftover = fs.readdirSync(dir).filter((f) => f.includes('.tmp-'));
      expect(leftover).toEqual([]);

      const oversizedPath = path.join(dir, 'oversized.json');
      const padding = 'x'.repeat(512 * 1024 + 64);
      fs.writeFileSync(oversizedPath, JSON.stringify({ version: 1, padding }), 'utf8');
      expect(loadPersistedSession(oversizedPath)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('src/shared/session-store.ts remains pure (no node:fs or node:path imports)', () => {
    const storePath = path.resolve(import.meta.dir, '../src/shared/session-store.ts');
    const source = fs.readFileSync(storePath, 'utf8');
    expect(source).not.toContain('node:fs');
    expect(source).not.toContain('node:path');
  });

  test('capPersistedTabs guards NaN and non-finite activeTabIndex without inserting undefined', () => {
    const makeTabs = (count: number): PersistedTab[] =>
      Array.from({ length: count }, (_, i) => ({
        url: `https://example.com/item/${i}`,
        title: `Item ${i}`,
        mode: 'dual',
        mirror: true,
        dedup: true,
        session: 'shared',
        sleeping: false,
        portraitPresetId: 'iphone-15',
        landscapePresetId: 'desktop-hd',
        devtoolsTarget: 'portrait',
        audioSource: 'landscape',
      }));

    for (const badIdx of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const small = capPersistedTabs(makeTabs(3), badIdx, 5);
      expect(small.activeTabIndex).toBe(0);
      expect(small.tabs.length).toBe(3);
      expect(small.tabs.every((t) => t !== undefined && typeof t.url === 'string')).toBe(true);

      const large = capPersistedTabs(makeTabs(10), badIdx, 5);
      expect(large.activeTabIndex).toBe(0);
      expect(large.tabs.length).toBe(5);
      expect(large.tabs.every((t) => t !== undefined && typeof t.url === 'string')).toBe(true);
    }
  });

  test('recordHistoryEntry & updateHistoryTitle ignore un-normalized raw URL passed as title', () => {
    expect(
      isPlaceholderTitle('https://example.com', 'https://example.com/', 'https://example.com'),
    ).toBe(true);

    let hist = recordHistoryEntry([], 'https://example.com/', 'Real Page Title', 1_000);
    hist = recordHistoryEntry(hist, 'https://example.com', 'https://example.com', 20_000);
    expect(hist[0]?.title).toBe('Real Page Title');

    hist = updateHistoryTitle(hist, 'https://example.com', 'https://example.com');
    expect(hist[0]?.title).toBe('Real Page Title');

    const fresh = recordHistoryEntry([], 'https://example.com', 'https://example.com', 30_000);
    expect(fresh[0]?.title).toBe('example.com');
  });

  test('savePersistedSession unlinks tmp file when renameSync fails', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iron-browser-session-rename-fail-'));
    const renameSpy = spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('EXDEV: simulated rename failure');
    });
    try {
      const targetFile = path.join(dir, 'session-state.json');
      const sample = sanitizePersistedSession({
        version: 1,
        tabs: [{ url: 'https://example.com/1', title: 'One' }],
      })!;
      expect(() => savePersistedSession(targetFile, sample)).toThrow(/EXDEV/);
      const leftover = fs.readdirSync(dir).filter((f) => f.includes('.tmp-'));
      expect(leftover).toEqual([]);
      expect(fs.existsSync(targetFile)).toBe(false);
    } finally {
      renameSpy.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('isPlaceholderTitle, recordHistoryEntry, and updateHistoryTitle detect asymmetric un-normalized URLs', () => {
    expect(isPlaceholderTitle('https://example.com', 'https://example.com/')).toBe(true);
    expect(isPlaceholderTitle('https://example.com/', 'https://example.com')).toBe(true);
    expect(
      isPlaceholderTitle('https://example.com:443/path', 'https://example.com/path'),
    ).toBe(true);
    expect(
      isPlaceholderTitle('https://example.com:443/path', undefined, 'https://example.com/path'),
    ).toBe(true);
    expect(
      isPlaceholderTitle('https://example.com/other', 'https://example.com/path'),
    ).toBe(false);

    let hist = recordHistoryEntry([], 'https://example.com/', 'Real Page Title', 1_000);
    hist = recordHistoryEntry(hist, 'https://example.com/', 'https://example.com', 20_000);
    expect(hist[0]?.title).toBe('Real Page Title');

    hist = updateHistoryTitle(hist, 'https://example.com/', 'https://example.com');
    expect(hist[0]?.title).toBe('Real Page Title');

    let pathHist = recordHistoryEntry([], 'https://example.com/path', 'Real Path Title', 1_000);
    pathHist = recordHistoryEntry(
      pathHist,
      'https://example.com/path',
      'https://example.com:443/path',
      20_000,
    );
    expect(pathHist[0]?.title).toBe('Real Path Title');

    pathHist = updateHistoryTitle(
      pathHist,
      'https://example.com/path',
      'https://example.com:443/path',
    );
    expect(pathHist[0]?.title).toBe('Real Path Title');
  });
});
