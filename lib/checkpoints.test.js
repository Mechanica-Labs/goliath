import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createCheckpoint, deleteCheckpoint, listCheckpoints, readCheckpoint } from './checkpoints.js';

test('checkpoint lifecycle stores state atomically and safely', async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'goliath-checkpoints-'));
  const context = { storageState: async () => ({ cookies: [], origins: [] }) };
  try {
    const created = await createCheckpoint({ baseDir, userId: 'user@example.com', context, checkpointId: 'before_checkout' });
    expect(created.limitations).toContain('javascript_heap_not_captured');
    expect(created.userId).toBeUndefined();
    expect(created.owner).toBeUndefined();
    await expect(createCheckpoint({ baseDir, userId: 'user@example.com', context, checkpointId: '../../escape' })).rejects.toThrow('invalid checkpointId');
    const names = await fs.readdir(baseDir);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^checkpoint-[0-9a-f-]{36}\.json$/);
    expect(names[0]).not.toContain('before_checkout');
    await expect(readCheckpoint(baseDir, 'user@example.com', 'before_checkout')).resolves.toMatchObject({ checkpointId: 'before_checkout' });
    await expect(readCheckpoint(baseDir, 'other-user', 'before_checkout')).resolves.toBeNull();
    await expect(createCheckpoint({ baseDir, userId: 'user@example.com', context, checkpointId: 'before_checkout' })).rejects.toThrow('checkpoint already exists');
    await expect(createCheckpoint({ baseDir, userId: 'other-user', context, checkpointId: 'before_checkout' })).resolves.toMatchObject({ checkpointId: 'before_checkout' });
    await expect(listCheckpoints(baseDir, 'user@example.com')).resolves.toHaveLength(1);
    await expect(deleteCheckpoint(baseDir, 'user@example.com', 'before_checkout')).resolves.toBe(true);
    await expect(readCheckpoint(baseDir, 'other-user', 'before_checkout')).resolves.toMatchObject({ checkpointId: 'before_checkout' });
  } finally {
    await fs.rm(baseDir, { recursive: true, force: true });
  }
});

test('malformed checkpoint files are skipped without poisoning valid operations', async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'goliath-checkpoints-corrupt-'));
  const context = { storageState: async () => ({ cookies: [], origins: [] }) };
  const warnings = [];
  try {
    await createCheckpoint({ baseDir, userId: 'owner', context, checkpointId: 'valid' });
    await fs.writeFile(
      path.join(baseDir, 'checkpoint-11111111-1111-4111-8111-111111111111.json'),
      '{broken',
    );

    await expect(listCheckpoints(baseDir, 'owner', { onWarning: warning => warnings.push(warning) }))
      .resolves.toEqual([expect.objectContaining({ checkpointId: 'valid' })]);
    expect(warnings).toContainEqual(expect.objectContaining({
      code: 'checkpoint_file_skipped',
      reason: 'invalid_json',
    }));
    await expect(readCheckpoint(baseDir, 'owner', 'valid')).resolves.toMatchObject({ checkpointId: 'valid' });
    await expect(createCheckpoint({ baseDir, userId: 'owner', context, checkpointId: 'after_corruption' }))
      .resolves.toMatchObject({ checkpointId: 'after_corruption' });
    await expect(deleteCheckpoint(baseDir, 'owner', 'valid')).resolves.toBe(true);
  } finally {
    await fs.rm(baseDir, { recursive: true, force: true });
  }
});

test('concurrent named checkpoint creation yields exactly one success', async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'goliath-checkpoints-race-'));
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const context = { storageState: async () => gate.then(() => ({ cookies: [], origins: [] })) };
  try {
    const first = createCheckpoint({ baseDir, userId: 'owner', context, checkpointId: 'same_name' });
    const second = createCheckpoint({ baseDir, userId: 'owner', context, checkpointId: 'same_name' });
    release();
    const results = await Promise.allSettled([first, second]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    await expect(listCheckpoints(baseDir, 'owner')).resolves.toHaveLength(1);
  } finally {
    await fs.rm(baseDir, { recursive: true, force: true });
  }
});

test('stale named checkpoint locks fail closed without deleting another owner lock', async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'goliath-checkpoints-stale-lock-'));
  const userId = 'owner';
  const checkpointId = 'same_name';
  const owner = crypto.createHash('sha256').update(userId).digest('hex');
  const lockId = crypto.createHash('sha256').update(`${owner}:${checkpointId}`).digest('hex');
  const lockPath = path.join(baseDir, `checkpoint-lock-${lockId}.lock`);
  const original = JSON.stringify({ token: 'existing-owner', pid: 999999, startedAt: '2000-01-01T00:00:00.000Z' });
  const context = { storageState: async () => ({ cookies: [], origins: [] }) };
  try {
    await fs.writeFile(lockPath, original, { mode: 0o600 });
    const staleDate = new Date(Date.now() - (11 * 60_000));
    await fs.utimes(lockPath, staleDate, staleDate);
    const attempts = [1, 2].map(() => createCheckpoint({ baseDir, userId, context, checkpointId }));
    const results = await Promise.allSettled(attempts);
    expect(results.every(result => result.status === 'rejected' && result.reason.code === 'checkpoint_locked')).toBe(true);
    await expect(fs.readFile(lockPath, 'utf8')).resolves.toBe(original);
  } finally {
    await fs.rm(baseDir, { recursive: true, force: true });
  }
});

test('checkpoint lock release does not unlink a replacement owner lock', async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'goliath-checkpoints-owner-lock-'));
  const userId = 'owner';
  const checkpointId = 'replace_during_operation';
  const owner = crypto.createHash('sha256').update(userId).digest('hex');
  const lockId = crypto.createHash('sha256').update(`${owner}:${checkpointId}`).digest('hex');
  const lockPath = path.join(baseDir, `checkpoint-lock-${lockId}.lock`);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const context = { storageState: async () => gate.then(() => ({ cookies: [], origins: [] })) };
  const replacement = JSON.stringify({ token: 'replacement-owner', pid: process.pid, startedAt: new Date().toISOString() });
  try {
    const creation = createCheckpoint({ baseDir, userId, context, checkpointId });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await fs.stat(lockPath).then(() => true, () => false)) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    await fs.unlink(lockPath);
    await fs.writeFile(lockPath, replacement, { mode: 0o600, flag: 'wx' });
    release();
    await expect(creation).resolves.toMatchObject({ checkpointId });
    await expect(fs.readFile(lockPath, 'utf8')).resolves.toBe(replacement);
  } finally {
    release?.();
    await fs.rm(baseDir, { recursive: true, force: true });
  }
});
