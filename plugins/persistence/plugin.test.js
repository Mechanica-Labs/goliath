import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { getUserPersistencePaths } from '../../lib/persistence.js';
import { register } from './index.js';

describe('persistence session creation', () => {
  let profileDir;
  let previousProfileDir;

  beforeEach(async () => {
    previousProfileDir = process.env.GOLIATH_PROFILE_DIR;
    delete process.env.GOLIATH_PROFILE_DIR;
    profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'goliath-persistence-test-'));
  });

  afterEach(async () => {
    if (previousProfileDir === undefined) delete process.env.GOLIATH_PROFILE_DIR;
    else process.env.GOLIATH_PROFILE_DIR = previousProfileDir;
    await fs.rm(profileDir, { recursive: true, force: true });
  });

  async function sessionCreatingListener(userId) {
    const listeners = new Map();
    await register({}, {
      events: { on: (event, listener) => listeners.set(event, listener) },
      config: { profileDir, cookiesDir: path.join(profileDir, 'cookies') },
      log: () => {},
    });
    return listeners.get('session:creating');
  }

  test('does not overwrite an explicit checkpoint storage state', async () => {
    const userId = 'reused-destination';
    const { userDir, storageStatePath } = getUserPersistencePaths(profileDir, userId);
    await fs.mkdir(userDir, { recursive: true });
    await fs.writeFile(storageStatePath, JSON.stringify({ cookies: [{ name: 'stale-profile' }], origins: [] }));
    const checkpointState = { cookies: [{ name: 'checkpoint' }], origins: [] };
    const contextOptions = { storageState: checkpointState };

    const listener = await sessionCreatingListener(userId);
    await listener({ userId, contextOptions });

    expect(contextOptions.storageState).toBe(checkpointState);
  });

  test('still restores the persisted profile when no state was supplied', async () => {
    const userId = 'normal-session';
    const { userDir, storageStatePath } = getUserPersistencePaths(profileDir, userId);
    await fs.mkdir(userDir, { recursive: true });
    await fs.writeFile(storageStatePath, JSON.stringify({ cookies: [], origins: [] }));
    const contextOptions = {};

    const listener = await sessionCreatingListener(userId);
    await listener({ userId, contextOptions });

    expect(contextOptions.storageState).toBe(storageStatePath);
  });
});
