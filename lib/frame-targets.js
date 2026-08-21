function resolveRefTarget(page, ref, refs) {
  const info = refs?.get?.(ref);
  if (!info || !page) return { ok: false, reason: 'ref_not_found' };

  const mainFrame = page.mainFrame?.();
  const frameKey = info.frameKey || 'main';
  const frame = frameKey === 'main' ? mainFrame : info.frame;
  if (!frame) return { ok: false, reason: 'frame_not_found' };
  if (frameKey !== 'main' && !page.frames?.().includes(frame)) {
    return { ok: false, reason: 'frame_detached' };
  }

  const currentUrl = frame.url?.() || '';
  if (info.frameUrl && currentUrl !== info.frameUrl) {
    return { ok: false, reason: 'frame_navigated' };
  }

  let locator = frame.getByRole(info.role, info.name ? { name: info.name } : undefined);
  locator = locator.nth(info.nth);
  return {
    ok: true,
    locator,
    frame,
    frameKey,
    frameUrl: currentUrl,
  };
}

function targetFrameOrigin(target) {
  if (!target?.ok || !target.frame) return null;
  const currentUrl = target.frame.url?.() || '';
  if (!currentUrl || currentUrl !== target.frameUrl) return null;
  try {
    const parsed = new URL(currentUrl);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin === 'null') return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function validateSecretTarget(secret, target) {
  if (!secret) return { ok: false, reason: 'secret_missing' };
  const origin = targetFrameOrigin(target);
  if (!origin) return { ok: false, reason: 'target_frame_origin_unavailable' };
  if (!Array.isArray(secret.allowedOrigins) || !secret.allowedOrigins.includes(origin)) {
    return { ok: false, reason: 'target_frame_origin_not_allowed', origin };
  }
  return { ok: true, origin };
}

export { resolveRefTarget, targetFrameOrigin, validateSecretTarget };
