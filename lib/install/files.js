import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

function existingFile(path) {
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`refusing to modify symlink: ${path}`);
  if (!stat.isFile()) throw new Error(`refusing to modify non-file: ${path}`);
  return { mode: stat.mode & 0o777 };
}

export function ensurePrivateDirectory(path) {
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`refusing to use symlink directory: ${path}`);
    if (!stat.isDirectory()) throw new Error(`refusing to use non-directory: ${path}`);
    return { created: false, mode: stat.mode & 0o777 };
  }

  let ancestor = dirname(path);
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  if (existsSync(ancestor)) {
    const stat = lstatSync(ancestor);
    if (stat.isSymbolicLink()) throw new Error(`refusing to create directory below symlink: ${ancestor}`);
    if (!stat.isDirectory()) throw new Error(`refusing to create directory below non-directory: ${ancestor}`);
  }

  const created = mkdirSync(path, { recursive: true, mode: 0o700 });
  if (created !== undefined) chmodSync(path, 0o700);
  return { created: created !== undefined, mode: lstatSync(path).mode & 0o777 };
}

export function atomicWrite(path, contents, { mode } = {}) {
  const metadata = existingFile(path);
  const directory = dirname(path);
  ensurePrivateDirectory(directory);
  const targetMode = mode ?? metadata?.mode ?? 0o600;
  const temporary = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let descriptor;
  try {
    descriptor = openSync(temporary, 'wx', targetMode);
    writeFileSync(descriptor, contents);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporary, targetMode);
    renameSync(temporary, path);
  } finally {
    if (descriptor != null) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}
