import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  isSafeDisplayHref,
  normalizeCodeLanguage,
  parseAgentTranscript,
  parseAnsiLine,
  parseAnsiTranscript,
  parseInlineMarkdown,
  stripAnsiAll,
  tokenizeCodeLine,
} from '../src/shared/agent-markdown';

describe('Agent Chat Dock Markdown, Syntax Highlighting & ANSI Formatting', () => {
  test('parses headings, fenced code blocks (closed & streaming), lists, task items, blockquotes, tables, and hr', () => {
    const sample = [
      '# IronBrowser Report',
      '## Summary',
      'Fixed **critical** *UAF* with `setImmediate` and ~~old hack~~. See [Docs](https://example.com/docs).',
      '',
      '> Root cause confirmed under gdb',
      '> Zero crashes across 50s',
      '',
      '- [x] Add 8-edge float resize',
      '- [/] Format Markdown & code',
      '- [ ] Ship build',
      '  - Nested detail',
      '1. Step one',
      '2. Step two',
      '',
      '| File | Status |',
      '| --- | --- |',
      '| `layout.ts` | **PASS** |',
      '| `agent-dock.ts` | PASS |',
      '',
      '---',
      '```ts',
      'const count: number = 42; // ok',
      'export function run(x: string) {',
      '  return `hello ${x}`;',
      '}',
      '```',
      '',
      '```rust',
      'pub fn answer() -> usize {',
      '    42',
    ].join('\n');

    const blocks = parseAgentTranscript(sample);
    const kinds = blocks.map((b) => b.type);
    expect(kinds).toEqual([
      'heading',
      'heading',
      'paragraph',
      'blockquote',
      'list',
      'table',
      'hr',
      'code',
      'code',
    ]);

    expect(blocks[0]).toMatchObject({ type: 'heading', level: 1 });
    expect(blocks[1]).toMatchObject({ type: 'heading', level: 2 });

    const list = blocks[4]!;
    expect(list.type).toBe('list');
    if (list.type === 'list') {
      expect(list.items.map((it) => it.marker)).toEqual([
        'task-done',
        'task-active',
        'task-open',
        'bullet',
        'ordered',
        'ordered',
      ]);
      expect(list.items[3]!.indent).toBe(1);
    }

    const table = blocks[5]!;
    expect(table.type).toBe('table');
    if (table.type === 'table') {
      expect(table.headers.length).toBe(2);
      expect(table.rows.length).toBe(2);
    }

    const tsCode = blocks[7]!;
    expect(tsCode).toMatchObject({ type: 'code', lang: 'typescript', closed: true });
    const streamingRust = blocks[8]!;
    expect(streamingRust).toMatchObject({ type: 'code', lang: 'rust', closed: false });
  });

  test('inline markdown handles inline code isolation and rejects unsafe XSS link schemes', () => {
    expect(isSafeDisplayHref('https://example.com/a?b=1')).toBe(true);
    expect(isSafeDisplayHref('http://127.0.0.1:18382/')).toBe(true);
    expect(isSafeDisplayHref('javascript:alert(1)')).toBe(false);
    expect(isSafeDisplayHref('data:text/html,<script>alert(1)</script>')).toBe(false);
    expect(isSafeDisplayHref('file:///etc/passwd')).toBe(false);

    const safeInline = parseInlineMarkdown('Run `**not bold**` then [click](javascript:alert(1)) and [ok](https://iron.dev)');
    expect(safeInline.some((t) => t.type === 'code' && t.text === '**not bold**')).toBe(true);
    expect(safeInline.some((t) => t.type === 'link' && t.href === 'https://iron.dev')).toBe(true);
    expect(safeInline.some((t) => t.type === 'link' && t.href.startsWith('javascript:'))).toBe(false);
  });

  test('tokenizes TypeScript, Rust, JSON, Bash, SQL, HTML, and unified Diff lines accurately', () => {
    expect(normalizeCodeLanguage('TS')).toBe('typescript');
    expect(normalizeCodeLanguage('rs')).toBe('rust');
    expect(normalizeCodeLanguage('sh')).toBe('bash');
    expect(normalizeCodeLanguage('patch')).toBe('diff');

    const tsToks = tokenizeCodeLine('export const v: MyType = fn(42, "hi"); // note', 'ts');
    expect(tsToks.some((t) => t.kind === 'keyword' && t.text === 'export')).toBe(true);
    expect(tsToks.some((t) => t.kind === 'type' && t.text === 'MyType')).toBe(true);
    expect(tsToks.some((t) => t.kind === 'function' && t.text === 'fn')).toBe(true);
    expect(tsToks.some((t) => t.kind === 'number' && t.text === '42')).toBe(true);
    expect(tsToks.some((t) => t.kind === 'string' && t.text === '"hi"')).toBe(true);
    expect(tsToks.some((t) => t.kind === 'comment' && t.text === '// note')).toBe(true);

    const jsonToks = tokenizeCodeLine('  "status": "ok", "count": 3, "active": true', 'json');
    expect(jsonToks.some((t) => t.kind === 'property' && t.text === '"status"')).toBe(true);
    expect(jsonToks.some((t) => t.kind === 'string' && t.text === '"ok"')).toBe(true);
    expect(jsonToks.some((t) => t.kind === 'number' && t.text === '3')).toBe(true);
    expect(jsonToks.some((t) => t.kind === 'keyword' && t.text === 'true')).toBe(true);

    const bashToks = tokenizeCodeLine('git status --short $HOME # check', 'bash');
    expect(bashToks.some((t) => t.kind === 'keyword' && t.text === 'git')).toBe(true);
    expect(bashToks.some((t) => t.kind === 'type' && t.text === '--short')).toBe(true);
    expect(bashToks.some((t) => t.kind === 'property' && t.text === '$HOME')).toBe(true);
    expect(bashToks.some((t) => t.kind === 'comment' && t.text === '# check')).toBe(true);

    expect(tokenizeCodeLine('@@ -10,4 +10,5 @@', 'diff')[0]?.kind).toBe('diff-hunk');
    expect(tokenizeCodeLine('+added line', 'diff')[0]?.kind).toBe('diff-add');
    expect(tokenizeCodeLine('-removed line', 'diff')[0]?.kind).toBe('diff-del');

    const htmlToks = tokenizeCodeLine('<div class="box"><!-- hi --></div>', 'html');
    expect(htmlToks.some((t) => t.kind === 'tag' && t.text === '<div')).toBe(true);
    expect(htmlToks.some((t) => t.kind === 'comment' && t.text === '<!-- hi -->')).toBe(true);
  });

  test('preserves ANSI SGR styles (16-color, 256-color, truecolor, bold/dim) and handles carriage-return spinner overwrites', () => {
    const parsed = parseAnsiLine('\x1b[1;32mPASS\x1b[0m \x1b[38;2;20;184;166mteal\x1b[0m \x1b[2mdim\x1b[0m');
    expect(parsed.spans[0]).toMatchObject({ text: 'PASS', style: { bold: true, fg: '#4ade80' } });
    expect(parsed.spans[2]).toMatchObject({ text: 'teal', style: { fg: 'rgb(20, 184, 166)' } });
    expect(parsed.spans[4]).toMatchObject({ text: 'dim', style: { dim: true } });

    const spinner = 'Loading 10%\rLoading 100%\n\x1b[31mFAIL\x1b[0m';
    expect(stripAnsiAll(spinner)).toBe('Loading 100%\nFAIL');
    const rawLines = parseAnsiTranscript(spinner);
    expect(rawLines.length).toBe(2);
    expect(rawLines[0]![0]?.text).toBe('Loading 100%');
    expect(rawLines[1]![0]?.style.fg).toBe('#f87171');
  });

  test('renderer uses DOM nodes only (no innerHTML in transcript rendering) and exposes MD toggle & code styles', () => {
    const html = fs.readFileSync(path.resolve(import.meta.dir, '../src/renderer/agent-dock.html'), 'utf8');
    const css = fs.readFileSync(path.resolve(import.meta.dir, '../src/renderer/agent-dock.css'), 'utf8');
    const ts = fs.readFileSync(path.resolve(import.meta.dir, '../src/renderer/agent-dock.ts'), 'utf8');

    expect(html).toContain('id="btn-format-md"');
    expect(html).toContain('id="terminal-screen"');
    expect(css).toContain('.md-code-block');
    expect(css).toContain('.tok-keyword');
    expect(css).toContain('.md-copy-btn');
    // Ensure markdown/code renderer never assigns innerHTML (only empty clear on instanceList)
    const innerHtmlMatches = ts.match(/\.innerHTML\s*=/g) ?? [];
    expect(innerHtmlMatches.length).toBeLessThanOrEqual(1);
    expect(ts).toContain('renderFormattedMarkdown');
    expect(ts).toContain('renderRawAnsi');
    expect(ts).toContain('renderTranscriptNow(true)');
    expect(css).toContain('min-width: 100%');
    expect(css).toContain('width: max-content');
    expect(css).toContain('flex-shrink: 0');
  });

  test('regression: linear O(N) on 180KB single line, safe CR/SGR preservation, 48/58 bg consumption, private CSI, metadata fences, double-backticks, tables, Rust lifetimes, and carryAnsiStyle', () => {
    // 1. O(N) performance on 180KB single line + ReDoS adversarial heading/bracket inputs
    const bigLine = 'a'.repeat(180_000);
    const t0 = performance.now();
    expect(stripAnsiAll(bigLine).length).toBe(180_000);
    expect(parseAgentTranscript(bigLine).length).toBe(1);
    const evilHeading = `# a ${' '.repeat(40_000)}${'#'.repeat(40_000)}x`;
    expect(parseAgentTranscript(evilHeading)[0]).toMatchObject({ type: 'heading', level: 1 });
    const evilBrackets = '\x1b[0'.repeat(40_000);
    expect(parseAgentTranscript(evilBrackets).length).toBe(1);
    expect(parseAgentTranscript('# Title ##  ')[0]).toMatchObject({
      type: 'heading',
      level: 1,
      tokens: [{ type: 'text', text: 'Title' }],
    });
    expect(performance.now() - t0).toBeLessThan(250);

    // Trailing CR does not erase line; \r\r\n leaves no literal \r; SGR preserved across \r overwrite
    expect(stripAnsiAll('Building...\r')).toBe('Building...');
    expect(stripAnsiAll('foo\r\r\nbar')).toBe('foo\nbar');
    const crAnsi = parseAnsiTranscript('\x1b[32m10%\r20%\x1b[0m');
    expect(crAnsi[0]![0]).toMatchObject({ text: '20%', style: { fg: '#4ade80' } });

    // 2. 48;2 / 48;5 / 58;5 background & underline colors never corrupt foreground/styles
    const bgReset = parseAnsiLine('\x1b[32;48;2;0;40;0mAdded line\x1b[0m');
    expect(bgReset.spans[0]).toMatchObject({ text: 'Added line', style: { fg: '#4ade80' } });
    expect(bgReset.spans[0]?.style.dim).toBeUndefined();

    const bg256 = parseAnsiLine('\x1b[48;5;31m256 bg\x1b[0m');
    expect(bg256.spans[0]?.style.fg).toBeUndefined();

    const bgTrue = parseAnsiLine('\x1b[48;2;31;4;1mDark bg\x1b[0m');
    expect(bgTrue.spans[0]?.style).toEqual({});

    // Colon-separated truecolor SGR
    const colonFg = parseAnsiLine('\x1b[38:2::20:184:166mhi\x1b[0m');
    expect(colonFg.spans[0]).toMatchObject({ text: 'hi', style: { fg: 'rgb(20, 184, 166)' } });

    // 3. Private CSI (\x1b[=5u, \x1b[>4;2m), colon SGR, and charset switches (\x1b(B) cleanly stripped
    expect(stripAnsiAll('hi\x1b[=5u')).toBe('hi');
    expect(stripAnsiAll('hi\x1b[>4;2m')).toBe('hi');
    expect(stripAnsiAll('\x1b[38:2::20:184:166mhi\x1b[0m')).toBe('hi');
    expect(stripAnsiAll('hi\x1b(B\x1b[m')).toBe('hi');
    expect(parseAnsiTranscript('hi\x1b[=5u\x1b[>4;2m\x1b(B')[0]![0]?.text).toBe('hi');

    // 4. Fenced code block with metadata, inline triple-backticks at line start, # C#, ***bold italic***
    const metaDoc = [
      'Before',
      '```ts title="app.ts"',
      'const x = 1;',
      '```',
      'After',
      '```inline``` text',
      '# C#',
      'Use `` `foo` `` and ***both***',
    ].join('\n');
    const metaBlocks = parseAgentTranscript(metaDoc);
    expect(metaBlocks.map((b) => b.type)).toEqual([
      'paragraph',
      'code',
      'paragraph',
      'heading',
      'paragraph',
    ]);
    expect(metaBlocks[1]).toMatchObject({
      type: 'code',
      lang: 'typescript',
      code: 'const x = 1;',
      closed: true,
    });
    expect(metaBlocks[3]).toMatchObject({
      type: 'heading',
      level: 1,
      tokens: [{ type: 'text', text: 'C#' }],
    });
    const lastPara = metaBlocks[4]!;
    if (lastPara.type === 'paragraph') {
      const toks = lastPara.lines[0]!.tokens;
      expect(toks.some((t) => t.type === 'code' && t.text === '`foo`')).toBe(true);
      expect(toks.some((t) => t.type === 'bold' && t.children[0]?.type === 'italic')).toBe(true);
    }

    // 5. Table pipe inside inline code + escaped pipe + uneven row cells
    const tblBlocks = parseAgentTranscript(
      '| Expr | Desc |\n| --- | --- |\n| `a | b` | escaped \\| pipe |\n| only-one |',
    );
    expect(tblBlocks.length).toBe(1);
    const tbl = tblBlocks[0]!;
    expect(tbl.type).toBe('table');
    if (tbl.type === 'table') {
      expect(tbl.headers.length).toBe(2);
      expect(tbl.rows[0]!.length).toBe(2);
      expect(tbl.rows[0]![0]).toEqual([{ type: 'code', text: 'a | b' }]);
    }

    // 6. Rust lifetimes vs char literals & HTML non-keyword prose
    const rustToks = tokenizeCodeLine("pub fn foo<'a>(s: &'a str, c: 'x') -> &'static str", 'rust');
    expect(rustToks.some((t) => t.kind === 'type' && t.text === "'a")).toBe(true);
    expect(rustToks.some((t) => t.kind === 'type' && t.text === "'static")).toBe(true);
    expect(rustToks.some((t) => t.kind === 'string' && t.text === "'x'")).toBe(true);
    expect(rustToks.some((t) => t.kind === 'string' && t.text.includes('str'))).toBe(false);

    const htmlToks = tokenizeCodeLine('<p class="a">if for class</p>', 'html');
    expect(htmlToks.some((t) => t.kind === 'keyword')).toBe(false);
    expect(htmlToks.some((t) => t.kind === 'property' && t.text === 'class')).toBe(true);

    // 7. Tab-indented + bullet lists
    const listBlocks = parseAgentTranscript('+ top\n\t- nested');
    expect(listBlocks[0]).toMatchObject({ type: 'list' });
    if (listBlocks[0]!.type === 'list') {
      expect(listBlocks[0]!.items[1]?.indent).toBe(1);
    }

    // 8. carryAnsiStyle resets across markdown lines
    const carryBlocks = parseAgentTranscript('\x1b[31mError\n\x1b[0m**Fixed**\n\x1b[1mNext');
    expect(carryBlocks.map((b) => b.type)).toEqual(['ansi-line', 'paragraph', 'ansi-line']);
    const line3 = carryBlocks[2]!;
    if (line3.type === 'ansi-line') {
      expect(line3.spans[0]).toMatchObject({ text: 'Next', style: { bold: true } });
      expect(line3.spans[0]?.style.fg).toBeUndefined();
    }
  });
});
