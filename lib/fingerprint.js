const FIREFOX_COHERENCE_SCRIPT = `(() => {
  if (!/Firefox\\//.test(navigator.userAgent)) return;
  if (!('chrome' in window)) return;
  try { delete window.chrome; } catch (_) {}
  if ('chrome' in window) {
    try {
      Object.defineProperty(window, 'chrome', { configurable: true, enumerable: false, get: () => undefined });
    } catch (_) {}
  }
})();`;

export function firefoxCoherenceScript() {
  return FIREFOX_COHERENCE_SCRIPT;
}

export async function applyFingerprintCoherence(context) {
  await context.addInitScript(FIREFOX_COHERENCE_SCRIPT);
}
