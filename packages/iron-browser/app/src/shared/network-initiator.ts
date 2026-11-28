import { truncateUtf8 } from './frame';
import { redactMirrorUrl } from './mirror-core';
import type { NetworkInitiatorFrame, NetworkInitiatorInfo } from './types';

const MAX_INITIATOR_FRAMES = 24;
export const MAX_ASYNC_STACK_DEPTH = 8;

function sanitizeInitiatorUrl(rawUrl: unknown): string {
  const trimmed = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!trimmed) return '(internal)';
  if (/^data:/i.test(trimmed)) return 'data:[redacted]';
  const redacted = redactMirrorUrl(trimmed) ?? trimmed;
  return redacted.length > 512 ? truncateUtf8(redacted, 512).text : redacted;
}

export function extractNetworkInitiator(rawInitiator: unknown): NetworkInitiatorInfo | undefined {
  if (!rawInitiator || typeof rawInitiator !== 'object') return undefined;
  const init = rawInitiator as Record<string, unknown>;
  const type = typeof init.type === 'string' && init.type.trim() ? init.type.trim() : 'other';
  const topUrl =
    typeof init.url === 'string' && init.url.trim() ? sanitizeInitiatorUrl(init.url) : undefined;
  const topLine =
    typeof init.lineNumber === 'number' && Number.isFinite(init.lineNumber) && init.lineNumber >= 0
      ? Math.floor(init.lineNumber) + 1
      : undefined;
  const topCol =
    typeof init.columnNumber === 'number' &&
    Number.isFinite(init.columnNumber) &&
    init.columnNumber >= 0
      ? Math.floor(init.columnNumber) + 1
      : undefined;

  const frames: NetworkInitiatorFrame[] = [];
  let stackNode =
    init.stack && typeof init.stack === 'object'
      ? (init.stack as Record<string, unknown>)
      : null;
  let asyncDepth = 0;

  while (stackNode && frames.length < MAX_INITIATOR_FRAMES && asyncDepth <= MAX_ASYNC_STACK_DEPTH) {
    const isAsync = asyncDepth > 0;
    const asyncDescription =
      isAsync && typeof stackNode.description === 'string' && stackNode.description.trim()
        ? stackNode.description.trim().slice(0, 64)
        : isAsync
          ? 'async'
          : undefined;
    const rawFrames = Array.isArray(stackNode.callFrames) ? stackNode.callFrames : [];
    for (const rawCf of rawFrames) {
      if (frames.length >= MAX_INITIATOR_FRAMES) break;
      if (!rawCf || typeof rawCf !== 'object') continue;
      const cf = rawCf as Record<string, unknown>;
      const rawFn = typeof cf.functionName === 'string' ? cf.functionName.trim() : '';
      const functionName = rawFn.length > 0 ? rawFn.slice(0, 160) : '(anonymous)';
      const url = sanitizeInitiatorUrl(cf.url);
      const line =
        typeof cf.lineNumber === 'number' && Number.isFinite(cf.lineNumber) && cf.lineNumber >= 0
          ? Math.floor(cf.lineNumber) + 1
          : 0;
      const column =
        typeof cf.columnNumber === 'number' &&
        Number.isFinite(cf.columnNumber) &&
        cf.columnNumber >= 0
          ? Math.floor(cf.columnNumber) + 1
          : 0;
      const location = line > 0 ? `${url}:${line}:${column}` : url;
      frames.push({
        functionName,
        url,
        line,
        column,
        location,
        ...(isAsync ? { async: true } : {}),
        ...(asyncDescription ? { asyncDescription } : {}),
      });
    }
    const nextParent =
      stackNode.parent && typeof stackNode.parent === 'object'
        ? (stackNode.parent as Record<string, unknown>)
        : null;
    stackNode = nextParent;
    asyncDepth += 1;
  }

  return {
    type,
    ...(topUrl ? { url: topUrl } : {}),
    ...(topLine !== undefined ? { line: topLine } : {}),
    ...(topCol !== undefined ? { column: topCol } : {}),
    frames,
  };
}
