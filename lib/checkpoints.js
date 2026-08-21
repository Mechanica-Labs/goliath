import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const CHECKPOINT_FILE = /^checkpoint-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/;
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

async function checkpointFiles(baseDir) {
  const directory = path.resolve(baseDir);
  let names;
  try {
    // baseDir is trusted operator configuration, never an HTTP request value.
    // lgtm[js/path-injection]
    names = await fs.readdir(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  const checkpoints = [];
  for (const name of names) {
    if (!CHECKPOINT_FILE.test(name) || path.basename(name) !== name) continue;
    const filePath = path.join(directory, name);
    // Names come from readdir and must match the server-generated UUID format above.
    // lgtm[js/path-injection]
    const document = JSON.parse(await fs.readFile(filePath, 'utf8'));
    if (!document || typeof document !== 'object' || !safeCheckpointId(document.checkpointId)) continue;
    if (!/^[a-f0-9]{64}$/.test(document.owner || '')) continue;
    checkpoints.push({ document, filePath });
  }
  return checkpoints;
}

async function createCheckpoint({ baseDir, userId, context, checkpointId = `cp_${crypto.randomUUID()}`, metadata = {} }) {
  const safeId = safeCheckpointId(checkpointId);
  if (!safeId) throw new Error('invalid checkpointId');
  return withMutationLock(async () => {
    const directory = path.resolve(baseDir);
    // baseDir is trusted operator configuration, never an HTTP request value.
    // lgtm[js/path-injection]
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const owner = ownerKey(userId);
    const existing = await checkpointFiles(directory);
    if (existing.some(item => item.document.owner === owner && item.document.checkpointId === safeId)) {
      throw new Error('checkpoint already exists');
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
    // lgtm[js/path-injection]
    await fs.writeFile(temporary, JSON.stringify(document, null, 2), { mode: 0o600, flag: 'wx' });
    try {
      // lgtm[js/path-injection]
      await fs.rename(temporary, fullPath);
    } finally {
      // lgtm[js/path-injection]
      await fs.unlink(temporary).catch(() => {});
    }
    return publicCheckpoint(document, fullPath);
  });
}

async function readCheckpoint(baseDir, userId, checkpointId) {
  const safeId = safeCheckpointId(checkpointId);
  if (!safeId) return null;
  const owner = ownerKey(userId);
  const item = (await checkpointFiles(baseDir)).find(candidate =>
    candidate.document.owner === owner && candidate.document.checkpointId === safeId
  );
  return item ? publicCheckpoint(item.document, item.filePath) : null;
}

async function listCheckpoints(baseDir, userId) {
  const owner = ownerKey(userId);
  return (await checkpointFiles(baseDir))
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

async function deleteCheckpoint(baseDir, userId, checkpointId) {
  const safeId = safeCheckpointId(checkpointId);
  if (!safeId) return false;
  return withMutationLock(async () => {
    const owner = ownerKey(userId);
    const item = (await checkpointFiles(baseDir)).find(candidate =>
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
}

export { createCheckpoint, deleteCheckpoint, listCheckpoints, readCheckpoint, safeCheckpointId };
