import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { jest, test, expect, beforeEach } from '@jest/globals';

const child = new EventEmitter();
child.exitCode = null;
child.kill = jest.fn();

const spawn = jest.fn(() => child);

jest.unstable_mockModule('./spawn.js', () => ({ spawn }));

const { startWatcher } = await import('./vnc-launcher.js');

beforeEach(() => {
  spawn.mockClear();
  child.kill.mockClear();
  child.exitCode = null;
});

test('passes an exact display file to the watcher and updates it atomically', () => {
  const log = jest.fn();
  const events = new EventEmitter();
  const watcher = startWatcher({
    resolution: '1440x900x24',
    vncPassword: '',
    viewOnly: true,
    vncPort: 5900,
    novncPort: 6080,
    log,
    events,
  });

  const options = spawn.mock.calls[0][2];
  expect(options.env.VNC_DISPLAY_FILE).toBeTruthy();
  expect(existsSync(options.env.VNC_DISPLAY_FILE)).toBe(true);
  expect(watcher.setDisplay(':7')).toBe(true);
  expect(readFileSync(options.env.VNC_DISPLAY_FILE, 'utf8')).toBe(':7');
  expect(watcher.setDisplay('not-a-display')).toBe(false);
  expect(readFileSync(options.env.VNC_DISPLAY_FILE, 'utf8')).toBe(':7');

  watcher.stop();
  expect(child.kill).toHaveBeenCalledWith('SIGTERM');
});

test('clears the announced display while Goliath restarts', () => {
  const watcher = startWatcher({
    resolution: '1440x900x24',
    vncPassword: '',
    viewOnly: true,
    vncPort: 5900,
    novncPort: 6080,
    log: jest.fn(),
    events: new EventEmitter(),
  });
  const displayFile = spawn.mock.calls[0][2].env.VNC_DISPLAY_FILE;

  watcher.setDisplay(':0');
  watcher.setDisplay('');

  expect(readFileSync(displayFile, 'utf8')).toBe('');
  watcher.stop();
});
