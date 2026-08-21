import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checkpointPath, createCheckpoint, deleteCheckpoint, listCheckpoints, readCheckpoint } from './checkpoints.js';

test('checkpoint lifecycle stores state atomically and safely', async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'goliath-checkpoints-'));
  const context = { storageState: async () => ({ cookies: [], origins: [] }) };
  try {
    const created = await createCheckpoint({ baseDir, userId: 'user@example.com', context, checkpointId: 'before_checkout' });
    expect(created.limitations).toContain('javascript_heap_not_captured');
    expect(created.userId).toBeUndefined();
    expect(checkpointPath(baseDir, '../other-user', '../../escape')).toBeNull();
    expect(checkpointPath(baseDir, '../other-user', 'safe-id')).toMatch(/\/[a-f0-9]{64}\.json$/);
    await expect(readCheckpoint(baseDir, 'user@example.com', 'before_checkout')).resolves.toMatchObject({ checkpointId: 'before_checkout' });
    await expect(createCheckpoint({ baseDir, userId: 'user@example.com', context, checkpointId: 'before_checkout' })).rejects.toThrow('checkpoint already exists');
    await expect(listCheckpoints(baseDir, 'user@example.com')).resolves.toHaveLength(1);
    await expect(deleteCheckpoint(baseDir, 'user@example.com', 'before_checkout')).resolves.toBe(true);
  } finally {
    await fs.rm(baseDir, { recursive: true, force: true });
  }
});
