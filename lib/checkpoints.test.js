import fs from 'node:fs/promises';
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
