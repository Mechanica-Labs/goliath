import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveOutputPath, writeOutputFile } from '../../lib/file-output.js';

describe('file-output', () => {
  let tempDir;
  let workspaceDir;
  let screenshotsDir;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'goliath-file-output-'));
    workspaceDir = path.join(tempDir, 'workspace');
    screenshotsDir = path.join(tempDir, 'screenshots');
    await fs.mkdir(workspaceDir);
    await fs.mkdir(screenshotsDir);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('resolves relative paths from the workspace when available', () => {
    expect(resolveOutputPath('shots/page.png', { workspaceDir, screenshotsDir }))
      .toBe(path.join(workspaceDir, 'shots', 'page.png'));
  });

  test('resolves relative paths from the screenshot directory without a workspace', () => {
    expect(resolveOutputPath('page.png', { screenshotsDir }))
      .toBe(path.join(screenshotsDir, 'page.png'));
  });

  test('accepts absolute paths inside an allowed root', () => {
    const dest = path.join(screenshotsDir, 'kept.png');
    expect(resolveOutputPath(dest, { workspaceDir, screenshotsDir })).toBe(dest);
  });

  test('creates parent directories and writes the file', async () => {
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const dest = await writeOutputFile('nested/page.png', png, { workspaceDir, screenshotsDir });
    expect(dest).toBe(path.join(await fs.realpath(workspaceDir), 'nested', 'page.png'));
    expect(await fs.readFile(dest)).toEqual(png);
  });

  test('rejects traversal outside allowed roots', () => {
    expect(() => resolveOutputPath('../escape.png', { workspaceDir, screenshotsDir }))
      .toThrow(/outside/);
  });

  test('rejects absolute paths outside allowed roots', () => {
    expect(() => resolveOutputPath(path.join(tempDir, 'outside.png'), { workspaceDir, screenshotsDir }))
      .toThrow(/outside/);
  });

  test('rejects non-png paths', () => {
    expect(() => resolveOutputPath('page.jpg', { workspaceDir, screenshotsDir }))
      .toThrow(/must end in \.png/);
  });
});
