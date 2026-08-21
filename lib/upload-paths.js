import fs from 'node:fs/promises';
import path from 'node:path';

function uploadPathError(message, code) {
  return Object.assign(new Error(message), { statusCode: 400, code });
}

function isInside(basePath, targetPath) {
  const relative = path.relative(basePath, targetPath);
  return relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

async function indexUploadTree(realUploadsDir, configuredUploadsDir, directory = realUploadsDir, index = {
  files: new Map(),
  directories: new Set(),
  escapedSymlinks: new Set(),
}) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const lexicalPath = path.join(directory, entry.name);
    const relativePath = path.relative(realUploadsDir, lexicalPath);
    const normalizedPaths = new Set([
      path.resolve(lexicalPath),
      path.resolve(configuredUploadsDir, relativePath),
    ]);
    if (entry.isSymbolicLink()) {
      const target = await fs.realpath(lexicalPath).catch(() => null);
      if (!target || !isInside(realUploadsDir, target)) {
        for (const normalizedPath of normalizedPaths) index.escapedSymlinks.add(normalizedPath);
        continue;
      }
      const stat = await fs.stat(target).catch(() => null);
      if (stat?.isFile()) {
        for (const normalizedPath of normalizedPaths) index.files.set(normalizedPath, target);
      } else if (stat?.isDirectory()) {
        for (const normalizedPath of normalizedPaths) index.directories.add(normalizedPath);
      }
      continue;
    }
    if (entry.isDirectory()) {
      for (const normalizedPath of normalizedPaths) index.directories.add(normalizedPath);
      await indexUploadTree(realUploadsDir, configuredUploadsDir, lexicalPath, index);
    } else if (entry.isFile()) {
      const realPath = await fs.realpath(lexicalPath);
      if (isInside(realUploadsDir, realPath)) {
        for (const normalizedPath of normalizedPaths) index.files.set(normalizedPath, realPath);
      }
    }
  }
  return index;
}

/**
 * Resolve upload files without allowing callers to escape the configured root.
 * Realpath checks block both `..` traversal and symlink traversal.
 */
async function resolveUploadPaths({ uploadsDir, filePaths }) {
  const configuredUploadsDir = path.resolve(uploadsDir);
  let realUploadsDir;
  try {
    realUploadsDir = await fs.realpath(uploadsDir);
  } catch (err) {
    if (err?.code === 'ENOENT') {
      throw uploadPathError('Upload directory is not available', 'uploads_dir_not_found');
    }
    throw err;
  }
  const uploadIndex = await indexUploadTree(realUploadsDir, configuredUploadsDir);

  return Promise.all(filePaths.map(async (filePath) => {
    if (typeof filePath !== 'string' || !filePath) {
      throw uploadPathError('path entries must be non-empty strings', 'invalid_upload_path');
    }
    if (!path.isAbsolute(filePath)) {
      throw uploadPathError('path entries must be absolute paths within the upload directory', 'invalid_upload_path');
    }
    const normalizedFilePath = path.resolve(filePath);
    if (!isInside(configuredUploadsDir, normalizedFilePath)) {
      throw uploadPathError('path resolves outside the upload directory', 'upload_path_outside_root');
    }

    if (uploadIndex.escapedSymlinks.has(normalizedFilePath)) {
      throw uploadPathError('path resolves outside the upload directory', 'upload_path_outside_root');
    }
    if (uploadIndex.directories.has(normalizedFilePath)) {
      throw uploadPathError('path must identify a file', 'invalid_upload_path');
    }
    const realFilePath = uploadIndex.files.get(normalizedFilePath);
    if (!realFilePath) {
      throw uploadPathError(`file not found in upload directory: ${filePath}`, 'file_not_found');
    }
    return realFilePath;
  }));
}

export { resolveUploadPaths };
