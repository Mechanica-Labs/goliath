import { test, expect } from '@jest/globals';
import { filterInteractive, windowSnapshot, clampSnapshotWindow, MAX_SNAPSHOT_CHARS, MIN_SNAPSHOT_WINDOW_CHARS } from '../../lib/snapshot.js';

const SAMPLE = [
  '- heading "Checkout" [level=1]',
  '- paragraph: Thank you for shopping with us. Terms and conditions apply.',
  '- form "Payment":',
  '  - paragraph: All fields are required.',
  '  - textbox "Card number" [e1]',
  '  - group "Expiry":',
  '    - textbox "Month" [e2]',
  '  - button "Pay now" [e3]',
  '- contentinfo:',
  '  - paragraph: Copyright 2026. All rights reserved.',
  '  - link "Privacy policy" [e4]',
  '- iframe "ads" [frame-key=f1] [frame-url=]:',
  '  - paragraph: sponsored content',
].join('\n');

test('interactive filter keeps refs, headings, iframe markers, and ancestors', () => {
  const { text, fullChars, keptLines, totalLines } = filterInteractive(SAMPLE);
  const lines = text.split('\n');
  expect(lines).toContain('- heading "Checkout" [level=1]');
  expect(lines).toContain('  - textbox "Card number" [e1]');
  expect(lines).toContain('    - textbox "Month" [e2]');
  expect(lines).toContain('- form "Payment":');       // ancestor of e1/e2/e3
  expect(lines).toContain('  - group "Expiry":');     // ancestor of e2
  expect(lines).toContain('- contentinfo:');          // ancestor of e4
  expect(lines).toContain('- iframe "ads" [frame-key=f1] [frame-url=]:');
  expect(text).not.toMatch(/Thank you for shopping/);
  expect(text).not.toMatch(/All fields are required/);
  expect(text).not.toMatch(/sponsored content/);
  expect(fullChars).toBe(SAMPLE.length);
  expect(keptLines).toBeLessThan(totalLines);
});

test('interactive filter preserves every ref present in the input', () => {
  const refs = SAMPLE.match(/\[e\d+\]/g);
  const { text } = filterInteractive(SAMPLE);
  for (const ref of refs) expect(text).toContain(ref);
});

test('interactive filter handles empty and ref-free input', () => {
  expect(filterInteractive('')).toEqual({ text: '', fullChars: 0, keptLines: 0, totalLines: 0 });
  const prose = '- paragraph: nothing to click here';
  expect(filterInteractive(prose).text).toBe('');
});

test('windowSnapshot honors a per-request budget and keeps default behavior', () => {
  const yaml = 'x'.repeat(10000);
  const def = windowSnapshot(yaml, 0);
  expect(def.truncated).toBe(false);           // under the 80K default cap
  const small = windowSnapshot(yaml, 0, 4000);
  expect(small.truncated).toBe(true);
  expect(small.text.length).toBeLessThanOrEqual(4000 + 200);
  expect(small.totalChars).toBe(10000);
  expect(small.hasMore).toBe(true);
  const resumed = windowSnapshot(yaml, small.nextOffset, 4000);
  expect(resumed.offset).toBe(small.nextOffset);
});

test('clampSnapshotWindow clamps and falls back to the default cap', () => {
  expect(clampSnapshotWindow(undefined)).toBe(MAX_SNAPSHOT_CHARS);
  expect(clampSnapshotWindow('not-a-number')).toBe(MAX_SNAPSHOT_CHARS);
  expect(clampSnapshotWindow('10')).toBe(MIN_SNAPSHOT_WINDOW_CHARS);
  expect(clampSnapshotWindow('20000')).toBe(20000);
  expect(clampSnapshotWindow(String(MAX_SNAPSHOT_CHARS * 2))).toBe(MAX_SNAPSHOT_CHARS);
});
