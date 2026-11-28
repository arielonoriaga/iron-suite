import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sanitizePersistedSession, type PersistedSession } from '../shared/session-store';

export const MAX_SESSION_FILE_BYTES = 512 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;

export function loadPersistedSession(filePath: string): PersistedSession | null {
  try {
    const lst = fs.lstatSync(filePath);
    if (lst.isSymbolicLink() || !lst.isFile()) {
      return null;
    }

    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
    const fd = fs.openSync(filePath, flags);
    try {
      const fst = fs.fstatSync(fd);
      if (!fst.isFile() || fst.size > MAX_SESSION_FILE_BYTES) {
        return null;
      }

      const chunks: Buffer[] = [];
      let totalBytes = 0;
      const chunkBuf = Buffer.allocUnsafe(READ_CHUNK_BYTES);

      while (true) {
        const bytesRead = fs.readSync(fd, chunkBuf, 0, chunkBuf.length, null);
        if (bytesRead === 0) break;
        totalBytes += bytesRead;
        if (totalBytes > MAX_SESSION_FILE_BYTES) {
          return null;
        }
        chunks.push(Buffer.from(chunkBuf.subarray(0, bytesRead)));
      }

      const raw = Buffer.concat(chunks, totalBytes).toString('utf8');
      const parsed: unknown = JSON.parse(raw);
      return sanitizePersistedSession(parsed);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

export function savePersistedSession(filePath: string, session: PersistedSession): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  try {
    const existing = fs.lstatSync(filePath);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new Error('Refusing to overwrite non-regular session file');
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      throw err;
    }
  }

  const tmpPath = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  const payload = `${JSON.stringify(session, null, 2)}\n`;
  let createdTmp = false;

  try {
    fs.writeFileSync(tmpPath, payload, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    createdTmp = true;
    fs.chmodSync(tmpPath, 0o600);
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    if (createdTmp) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // Ignore cleanup errors after failed write/rename.
      }
    }
    throw err;
  }
}
