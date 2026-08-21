import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveUploadPaths } from '../../lib/upload-paths.js';

describe('resolveUploadPaths', () => {
  let tempDir;
  let uploadsDir;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'goliath-upload-test-'));
    uploadsDir = path.join(tempDir, 'uploads');
    await fs.mkdir(uploadsDir);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('accepts regular files inside the configured root', async () => {
    const filePath = path.join(uploadsDir, 'document.txt');
    await fs.writeFile(filePath, 'hello');

    await expect(resolveUploadPaths({ uploadsDir, filePaths: [filePath] }))
      .resolves.toEqual([await fs.realpath(filePath)]);
  });

  test('rejects relative paths', async () => {
    await expect(resolveUploadPaths({ uploadsDir, filePaths: ['document.txt'] }))
      .rejects.toMatchObject({ code: 'invalid_upload_path', statusCode: 400 });
  });

  test('rejects files outside the configured root', async () => {
    const outsidePath = path.join(tempDir, 'outside.txt');
    await fs.writeFile(outsidePath, 'private');

    await expect(resolveUploadPaths({ uploadsDir, filePaths: [outsidePath] }))
      .rejects.toMatchObject({ code: 'upload_path_outside_root', statusCode: 400 });
  });

  test('rejects symlinks that escape the configured root', async () => {
    const outsidePath = path.join(tempDir, 'outside.txt');
    const linkPath = path.join(uploadsDir, 'link.txt');
    await fs.writeFile(outsidePath, 'private');
    await fs.symlink(outsidePath, linkPath);

    await expect(resolveUploadPaths({ uploadsDir, filePaths: [linkPath] }))
      .rejects.toMatchObject({ code: 'upload_path_outside_root', statusCode: 400 });
  });

  test('rejects directories', async () => {
    const nestedDir = path.join(uploadsDir, 'folder');
    await fs.mkdir(nestedDir);

    await expect(resolveUploadPaths({ uploadsDir, filePaths: [nestedDir] }))
      .rejects.toMatchObject({ code: 'invalid_upload_path', statusCode: 400 });
  });
});
