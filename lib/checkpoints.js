import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const CHECKPOINT_FILE = /^checkpoint-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/;
const LOCK_STALE_MS = 10 * 60_000;
let mutationQueue = Promise.resolve();

function safeCheckpointId(value) {
  const checkpointId = String(value || '');
  return /^[a-zA-Z0-9_-]{1,100}$/.test(checkpointId) ? checkpointId : null;
}

function ownerKey(userId) {
  return crypto.createHash('sha256').update(String(userId)).digest('hex');
}

function withMutationLock(operation) {
  const result = mutationQueue.then(operation, operation);
  mutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

function publicCheckpoint(document, filePath) {
  const { owner: _owner, ...checkpoint } = document;
  return { ...checkpoint, path: filePath };
}

function warn(onWarning, detail) {
  try { onWarning?.({ code: 'checkpoint_file_skipped', ...detail }); } catch {}
}

function validCheckpointDocument(document) {
  return Boolean(
    document && typeof document === 'object' && !Array.isArray(document) &&
    safeCheckpointId(document.checkpointId) &&
    /^[a-f0-9]{64}$/.test(document.owner || '') &&
    document.state && typeof document.state === 'object' && !Array.isArray(document.state) &&
    typeof document.createdAt === 'string'
  );
}

async function checkpointFiles(baseDir, { onWarning } = {}) {
  const directory = path.resolve(baseDir);
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  const checkpoints = [];
  for (const entry of entries) {
    const name = entry.name;
    if (!CHECKPOINT_FILE.test(name) || path.basename(name) !== name) continue;
    if (!entry.isFile()) {
      warn(onWarning, { filename: name, reason: 'not_regular_file' });
      continue;
    }
    const filePath = path.join(directory, name);
    try {
      // Names come from readdir and must match the server-generated UUID format above.
      const document = JSON.parse(await fs.readFile(filePath, 'utf8'));
      if (!validCheckpointDocument(document)) {
        warn(onWarning, { filename: name, reason: 'invalid_document' });
        continue;
      }
      checkpoints.push({ document, filePath });
    } catch (error) {
      warn(onWarning, {
        filename: name,
        reason: error instanceof SyntaxError ? 'invalid_json' : (error.code || 'read_failed'),
      });
    }
  }
  return checkpoints;
}

async function withNamedCheckpointLock(directory, owner, checkpointId, operation) {
  const lockId = crypto.createHash('sha256').update(`${owner}:${checkpointId}`).digest('hex');
  const lockPath = path.join(directory, `checkpoint-lock-${lockId}.lock`);
  let handle;
  try {
    handle = await fs.open(lockPath, 'wx', 0o600);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const stat = await fs.stat(lockPath).catch(() => null);
    if (stat && Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
      await fs.unlink(lockPath).catch(() => {});
      return withNamedCheckpointLock(directory, owner, checkpointId, operation);
    }
    throw Object.assign(new Error('checkpoint operation already in progress'), {
      statusCode: 409,
      code: 'checkpoint_locked',
    });
  }
  try {
    return await operation();
  } finally {
    await handle.close().catch(() => {});
    await fs.unlink(lockPath).catch(() => {});
  }
}

async function createCheckpoint({ baseDir, userId, context, checkpointId = `cp_${crypto.randomUUID()}`, metadata = {}, onWarning } = {}) {
  const safeId = safeCheckpointId(checkpointId);
  if (!safeId) throw new Error('invalid checkpointId');
  return withMutationLock(async () => {
    const directory = path.resolve(baseDir);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const owner = ownerKey(userId);
    return withNamedCheckpointLock(directory, owner, safeId, async () => {
      const existing = await checkpointFiles(directory, { onWarning });
      if (existing.some(item => item.document.owner === owner && item.document.checkpointId === safeId)) {
        throw Object.assign(new Error('checkpoint already exists'), { statusCode: 409, code: 'checkpoint_exists' });
      }

      const state = await context.storageState({ indexedDB: true });
      const document = {
        owner,
        checkpointId: safeId,
        createdAt: new Date().toISOString(),
        metadata,
        state,
        limitations: ['live_dom_not_captured', 'javascript_heap_not_captured', 'remote_server_state_not_captured'],
      };
      const fullPath = path.join(directory, `checkpoint-${crypto.randomUUID()}.json`);
      const temporary = path.join(directory, `.checkpoint-${crypto.randomUUID()}.tmp`);
      // Both filenames are generated locally from cryptographically random UUIDs.
      await fs.writeFile(temporary, JSON.stringify(document, null, 2), { mode: 0o600, flag: 'wx' });
      try {
        await fs.rename(temporary, fullPath);
      } finally {
        await fs.unlink(temporary).catch(() => {});
      }
      return publicCheckpoint(document, fullPath);
    });
  });
}

async function readCheckpoint(baseDir, userId, checkpointId, { onWarning } = {}) {
  const safeId = safeCheckpointId(checkpointId);
  if (!safeId) return null;
  const owner = ownerKey(userId);
  const item = (await checkpointFiles(baseDir, { onWarning })).find(candidate =>
    candidate.document.owner === owner && candidate.document.checkpointId === safeId
  );
  return item ? publicCheckpoint(item.document, item.filePath) : null;
}

async function listCheckpoints(baseDir, userId, { onWarning } = {}) {
  const owner = ownerKey(userId);
  return (await checkpointFiles(baseDir, { onWarning }))
    .filter(item => item.document.owner === owner)
    .map(item => publicCheckpoint(item.document, item.filePath))
    .map(item => ({
      checkpointId: item.checkpointId,
      createdAt: item.createdAt,
      metadata: item.metadata,
      limitations: item.limitations,
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function deleteCheckpoint(baseDir, userId, checkpointId, { onWarning } = {}) {
  const safeId = safeCheckpointId(checkpointId);
  if (!safeId) return false;
  return withMutationLock(async () => {
    const owner = ownerKey(userId);
    const directory = path.resolve(baseDir);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    return withNamedCheckpointLock(directory, owner, safeId, async () => {
      const item = (await checkpointFiles(directory, { onWarning })).find(candidate =>
        candidate.document.owner === owner && candidate.document.checkpointId === safeId
      );
      if (!item) return false;
      try {
        await fs.unlink(item.filePath);
        return true;
      } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
      }
    });
  });
}

export { createCheckpoint, deleteCheckpoint, listCheckpoints, readCheckpoint, safeCheckpointId };
