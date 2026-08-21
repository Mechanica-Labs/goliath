const PROFILES = {
  fast: { moveMinMs: 70, moveMaxMs: 180, hesitateMinMs: 30, hesitateMaxMs: 100, keyMinMs: 25, keyMaxMs: 85 },
  balanced: { moveMinMs: 120, moveMaxMs: 320, hesitateMinMs: 60, hesitateMaxMs: 220, keyMinMs: 45, keyMaxMs: 145 },
  deliberate: { moveMinMs: 220, moveMaxMs: 520, hesitateMinMs: 120, hesitateMaxMs: 420, keyMinMs: 70, keyMaxMs: 210 },
};

function between(random, min, max) {
  return min + random() * (max - min);
}

function integer(random, min, max) {
  return Math.floor(between(random, min, max + 1));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function cubicBezier(start, control1, control2, end, t) {
  const inverse = 1 - t;
  return {
    x: (inverse ** 3) * start.x + 3 * (inverse ** 2) * t * control1.x + 3 * inverse * (t ** 2) * control2.x + (t ** 3) * end.x,
    y: (inverse ** 3) * start.y + 3 * (inverse ** 2) * t * control1.y + 3 * inverse * (t ** 2) * control2.y + (t ** 3) * end.y,
  };
}

export function humanizedOptions(value) {
  if (!value) return { enabled: false, profile: 'balanced' };
  if (value === true) return { enabled: true, profile: 'balanced' };
  if (typeof value !== 'object') return { enabled: false, profile: 'balanced' };
  const profile = Object.hasOwn(PROFILES, value.profile) ? value.profile : 'balanced';
  return { enabled: value.enabled !== false, profile };
}

export function pointerTrajectory(start, end, { random = Math.random, steps } = {}) {
  const distance = Math.hypot(end.x - start.x, end.y - start.y);
  const pointCount = steps || clamp(Math.round(distance / 22), 12, 42);
  const bend = between(random, -0.22, 0.22) * Math.max(60, distance);
  const control1 = {
    x: start.x + (end.x - start.x) * between(random, 0.2, 0.4) - bend * 0.25,
    y: start.y + (end.y - start.y) * between(random, 0.15, 0.35) + bend,
  };
  const control2 = {
    x: start.x + (end.x - start.x) * between(random, 0.65, 0.85) + bend * 0.2,
    y: start.y + (end.y - start.y) * between(random, 0.6, 0.85) - bend * 0.45,
  };
  const points = [];
  for (let index = 1; index <= pointCount; index++) {
    const t = index / pointCount;
    const point = cubicBezier(start, control1, control2, end, t);
    const taper = Math.sin(Math.PI * t);
    points.push({
      x: point.x + between(random, -1.25, 1.25) * taper,
      y: point.y + between(random, -1.25, 1.25) * taper,
    });
  }
  points[points.length - 1] = { ...end };
  return points;
}

function runtime(options = {}) {
  const random = options.random || Math.random;
  const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const record = options.record || (() => {});
  const profileName = Object.hasOwn(PROFILES, options.profile) ? options.profile : 'balanced';
  return { random, sleep, record, profile: PROFILES[profileName], profileName };
}

async function movePointer(page, state, end, options = {}) {
  const rt = runtime(options);
  const viewport = page.viewportSize?.() || { width: 1280, height: 720 };
  const start = state.pointer || {
    x: between(rt.random, viewport.width * 0.25, viewport.width * 0.75),
    y: between(rt.random, viewport.height * 0.25, viewport.height * 0.75),
  };
  const points = pointerTrajectory(start, end, { random: rt.random });
  const duration = between(rt.random, rt.profile.moveMinMs, rt.profile.moveMaxMs);
  for (const [index, point] of points.entries()) {
    await page.mouse.move(point.x, point.y);
    state.pointer = point;
    rt.record('pointermove', { x: Math.round(point.x), y: Math.round(point.y) });
    if (index < points.length - 1) {
      const progress = (index + 1) / points.length;
      const easingWeight = 0.55 + Math.abs(progress - 0.5) * 1.3;
      await rt.sleep(Math.max(2, duration / points.length * easingWeight * between(rt.random, 0.7, 1.3)));
    }
  }
  return { start, end, points: points.length, durationMs: Math.round(duration) };
}

function targetPoint(box, random) {
  const insetX = Math.min(box.width * 0.22, 12);
  const insetY = Math.min(box.height * 0.22, 10);
  return {
    x: between(random, box.x + insetX, box.x + Math.max(insetX, box.width - insetX)),
    y: between(random, box.y + insetY, box.y + Math.max(insetY, box.height - insetY)),
  };
}

export async function humanizedClick(page, locator, state, options = {}) {
  const rt = runtime(options);
  await locator.scrollIntoViewIfNeeded?.({ timeout: 3000 });
  const box = await locator.boundingBox();
  if (!box || box.width <= 0 || box.height <= 0) throw new Error('Element not visible (no bounding box)');
  const target = targetPoint(box, rt.random);
  const movement = await movePointer(page, state, target, {
    random: rt.random,
    sleep: rt.sleep,
    record: rt.record,
    profile: rt.profileName,
  });
  await rt.sleep(between(rt.random, rt.profile.hesitateMinMs, rt.profile.hesitateMaxMs));

  const microMoves = integer(rt.random, 0, 2);
  for (let index = 0; index < microMoves; index++) {
    const micro = { x: target.x + between(rt.random, -2.2, 2.2), y: target.y + between(rt.random, -1.8, 1.8) };
    await page.mouse.move(micro.x, micro.y);
    state.pointer = micro;
    rt.record('pointermove', { x: Math.round(micro.x), y: Math.round(micro.y), micro: true });
    await rt.sleep(between(rt.random, 18, 65));
  }

  const clickCount = options.doubleClick ? 2 : 1;
  for (let click = 0; click < clickCount; click++) {
    await page.mouse.down();
    rt.record('pointerdown', { button: 'left' });
    await rt.sleep(between(rt.random, 45, 135));
    await page.mouse.up();
    rt.record('pointerup', { button: 'left' });
    if (click + 1 < clickCount) await rt.sleep(between(rt.random, 85, 180));
  }
  return { mode: 'humanized', profile: rt.profileName, pathPoints: movement.points };
}

export async function humanizedType(page, text, options = {}) {
  const rt = runtime(options);
  let typed = 0;
  for (const character of Array.from(text)) {
    await page.keyboard.type(character);
    typed += 1;
    rt.record('key', { category: /\s/.test(character) ? 'space' : 'character' });
    let delay = between(rt.random, rt.profile.keyMinMs, rt.profile.keyMaxMs);
    if (/\s/.test(character)) delay += between(rt.random, 45, 180);
    if (/[.,!?;:]/.test(character)) delay += between(rt.random, 90, 280);
    await rt.sleep(delay);
  }
  return { mode: 'humanized', profile: rt.profileName, characters: typed };
}

export async function humanizedScroll(page, direction, amount, options = {}) {
  const rt = runtime(options);
  const vertical = direction === 'up' || direction === 'down';
  const sign = direction === 'up' || direction === 'left' ? -1 : 1;
  const magnitude = Math.max(1, Math.abs(Number(amount) || 500));
  const pulses = integer(rt.random, 7, 14);
  const weights = Array.from({ length: pulses }, (_, index) => Math.sin(Math.PI * (index + 1) / (pulses + 1)) + 0.18);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  let moved = 0;
  for (const weight of weights) {
    const delta = sign * Math.max(1, Math.round(magnitude * weight / totalWeight));
    await page.mouse.wheel(vertical ? 0 : delta, vertical ? delta : 0);
    moved += delta;
    rt.record('wheel', { deltaX: vertical ? 0 : delta, deltaY: vertical ? delta : 0 });
    await rt.sleep(between(rt.random, 24, 90));
  }
  return { mode: 'humanized', profile: rt.profileName, pulses, distance: moved };
}
