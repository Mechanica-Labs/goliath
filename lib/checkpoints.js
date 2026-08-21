import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

function userDir(baseDir, userId) {
  const safeUser = path.basename(crypto.createHash('sha256').update(String(userId)).digest('hex').slice(0, 24));
  return path.join(path.resolve(baseDir), safeUser);
}

function safeCheckpointId(value) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(String(value || ''))) return null;
  return String(value);
}

function checkpointPath(baseDir, userId, checkpointId) {
  const safe = safeCheckpointId(checkpointId);
  if (!safe) return null;
  const safeFile = path.basename(`${crypto.createHash('sha256').update(safe).digest('hex')}.json`);
  return path.join(userDir(baseDir, userId), safeFile);
}

async function readCheckpointFile(directory, name) {
  if (!/^[a-f0-9]{64}\.json$/.test(name)) return null;
  const safeName = path.basename(name);
  const document = JSON.parse(await fs.readFile(path.join(directory, safeName), 'utf8'));
  return { ...document, path: path.join(directory, safeName) };
}

async function createCheckpoint({ baseDir, userId, context, checkpointId = `cp_${crypto.randomUUID()}`, metadata = {} }) {
  const fullPath = checkpointPath(baseDir, userId, checkpointId);
  if (!fullPath) throw new Error('invalid checkpointId');
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  const state = await context.storageState({ indexedDB: true });
  const document = {
    checkpointId,
    createdAt: new Date().toISOString(),
    metadata,
    state,
    limitations: ['live_dom_not_captured', 'javascript_heap_not_captured', 'remote_server_state_not_captured'],
  };
  const temporary = `${fullPath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temporary, JSON.stringify(document, null, 2), { mode: 0o600, flag: 'wx' });
  try {
    // Linking is atomic and refuses to replace an existing named checkpoint.
    await fs.link(temporary, fullPath);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('checkpoint already exists');
    throw error;
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
  return { ...document, path: fullPath };
}

async function readCheckpoint(baseDir, userId, checkpointId) {
  const fullPath = checkpointPath(baseDir, userId, checkpointId);
  if (!fullPath) return null;
  try {
    const document = JSON.parse(await fs.readFile(fullPath, 'utf8'));
    return { ...document, path: fullPath };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function listCheckpoints(baseDir, userId) {
  const directory = userDir(baseDir, userId);
  let names;
  try { names = await fs.readdir(directory); } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const output = [];
  for (const name of names) {
    const item = await readCheckpointFile(directory, name);
    if (item) output.push({
      checkpointId: item.checkpointId,
      createdAt: item.createdAt,
      metadata: item.metadata,
      limitations: item.limitations,
    });
  }
  return output.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function deleteCheckpoint(baseDir, userId, checkpointId) {
  const fullPath = checkpointPath(baseDir, userId, checkpointId);
  if (!fullPath) return false;
  try { await fs.unlink(fullPath); return true; } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export { checkpointPath, createCheckpoint, deleteCheckpoint, listCheckpoints, readCheckpoint, safeCheckpointId };
