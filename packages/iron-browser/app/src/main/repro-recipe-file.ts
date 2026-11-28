import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  MAX_RECIPE_FILE_BYTES,
  MAX_RECIPES,
  sanitizeRecipeName,
  validateReproRecipe,
  type ReproRecipe,
} from '../shared/repro-recipe';

const READ_CHUNK_BYTES = 16 * 1024;

function resolveSafeRecipePath(recipesDir: string, name: string): string {
  const safeName = sanitizeRecipeName(name);
  const root = path.resolve(recipesDir);
  const full = path.resolve(root, `${safeName}.json`);
  if (path.dirname(full) !== root) {
    throw new Error('Unsafe recipe path rejected');
  }
  return full;
}

function readBoundedRegularFileUtf8(filePath: string, maxBytes: number): string {
  const lst = fs.lstatSync(filePath);
  if (lst.isSymbolicLink() || !lst.isFile()) {
    throw new Error('Refusing to read non-regular or symlink recipe file');
  }

  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  const fd = fs.openSync(filePath, flags);
  try {
    const fst = fs.fstatSync(fd);
    if (!fst.isFile() || fst.size > maxBytes) {
      throw new Error(`Recipe file exceeds ${maxBytes} bytes or is not a regular file`);
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    const chunkBuf = Buffer.allocUnsafe(READ_CHUNK_BYTES);

    while (true) {
      const bytesRead = fs.readSync(fd, chunkBuf, 0, chunkBuf.length, null);
      if (bytesRead === 0) break;
      totalBytes += bytesRead;
      if (totalBytes > maxBytes) {
        throw new Error(`Recipe file exceeds ${maxBytes} bytes`);
      }
      chunks.push(Buffer.from(chunkBuf.subarray(0, bytesRead)));
    }

    return Buffer.concat(chunks, totalBytes).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

export function saveReproRecipeFile(recipesDir: string, recipe: ReproRecipe): string {
  fs.mkdirSync(recipesDir, { recursive: true, mode: 0o700 });
  const dirStat = fs.lstatSync(recipesDir);
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    throw new Error('Refusing to use symlink or non-directory recipes folder');
  }

  const filePath = resolveSafeRecipePath(recipesDir, recipe.name);
  let targetExists = false;
  try {
    const existingStat = fs.lstatSync(filePath);
    if (existingStat.isSymbolicLink() || !existingStat.isFile()) {
      throw new Error('Refusing to overwrite non-regular or symlink recipe file');
    }
    targetExists = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      throw err;
    }
  }

  if (!targetExists) {
    const existingCount = fs.readdirSync(recipesDir).filter((f) => f.endsWith('.json')).length;
    if (existingCount >= MAX_RECIPES) {
      throw new Error(`Maximum saved recipes (${MAX_RECIPES}) reached`);
    }
  }

  const serialized = `${JSON.stringify(recipe, null, 2)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_RECIPE_FILE_BYTES) {
    throw new Error('Serialized recipe exceeds 64KB cap');
  }

  const tmpPath = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  let createdTmp = false;
  try {
    fs.writeFileSync(tmpPath, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    createdTmp = true;
    fs.chmodSync(tmpPath, 0o600);
    fs.renameSync(tmpPath, filePath);
    return filePath;
  } catch (err) {
    if (createdTmp) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // Ignore cleanup failure after failed write/rename.
      }
    }
    throw err;
  }
}

export function loadReproRecipeFile(recipesDir: string, name: string): ReproRecipe {
  const filePath = resolveSafeRecipePath(recipesDir, name);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Recipe '${sanitizeRecipeName(name)}' not found`);
  }
  const rawText = readBoundedRegularFileUtf8(filePath, MAX_RECIPE_FILE_BYTES);
  const raw = JSON.parse(rawText) as unknown;
  return validateReproRecipe(raw);
}

export function listReproRecipesInDir(recipesDir: string): ReproRecipe[] {
  if (!fs.existsSync(recipesDir)) return [];
  try {
    const dst = fs.lstatSync(recipesDir);
    if (dst.isSymbolicLink() || !dst.isDirectory()) return [];
  } catch {
    return [];
  }
  const files = fs
    .readdirSync(recipesDir)
    .filter((f) => f.endsWith('.json'))
    .slice(0, MAX_RECIPES);
  const out: ReproRecipe[] = [];
  for (const file of files) {
    try {
      const full = path.resolve(recipesDir, file);
      if (path.dirname(full) !== path.resolve(recipesDir)) continue;
      const rawText = readBoundedRegularFileUtf8(full, MAX_RECIPE_FILE_BYTES);
      const parsed = validateReproRecipe(JSON.parse(rawText));
      out.push(parsed);
    } catch {
      // Skip malformed or unsafe files safely.
    }
  }
  out.sort((a, b) => b.savedAt - a.savedAt);
  return out;
}

export function deleteReproRecipeFile(recipesDir: string, name: string): boolean {
  const filePath = resolveSafeRecipePath(recipesDir, name);
  try {
    const st = fs.lstatSync(filePath);
    if (st.isSymbolicLink() || !st.isFile()) {
      throw new Error('Refusing to delete non-regular or symlink recipe file');
    }
    fs.unlinkSync(filePath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return false;
    }
    throw err;
  }
}
