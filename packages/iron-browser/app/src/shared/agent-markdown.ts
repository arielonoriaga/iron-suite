export type CodeTokenKind =
  | 'plain'
  | 'keyword'
  | 'string'
  | 'comment'
  | 'number'
  | 'type'
  | 'function'
  | 'property'
  | 'operator'
  | 'tag'
  | 'diff-add'
  | 'diff-del'
  | 'diff-hunk';

export interface CodeToken {
  kind: CodeTokenKind;
  text: string;
}

export interface AnsiStyle {
  fg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
}

export interface AnsiSpan {
  text: string;
  style: AnsiStyle;
}

export type InlineToken =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'bold'; children: InlineToken[] }
  | { type: 'italic'; children: InlineToken[] }
  | { type: 'strike'; children: InlineToken[] }
  | { type: 'link'; label: string; href: string };

export type ListItemMarker = 'bullet' | 'ordered' | 'task-done' | 'task-open' | 'task-active';

export interface ListItemNode {
  indent: number;
  marker: ListItemMarker;
  orderLabel?: string;
  tokens: InlineToken[];
}

export type TranscriptBlock =
  | { type: 'heading'; level: 1 | 2 | 3 | 4; tokens: InlineToken[] }
  | { type: 'code'; lang: string; code: string; closed: boolean }
  | { type: 'blockquote'; lines: InlineToken[][] }
  | { type: 'list'; items: ListItemNode[] }
  | { type: 'table'; headers: InlineToken[][]; rows: InlineToken[][][] }
  | { type: 'hr' }
  | { type: 'diff-line'; kind: 'add' | 'del' | 'hunk'; text: string }
  | { type: 'ansi-line'; spans: AnsiSpan[] }
  | { type: 'paragraph'; lines: Array<{ tokens: InlineToken[]; status?: 'pass' | 'fail' | 'info' }> };

const ANSI_STANDARD_COLORS: readonly string[] = [
  '#475569', // 30 black (lifted for dark background readability)
  '#f87171', // 31 red
  '#4ade80', // 32 green
  '#facc15', // 33 yellow
  '#60a5fa', // 34 blue
  '#c084fc', // 35 magenta
  '#2dd4bf', // 36 cyan
  '#e2e8f0', // 37 white
];

const ANSI_BRIGHT_COLORS: readonly string[] = [
  '#64748b', // 90 bright black
  '#fca5a5', // 91 bright red
  '#86efac', // 92 bright green
  '#fde047', // 93 bright yellow
  '#93c5fd', // 94 bright blue
  '#d8b4fe', // 95 bright magenta
  '#5eead4', // 96 bright cyan
  '#f8fafc', // 97 bright white
];

const ANSI_SGR_RE = /\x1b\[([0-9:;]*)m/g;

// Strip ALL ECMA-48 escape sequences (OSC, DCS/APC/PM/SOS, CSI with full parameter bytes,
// charset designators like \x1b(B, and remaining 2-byte ESC codes excluding '[' and ']').
const ALL_ANSI_ESCAPE_RE =
  /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*(?:\x1b\\|\x07)|\x1b\[[0-9:;<=>?]*[ -/]*[@-~]|\x1b[()*+\-./][0-9A-Za-z]|\x1b[@-Z\\^_]/g;

// Strip everything EXCEPT genuine SGR sequences (\x1b\[[0-9:;]*m).
// Explicitly strips private/intermediate-prefixed 'm' (e.g. \x1b[>4;2m), non-'m' CSI (e.g. \x1b[=5u),
// OSC, DCS/APC/PM/SOS, charset designators (\x1b(B), and 2-byte ESC codes.
const NON_SGR_ESCAPE_RE =
  /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*(?:\x1b\\|\x07)|\x1b\[[<=>?][0-9:;<=>?]*[ -/]*[@-~]|\x1b\[[0-9:;<=>?]*[ -/]*[@-ln-~]|\x1b\[[0-9:;]*[ -/]+m|\x1b[()*+\-./][0-9A-Za-z]|\x1b[@-Z\\^_]/g;

/**
 * Strictly O(N) linear carriage-return resolver.
 * - Normalizes CRLF to LF (including repeated CR like \r\r\n).
 * - Resolves terminal spinner overwrites ("10%\r20%" -> "20%") without erasing trailing '\r'
 *   before a streaming chunk arrives.
 * - Preserves SGR color codes emitted in overwritten prefixes when preserveSgr=true.
 */
function applyCarriageReturns(input: string, preserveSgr: boolean): string {
  if (!input.includes('\r')) return input;
  const lines = input.replace(/\r\n/g, '\n').split('\n');
  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx]!;
    if (!line.includes('\r')) continue;
    const parts = line.split('\r');
    let lastNonEmpty = -1;
    for (let p = parts.length - 1; p >= 0; p -= 1) {
      if (parts[p]!.length > 0) {
        lastNonEmpty = p;
        break;
      }
    }
    if (lastNonEmpty < 0) {
      lines[idx] = '';
    } else if (!preserveSgr) {
      lines[idx] = parts[lastNonEmpty]!;
    } else {
      let prefixSgr = '';
      for (let p = 0; p < lastNonEmpty; p += 1) {
        const seg = parts[p]!;
        if (seg.includes('\x1b[')) {
          const matches = seg.match(ANSI_SGR_RE);
          if (matches) prefixSgr += matches.join('');
        }
      }
      lines[idx] = prefixSgr + parts[lastNonEmpty]!;
    }
  }
  return lines.join('\n');
}

export function stripAnsiAll(input: string): string {
  const stripped = input.replace(ALL_ANSI_ESCAPE_RE, '');
  return applyCarriageReturns(stripped, false);
}

function normalizeCarriageReturnsPreserveSgr(input: string): string {
  const cleaned = input.replace(NON_SGR_ESCAPE_RE, '');
  return applyCarriageReturns(cleaned, true);
}

function ansi256ToHex(code: number): string | undefined {
  if (!Number.isInteger(code) || code < 0 || code > 255) return undefined;
  if (code < 8) return ANSI_STANDARD_COLORS[code];
  if (code < 16) return ANSI_BRIGHT_COLORS[code - 8];
  if (code < 232) {
    const idx = code - 16;
    const r = Math.floor(idx / 36);
    const g = Math.floor((idx % 36) / 6);
    const b = idx % 6;
    const steps = [0, 95, 135, 175, 215, 255];
    return `rgb(${steps[r]}, ${steps[g]}, ${steps[b]})`;
  }
  const gray = 8 + (code - 232) * 10;
  return `rgb(${gray}, ${gray}, ${gray})`;
}

function applyColonExtendedColor(parts: string[], style: AnsiStyle): void {
  const lead = Number.parseInt(parts[0] || '0', 10);
  // Only apply foreground (38); consume/ignore background (48) and underline (58) safely.
  if (lead !== 38) return;
  const mode = Number.parseInt(parts[1] || '0', 10);
  if (mode === 5 && parts[2] !== undefined) {
    const col = ansi256ToHex(Number.parseInt(parts[2] || '0', 10));
    if (col) style.fg = col;
  } else if (mode === 2) {
    // ITU T.416 allows either 38:2:R:G:B or 38:2:<colorspace>:R:G:B
    const offset = parts.length >= 6 ? 3 : 2;
    if (parts[offset + 2] !== undefined) {
      const r = Math.max(0, Math.min(255, Number.parseInt(parts[offset] || '0', 10) || 0));
      const g = Math.max(0, Math.min(255, Number.parseInt(parts[offset + 1] || '0', 10) || 0));
      const b = Math.max(0, Math.min(255, Number.parseInt(parts[offset + 2] || '0', 10) || 0));
      style.fg = `rgb(${r}, ${g}, ${b})`;
    }
  }
}

export function parseAnsiLine(line: string, initialStyle: AnsiStyle = {}): {
  spans: AnsiSpan[];
  endStyle: AnsiStyle;
} {
  const spans: AnsiSpan[] = [];
  let style: AnsiStyle = { ...initialStyle };
  let lastIndex = 0;
  ANSI_SGR_RE.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = ANSI_SGR_RE.exec(line)) !== null) {
    if (match.index > lastIndex) {
      spans.push({ text: line.slice(lastIndex, match.index), style: { ...style } });
    }
    const rawParams = match[1] ?? '';
    const rawTokens = rawParams === '' ? ['0'] : rawParams.split(';');
    for (let i = 0; i < rawTokens.length; i += 1) {
      const token = rawTokens[i]!;
      if (token.includes(':')) {
        applyColonExtendedColor(token.split(':'), style);
        continue;
      }
      const c = Number.parseInt(token || '0', 10);
      if (!Number.isFinite(c)) continue;

      if (c === 0) {
        style = {};
      } else if (c === 1) {
        style.bold = true;
      } else if (c === 2) {
        style.dim = true;
      } else if (c === 3) {
        style.italic = true;
      } else if (c === 4) {
        style.underline = true;
      } else if (c === 9) {
        style.strike = true;
      } else if (c === 22) {
        style.bold = false;
        style.dim = false;
      } else if (c === 23) {
        style.italic = false;
      } else if (c === 24) {
        style.underline = false;
      } else if (c === 29) {
        style.strike = false;
      } else if (c === 39) {
        delete style.fg;
      } else if (c >= 30 && c <= 37) {
        style.fg = ANSI_STANDARD_COLORS[c - 30];
      } else if (c >= 90 && c <= 97) {
        style.fg = ANSI_BRIGHT_COLORS[c - 90];
      } else if (c === 38 || c === 48 || c === 58) {
        const sub = Number.parseInt(rawTokens[i + 1] || '', 10);
        if (sub === 5 && rawTokens[i + 2] !== undefined) {
          if (c === 38) {
            const col = ansi256ToHex(Number.parseInt(rawTokens[i + 2] || '0', 10));
            if (col) style.fg = col;
          }
          i += 2;
        } else if (sub === 2 && rawTokens[i + 4] !== undefined) {
          if (c === 38) {
            const r = Math.max(0, Math.min(255, Number.parseInt(rawTokens[i + 2] || '0', 10) || 0));
            const g = Math.max(0, Math.min(255, Number.parseInt(rawTokens[i + 3] || '0', 10) || 0));
            const b = Math.max(0, Math.min(255, Number.parseInt(rawTokens[i + 4] || '0', 10) || 0));
            style.fg = `rgb(${r}, ${g}, ${b})`;
          }
          i += 4;
        }
      }
    }
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < line.length) {
    spans.push({ text: line.slice(lastIndex), style: { ...style } });
  }
  return { spans, endStyle: style };
}

export function parseAnsiTranscript(raw: string): AnsiSpan[][] {
  const normalized = normalizeCarriageReturnsPreserveSgr(raw);
  const rawLines = normalized.split('\n');
  const out: AnsiSpan[][] = [];
  let carryStyle: AnsiStyle = {};
  for (const line of rawLines) {
    const parsed = parseAnsiLine(line, carryStyle);
    carryStyle = parsed.endStyle;
    out.push(parsed.spans);
  }
  return out;
}

export function isSafeDisplayHref(rawUrl: string): boolean {
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.length > 2048) return false;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function findMatchingBacktickRun(text: string, start: number, runLen: number): number {
  let i = start;
  const len = text.length;
  while (i < len) {
    if (text[i] === '`') {
      let j = i;
      while (j < len && text[j] === '`') j += 1;
      if (j - i === runLen) {
        return i;
      }
      i = j;
      continue;
    }
    i += 1;
  }
  return -1;
}

export function parseInlineMarkdown(text: string, depth = 0): InlineToken[] {
  if (!text) return [];
  if (depth > 4) return [{ type: 'text', text }];

  const tokens: InlineToken[] = [];
  let buf = '';
  const flush = () => {
    if (buf.length > 0) {
      tokens.push({ type: 'text', text: buf });
      buf = '';
    }
  };

  let i = 0;
  const len = text.length;
  while (i < len) {
    const ch = text[i]!;

    // Escaped markdown punctuation
    if (ch === '\\' && i + 1 < len && '\\`*_~[]()|'.includes(text[i + 1]!)) {
      buf += text[i + 1]!;
      i += 2;
      continue;
    }

    // Inline code: single or multi-backtick runs (`code`, `` `code` ``)
    if (ch === '`') {
      let runEnd = i;
      while (runEnd < len && text[runEnd] === '`') runEnd += 1;
      const runLen = runEnd - i;
      const closeIdx = findMatchingBacktickRun(text, runEnd, runLen);
      if (closeIdx > runEnd) {
        flush();
        let codeContent = text.slice(runEnd, closeIdx);
        if (
          codeContent.length >= 2 &&
          codeContent.startsWith(' ') &&
          codeContent.endsWith(' ') &&
          codeContent.trim().length > 0
        ) {
          codeContent = codeContent.slice(1, -1);
        }
        tokens.push({ type: 'code', text: codeContent });
        i = closeIdx + runLen;
        continue;
      }
      buf += text.slice(i, runEnd);
      i = runEnd;
      continue;
    }

    // Link: [label](url)
    if (ch === '[') {
      const closeBracket = text.indexOf(']', i + 1);
      if (closeBracket > i + 1 && text[closeBracket + 1] === '(') {
        const closeParen = text.indexOf(')', closeBracket + 2);
        if (closeParen > closeBracket + 2) {
          const label = text.slice(i + 1, closeBracket);
          const href = text.slice(closeBracket + 2, closeParen).trim();
          if (isSafeDisplayHref(href)) {
            flush();
            tokens.push({ type: 'link', label, href });
            i = closeParen + 1;
            continue;
          }
        }
      }
    }

    // Bold + Italic: ***...***
    if (ch === '*' && text[i + 1] === '*' && text[i + 2] === '*') {
      const end = text.indexOf('***', i + 3);
      if (end > i + 3 && text[i + 3] !== ' ' && text[end - 1] !== ' ') {
        flush();
        tokens.push({
          type: 'bold',
          children: [
            {
              type: 'italic',
              children: parseInlineMarkdown(text.slice(i + 3, end), depth + 1),
            },
          ],
        });
        i = end + 3;
        continue;
      }
    }

    // Bold: **...** or __...__
    if ((ch === '*' && text[i + 1] === '*') || (ch === '_' && text[i + 1] === '_')) {
      const delim = ch + ch;
      const end = text.indexOf(delim, i + 2);
      if (end > i + 2 && text[i + 2] !== ' ' && text[end - 1] !== ' ') {
        flush();
        tokens.push({
          type: 'bold',
          children: parseInlineMarkdown(text.slice(i + 2, end), depth + 1),
        });
        i = end + 2;
        continue;
      }
    }

    // Strikethrough: ~~...~~
    if (ch === '~' && text[i + 1] === '~') {
      const end = text.indexOf('~~', i + 2);
      if (end > i + 2 && text[i + 2] !== ' ' && text[end - 1] !== ' ') {
        flush();
        tokens.push({
          type: 'strike',
          children: parseInlineMarkdown(text.slice(i + 2, end), depth + 1),
        });
        i = end + 2;
        continue;
      }
    }

    // Italic: *...*
    if (ch === '*' && text[i + 1] !== '*' && text[i + 1] !== ' ') {
      const end = text.indexOf('*', i + 1);
      if (end > i + 1 && text[end - 1] !== ' ' && text[end + 1] !== '*') {
        flush();
        tokens.push({
          type: 'italic',
          children: parseInlineMarkdown(text.slice(i + 1, end), depth + 1),
        });
        i = end + 1;
        continue;
      }
    }

    buf += ch;
    i += 1;
  }

  flush();
  return tokens;
}

const JS_TS_KEYWORDS = new Set([
  'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue',
  'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally',
  'for', 'from', 'function', 'if', 'implements', 'import', 'in', 'instanceof',
  'interface', 'let', 'new', 'null', 'of', 'private', 'protected', 'public',
  'readonly', 'return', 'static', 'super', 'switch', 'this', 'throw', 'true',
  'try', 'type', 'typeof', 'undefined', 'var', 'void', 'while', 'yield',
]);

const RUST_KEYWORDS = new Set([
  'as', 'async', 'await', 'break', 'const', 'continue', 'crate', 'dyn', 'else',
  'enum', 'extern', 'false', 'fn', 'for', 'if', 'impl', 'in', 'let', 'loop',
  'match', 'mod', 'move', 'mut', 'pub', 'ref', 'return', 'self', 'Self', 'static',
  'struct', 'super', 'trait', 'true', 'type', 'unsafe', 'use', 'where', 'while',
]);

const PYTHON_KEYWORDS = new Set([
  'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def',
  'del', 'elif', 'else', 'except', 'False', 'finally', 'for', 'from', 'global',
  'if', 'import', 'in', 'is', 'lambda', 'None', 'nonlocal', 'not', 'or', 'pass',
  'raise', 'return', 'True', 'try', 'while', 'with', 'yield',
]);

const SHELL_KEYWORDS = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'for', 'in', 'do', 'done', 'while', 'case',
  'esac', 'function', 'local', 'export', 'return', 'exit', 'true', 'false',
  'cd', 'echo', 'printf', 'grep', 'rg', 'fd', 'sed', 'awk', 'curl', 'git',
  'bun', 'npm', 'pnpm', 'cargo', 'rustc', 'python3', 'node', 'ssh', 'tmux', 'sudo',
]);

const SQL_KEYWORDS = new Set([
  'select', 'from', 'where', 'join', 'left', 'right', 'inner', 'outer', 'on',
  'group', 'by', 'order', 'having', 'limit', 'offset', 'insert', 'into', 'values',
  'update', 'set', 'delete', 'create', 'table', 'index', 'alter', 'drop', 'as',
  'and', 'or', 'not', 'in', 'is', 'null', 'true', 'false', 'distinct', 'returning',
]);

const EMPTY_KEYWORDS = new Set<string>();

const GENERAL_KEYWORDS = new Set([
  ...JS_TS_KEYWORDS,
  ...RUST_KEYWORDS,
  ...PYTHON_KEYWORDS,
]);

export function normalizeCodeLanguage(raw: string): string {
  const clean = raw.trim().toLowerCase().replace(/[^a-z0-9_+-]/g, '');
  const aliases: Record<string, string> = {
    ts: 'typescript',
    tsx: 'tsx',
    js: 'javascript',
    jsx: 'jsx',
    rs: 'rust',
    py: 'python',
    sh: 'bash',
    shell: 'bash',
    zsh: 'bash',
    yml: 'yaml',
    patch: 'diff',
  };
  return aliases[clean] ?? (clean || 'text');
}

function getKeywordSet(lang: string): Set<string> {
  switch (lang) {
    case 'typescript':
    case 'tsx':
    case 'javascript':
    case 'jsx':
      return JS_TS_KEYWORDS;
    case 'rust':
      return RUST_KEYWORDS;
    case 'python':
      return PYTHON_KEYWORDS;
    case 'bash':
      return SHELL_KEYWORDS;
    case 'sql':
      return SQL_KEYWORDS;
    case 'json':
      return new Set(['true', 'false', 'null']);
    case 'html':
    case 'xml':
      return EMPTY_KEYWORDS;
    default:
      return GENERAL_KEYWORDS;
  }
}

export function tokenizeCodeLine(line: string, rawLang: string): CodeToken[] {
  if (!line) return [];
  const lang = normalizeCodeLanguage(rawLang);

  if (lang === 'diff') {
    if (line.startsWith('@@')) return [{ kind: 'diff-hunk', text: line }];
    if (line.startsWith('+') && !line.startsWith('+++')) return [{ kind: 'diff-add', text: line }];
    if (line.startsWith('-') && !line.startsWith('---')) return [{ kind: 'diff-del', text: line }];
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ')) {
      return [{ kind: 'keyword', text: line }];
    }
    return [{ kind: 'plain', text: line }];
  }

  if (lang === 'text') {
    return [{ kind: 'plain', text: line }];
  }

  const keywords = getKeywordSet(lang);
  const hashComment = lang === 'python' || lang === 'bash' || lang === 'yaml' || lang === 'toml';
  const sqlComment = lang === 'sql';
  const slashComment = !hashComment && !sqlComment && lang !== 'html' && lang !== 'xml';

  const tokens: CodeToken[] = [];
  const push = (kind: CodeTokenKind, text: string) => {
    if (!text) return;
    const prev = tokens[tokens.length - 1];
    if (prev && prev.kind === kind) {
      prev.text += text;
    } else {
      tokens.push({ kind, text });
    }
  };

  let i = 0;
  const n = line.length;
  while (i < n) {
    const ch = line[i]!;

    // Whitespace
    if (ch === ' ' || ch === '\t') {
      let j = i + 1;
      while (j < n && (line[j] === ' ' || line[j] === '\t')) j += 1;
      push('plain', line.slice(i, j));
      i = j;
      continue;
    }

    // Line comments
    if (slashComment && ch === '/' && line[i + 1] === '/') {
      push('comment', line.slice(i));
      break;
    }
    if (hashComment && ch === '#') {
      push('comment', line.slice(i));
      break;
    }
    if (sqlComment && ch === '-' && line[i + 1] === '-') {
      push('comment', line.slice(i));
      break;
    }
    if (slashComment && ch === '/' && line[i + 1] === '*') {
      const end = line.indexOf('*/', i + 2);
      if (end >= 0) {
        push('comment', line.slice(i, end + 2));
        i = end + 2;
      } else {
        push('comment', line.slice(i));
        break;
      }
      continue;
    }

    // HTML/XML comments & tags
    if ((lang === 'html' || lang === 'xml') && ch === '<') {
      if (line.startsWith('<!--', i)) {
        const end = line.indexOf('-->', i + 4);
        if (end >= 0) {
          push('comment', line.slice(i, end + 3));
          i = end + 3;
        } else {
          push('comment', line.slice(i));
          break;
        }
        continue;
      }
      const tagMatch = /^<\/?[A-Za-z][A-Za-z0-9:-]*/.exec(line.slice(i));
      if (tagMatch) {
        push('tag', tagMatch[0]);
        i += tagMatch[0].length;
        continue;
      }
    }

    // Rust char literals vs lifetimes ('a, 'static)
    if (lang === 'rust' && ch === "'") {
      const charMatch = /^'(?:\\(?:x[0-9a-fA-F]{2}|u\{[0-9a-fA-F_]+\}|.)|[^'\\])'/.exec(line.slice(i));
      if (charMatch) {
        push('string', charMatch[0]);
        i += charMatch[0].length;
        continue;
      }
      const lifeMatch = /^'[A-Za-z_][A-Za-z0-9_]*/.exec(line.slice(i));
      if (lifeMatch) {
        push('type', lifeMatch[0]);
        i += lifeMatch[0].length;
        continue;
      }
    }

    // Strings
    if (ch === '"' || (ch === "'" && lang !== 'rust') || (ch === '`' && lang !== 'sql')) {
      let j = i + 1;
      while (j < n) {
        if (line[j] === '\\' && j + 1 < n) {
          j += 2;
          continue;
        }
        if (line[j] === ch) {
          j += 1;
          break;
        }
        j += 1;
      }
      const literal = line.slice(i, j);
      // JSON property keys: "key":
      if (lang === 'json' && ch === '"') {
        let k = j;
        while (k < n && (line[k] === ' ' || line[k] === '\t')) k += 1;
        if (line[k] === ':') {
          push('property', literal);
          i = j;
          continue;
        }
      }
      push('string', literal);
      i = j;
      continue;
    }

    // Shell variables & flags
    if (lang === 'bash' && ch === '$') {
      const varMatch = /^\$(?:\{[A-Za-z0-9_]+\}|[A-Za-z_][A-Za-z0-9_]*|[0-9?*@$#!-])/.exec(line.slice(i));
      if (varMatch) {
        push('property', varMatch[0]);
        i += varMatch[0].length;
        continue;
      }
    }
    if (lang === 'bash' && ch === '-' && (i === 0 || line[i - 1] === ' ')) {
      const flagMatch = /^--?[A-Za-z0-9][A-Za-z0-9_-]*/.exec(line.slice(i));
      if (flagMatch) {
        push('type', flagMatch[0]);
        i += flagMatch[0].length;
        continue;
      }
    }

    // Numbers
    if ((ch >= '0' && ch <= '9') || (ch === '.' && i + 1 < n && line[i + 1]! >= '0' && line[i + 1]! <= '9')) {
      const numMatch = /^(?:0x[0-9a-fA-F_]+|[0-9][0-9_]*(?:\.[0-9_]+)?(?:[eE][+-]?[0-9]+)?(?:px|ms|s|%|rem|em|u8|u16|u32|u64|usize|i32|i64|f32|f64)?)/.exec(
        line.slice(i),
      );
      if (numMatch) {
        push('number', numMatch[0]);
        i += numMatch[0].length;
        continue;
      }
    }

    // Identifiers, keywords, types, functions
    if ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || ch === '_' || ch === '@') {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_-]/.test(line[j]!)) {
        if (line[j] === '-' && lang !== 'css' && lang !== 'html' && lang !== 'bash') break;
        j += 1;
      }
      const word = line.slice(i, j);
      const lookup = lang === 'sql' ? word.toLowerCase() : word;
      if (keywords.has(lookup)) {
        push('keyword', word);
      } else if ((lang === 'html' || lang === 'xml') && line[j] === '=') {
        push('property', word);
      } else if (word.startsWith('@') || (lang !== 'html' && lang !== 'xml' && /^[A-Z][A-Za-z0-9_]*$/.test(word))) {
        push('type', word);
      } else if (lang !== 'html' && lang !== 'xml' && line[j] === '(') {
        push('function', word);
      } else if (lang === 'css' && line[j] === ':') {
        push('property', word);
      } else {
        push('plain', word);
      }
      i = j;
      continue;
    }

    // Operators / punctuation
    if ('=+-*/<>!&|?:{}[]();,.'.includes(ch)) {
      push('operator', ch);
      i += 1;
      continue;
    }

    push('plain', ch);
    i += 1;
  }

  return tokens;
}

function matchFenceOpen(line: string): { fenceChar: string; fenceLen: number; lang: string } | null {
  const m = /^\s{0,3}(`{3,}|~{3,})([^\n]*)$/.exec(line);
  if (!m) return null;
  const fence = m[1]!;
  const fenceChar = fence[0]!;
  const info = (m[2] ?? '').trim();
  // CommonMark: backtick fence info strings cannot contain backticks (prevents inline ```foo``` at line start).
  if (fenceChar === '`' && info.includes('`')) return null;
  const firstToken = info.split(/\s+/, 1)[0] ?? '';
  return {
    fenceChar,
    fenceLen: fence.length,
    lang: normalizeCodeLanguage(firstToken),
  };
}

function matchHeading(line: string): { level: 1 | 2 | 3 | 4; text: string } | null {
  const m = /^\s*(#{1,4})\s+(.*)$/.exec(line);
  if (!m) return null;
  let text = m[2]!.trimEnd();
  // Strip optional CommonMark closing hashes linearly without regex backtracking.
  let end = text.length;
  while (end > 0 && text[end - 1] === '#') end -= 1;
  if (end < text.length && end > 0 && (text[end - 1] === ' ' || text[end - 1] === '\t')) {
    text = text.slice(0, end).trimEnd();
  }
  text = text.trimStart();
  if (!text) return null;
  const level = Math.min(4, Math.max(1, m[1]!.length)) as 1 | 2 | 3 | 4;
  return { level, text };
}

function isHrLine(line: string): boolean {
  return /^\s*(?:[-*_]\s*){3,}$/.test(line) || /^\s*[─━═]{5,}\s*$/.test(line);
}

function isBlockquoteLine(line: string): boolean {
  return /^\s*>\s?/.test(line);
}

function isDiffHunkLine(line: string): boolean {
  return /^@@\s+-\d+/.test(line);
}

function isTableSeparatorLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes('|') || !trimmed.includes('-')) return false;
  const stripped = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  const cells = stripped.split('|');
  return cells.length >= 2 && cells.every((c) => /^\s*:?-{2,}:?\s*$/.test(c));
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim();
  const inner =
    (trimmed.startsWith('|') ? trimmed.slice(1) : trimmed).replace(/(?<!\\)\|$/, '');
  const cells: string[] = [];
  let cur = '';
  let inCode = false;
  let codeRun = 0;

  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i]!;
    if (ch === '\\' && inner[i + 1] === '|') {
      cur += '|';
      i += 1;
      continue;
    }
    if (ch === '`') {
      let j = i;
      while (j < inner.length && inner[j] === '`') j += 1;
      const run = j - i;
      if (!inCode) {
        inCode = true;
        codeRun = run;
      } else if (run === codeRun) {
        inCode = false;
        codeRun = 0;
      }
      cur += inner.slice(i, j);
      i = j - 1;
      continue;
    }
    if (ch === '|' && !inCode) {
      cells.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

function computeIndentLevel(ws: string): number {
  let spaces = 0;
  for (const ch of ws) {
    spaces += ch === '\t' ? 2 : 1;
  }
  return Math.min(2, Math.floor(spaces / 2));
}

function matchListItem(line: string): {
  indent: number;
  marker: ListItemMarker;
  orderLabel?: string;
  body: string;
} | null {
  const mTask = /^([ \t]*)[-*+•]\s+\[([ xX/])\]\s+(.*)$/.exec(line);
  if (mTask) {
    const state = mTask[2]!;
    const marker: ListItemMarker =
      state === 'x' || state === 'X'
        ? 'task-done'
        : state === '/'
          ? 'task-active'
          : 'task-open';
    return { indent: computeIndentLevel(mTask[1]!), marker, body: mTask[3]! };
  }

  const mBullet = /^([ \t]*)[-*+•]\s+(.*)$/.exec(line);
  if (mBullet) {
    return {
      indent: computeIndentLevel(mBullet[1]!),
      marker: 'bullet',
      body: mBullet[2]!,
    };
  }

  const mOrdered = /^([ \t]*)(\d+[.)])\s+(.*)$/.exec(line);
  if (mOrdered) {
    return {
      indent: computeIndentLevel(mOrdered[1]!),
      marker: 'ordered',
      orderLabel: mOrdered[2]!,
      body: mOrdered[3]!,
    };
  }

  return null;
}

function detectCliLineStatus(cleanLine: string): 'pass' | 'fail' | 'info' | undefined {
  const trimmed = cleanLine.trimStart();
  if (/^(?:✓|✔|\[PASS\]|PASS\b|●\s+PASS)/.test(trimmed)) return 'pass';
  if (/^(?:✗|✖|✘|\[FAIL\]|FAIL\b|error:|Error:)/.test(trimmed)) return 'fail';
  if (/^(?:●|▸|◉|○|▶|ℹ)\s/.test(trimmed)) return 'info';
  return undefined;
}

function hasMarkdownSyntax(line: string): boolean {
  return (
    line.includes('`') ||
    line.includes('**') ||
    line.includes('__') ||
    line.includes('~~') ||
    ((line.includes('](https://') || line.includes('](http://')) &&
      /\[[^[\]]+\]\(https?:\/\//.test(line))
  );
}

export function parseAgentTranscript(raw: string): TranscriptBlock[] {
  if (!raw || !raw.trim()) return [];

  const withSgr = normalizeCarriageReturnsPreserveSgr(raw);
  const rawLines = withSgr.split('\n');
  const cleanLines = rawLines.map((l) => l.replace(ANSI_SGR_RE, ''));

  const blocks: TranscriptBlock[] = [];
  let i = 0;
  let carryAnsiStyle: AnsiStyle = {};
  const total = cleanLines.length;

  const advanceAnsiCarry = (rawLine: string) => {
    if (rawLine.includes('\x1b[')) {
      carryAnsiStyle = parseAnsiLine(rawLine, carryAnsiStyle).endStyle;
    }
  };

  const isTableStartAt = (idx: number): boolean =>
    cleanLines[idx]!.includes('|') &&
    idx + 1 < total &&
    isTableSeparatorLine(cleanLines[idx + 1]!);

  const isAnsiOnlyLineAt = (idx: number): boolean =>
    rawLines[idx]!.includes('\x1b[') && !hasMarkdownSyntax(cleanLines[idx]!);

  while (i < total) {
    const clean = cleanLines[i]!;
    const rawLine = rawLines[i]!;
    const trimmed = clean.trim();

    if (trimmed.length === 0) {
      advanceAnsiCarry(rawLine);
      i += 1;
      continue;
    }

    // Fenced code block (closed or streaming unclosed)
    const fence = matchFenceOpen(clean);
    if (fence) {
      advanceAnsiCarry(rawLine);
      const codeLines: string[] = [];
      let closed = false;
      i += 1;
      while (i < total) {
        const closeLine = cleanLines[i]!;
        advanceAnsiCarry(rawLines[i]!);
        const closeMatch = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(closeLine);
        if (
          closeMatch &&
          closeMatch[1]![0] === fence.fenceChar &&
          closeMatch[1]!.length >= fence.fenceLen
        ) {
          closed = true;
          i += 1;
          break;
        }
        codeLines.push(closeLine);
        i += 1;
      }
      blocks.push({
        type: 'code',
        lang: fence.lang,
        code: codeLines.join('\n'),
        closed,
      });
      continue;
    }

    // Horizontal rule
    if (isHrLine(clean)) {
      advanceAnsiCarry(rawLine);
      blocks.push({ type: 'hr' });
      i += 1;
      continue;
    }

    // Heading (# .. ####)
    const heading = matchHeading(clean);
    if (heading) {
      advanceAnsiCarry(rawLine);
      blocks.push({
        type: 'heading',
        level: heading.level,
        tokens: parseInlineMarkdown(heading.text),
      });
      i += 1;
      continue;
    }

    // Markdown table
    if (isTableStartAt(i)) {
      advanceAnsiCarry(rawLine);
      advanceAnsiCarry(rawLines[i + 1]!);
      const headers = splitTableRow(clean).map((c) => parseInlineMarkdown(c));
      const rows: InlineToken[][][] = [];
      i += 2;
      while (i < total) {
        const rowClean = cleanLines[i]!;
        if (!rowClean.trim() || !rowClean.includes('|')) break;
        advanceAnsiCarry(rawLines[i]!);
        rows.push(splitTableRow(rowClean).map((c) => parseInlineMarkdown(c)));
        i += 1;
      }
      blocks.push({ type: 'table', headers, rows });
      continue;
    }

    // Blockquote (> ...)
    if (isBlockquoteLine(clean)) {
      const quoteLines: InlineToken[][] = [];
      while (i < total && isBlockquoteLine(cleanLines[i]!)) {
        advanceAnsiCarry(rawLines[i]!);
        const body = cleanLines[i]!.replace(/^\s*>\s?/, '');
        quoteLines.push(parseInlineMarkdown(body));
        i += 1;
      }
      blocks.push({ type: 'blockquote', lines: quoteLines });
      continue;
    }

    // List (bullet, ordered, task)
    if (matchListItem(clean)) {
      const items: ListItemNode[] = [];
      while (i < total) {
        const item = matchListItem(cleanLines[i]!);
        if (!item) break;
        advanceAnsiCarry(rawLines[i]!);
        items.push({
          indent: item.indent,
          marker: item.marker,
          orderLabel: item.orderLabel,
          tokens: parseInlineMarkdown(item.body),
        });
        i += 1;
      }
      blocks.push({ type: 'list', items });
      continue;
    }

    // Standalone unified diff hunk
    if (isDiffHunkLine(clean)) {
      advanceAnsiCarry(rawLine);
      blocks.push({ type: 'diff-line', kind: 'hunk', text: clean });
      i += 1;
      continue;
    }

    // ANSI-colored CLI output line (without explicit markdown syntax)
    if (isAnsiOnlyLineAt(i)) {
      const parsedAnsi = parseAnsiLine(rawLine, carryAnsiStyle);
      carryAnsiStyle = parsedAnsi.endStyle;
      blocks.push({ type: 'ansi-line', spans: parsedAnsi.spans });
      i += 1;
      continue;
    }

    // Paragraph (consecutive plain/markdown prose lines using exact same block predicates)
    const paraLines: Array<{ tokens: InlineToken[]; status?: 'pass' | 'fail' | 'info' }> = [];
    while (i < total) {
      const curClean = cleanLines[i]!;
      if (
        !curClean.trim() ||
        matchFenceOpen(curClean) !== null ||
        matchHeading(curClean) !== null ||
        isHrLine(curClean) ||
        isBlockquoteLine(curClean) ||
        isDiffHunkLine(curClean) ||
        matchListItem(curClean) !== null ||
        isTableStartAt(i) ||
        isAnsiOnlyLineAt(i)
      ) {
        break;
      }
      advanceAnsiCarry(rawLines[i]!);
      paraLines.push({
        tokens: parseInlineMarkdown(curClean),
        status: detectCliLineStatus(curClean),
      });
      i += 1;
    }
    if (paraLines.length > 0) {
      blocks.push({ type: 'paragraph', lines: paraLines });
    }
  }

  return blocks;
}
