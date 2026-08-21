import fs from 'node:fs/promises';
import path from 'node:path';

function fileOutputError(message, code) {
  return Object.assign(new Error(message), { statusCode: 400, code });
}

function isInside(basePath, targetPath) {
  const relative = path.relative(basePath, targetPath);
  return relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function allowedRoots({ workspaceDir, screenshotsDir }) {
  return [workspaceDir, screenshotsDir]
    .filter((dir) => typeof dir === 'string' && dir.trim())
    .map((dir) => path.resolve(dir));
}

export function resolveOutputPath(filePath, { workspaceDir, screenshotsDir } = {}) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw fileOutputError('Output path is required', 'invalid_output_path');
  }
  const raw = filePath.trim();
  if (raw.includes('\0')) throw fileOutputError('Output path is invalid', 'invalid_output_path');

  const relativeBase = workspaceDir ? path.resolve(workspaceDir) : path.resolve(screenshotsDir);
  const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(relativeBase, raw);
  if (path.extname(resolved).toLowerCase() !== '.png') {
    throw fileOutputError('Output path must end in .png', 'invalid_output_path');
  }

  const roots = allowedRoots({ workspaceDir, screenshotsDir });
  if (!roots.length || !roots.some((root) => isInside(root, resolved))) {
    throw fileOutputError('Output path is outside the workspace and screenshot directories', 'output_path_outside_root');
  }
  return resolved;
}

export async function writeOutputFile(filePath, buffer, dirs = {}) {
  const dest = resolveOutputPath(filePath, dirs);
  await fs.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });

  const realParent = await fs.realpath(path.dirname(dest));
  const realDest = path.join(realParent, path.basename(dest));
  const realRoots = [];
  for (const root of allowedRoots(dirs)) {
    try {
      realRoots.push(await fs.realpath(root));
    } catch {
      realRoots.push(root);
    }
  }
  if (!realRoots.some((root) => isInside(root, realDest))) {
    throw fileOutputError('Output path is outside the workspace and screenshot directories', 'output_path_outside_root');
  }

  await fs.writeFile(realDest, buffer, { mode: 0o600 });
  return realDest;
}
