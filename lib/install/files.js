import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
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
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
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

export function backupFile(source, backupDirectory, name = basename(source)) {
  ensurePrivateDirectory(backupDirectory);
  if (!source || !existsSync(source)) return { path: null, existed: false, mode: null };
  const metadata = existingFile(source);
  const destination = join(backupDirectory, name);
  copyFileSync(source, destination);
  chmodSync(destination, metadata.mode);
  return { path: destination, existed: true, mode: metadata.mode };
}

export function restoreBackup(backup, destination) {
  if (!destination) return;
  if (!backup?.existed) {
    rmSync(destination, { force: true });
    return;
  }
  atomicWrite(destination, readFileSync(backup.path), { mode: backup.mode });
}
