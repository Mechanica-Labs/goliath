import { test, expect } from '@jest/globals';
import { coerceHandsSteps, HandsError, MAX_STEPS } from '../../lib/hands.js';

test('rejects non-array or empty steps', () => {
  expect(() => coerceHandsSteps(undefined)).toThrow(HandsError);
  expect(() => coerceHandsSteps(null)).toThrow(HandsError);
  expect(() => coerceHandsSteps('nope')).toThrow(HandsError);
  expect(() => coerceHandsSteps([])).toThrow(HandsError);
});

test('rejects unknown actions', () => {
  expect(() => coerceHandsSteps([{ action: 'teleport' }])).toThrow(/unknown action/);
});

test('rejects malformed step entries', () => {
  expect(() => coerceHandsSteps(['x'])).toThrow(/must be an object/);
  expect(() => coerceHandsSteps([[{ action: 'click' }]])).toThrow(/must be an object/);
});

test('click requires a target', () => {
  expect(() => coerceHandsSteps([{ action: 'click' }])).toThrow(/requires ref or selector/);
  expect(coerceHandsSteps([{ action: 'click', ref: 'e1' }])).toHaveLength(1);
});

test('type requires text and a target in fill mode', () => {
  expect(() => coerceHandsSteps([{ action: 'type', ref: 'e1' }])).toThrow(/requires text/);
  expect(() => coerceHandsSteps([{ action: 'type', text: 'hi' }])).toThrow(/requires ref or selector/);
  expect(() => coerceHandsSteps([{ action: 'type', text: 'hi', mode: 'keyboard' }])).not.toThrow();
});

test('select requires a value (or values)', () => {
  expect(() => coerceHandsSteps([{ action: 'select', selector: 'select' }])).toThrow(/requires value or values/);
  const [step] = coerceHandsSteps([{ action: 'select', selector: 'select', value: 'BR' }]);
  expect(step.values).toEqual(['BR']);
});

test('wait normalizes and clamps ms', () => {
  const [step] = coerceHandsSteps([{ action: 'wait' }]);
  expect(step.ms).toBe(300);
  const [big] = coerceHandsSteps([{ action: 'wait', ms: 999999 }]);
  expect(big.ms).toBe(5000);
});

test('press requires a key', () => {
  expect(() => coerceHandsSteps([{ action: 'press' }])).toThrow(/requires key/);
});

test('enforces max step count', () => {
  const steps = Array.from({ length: MAX_STEPS + 1 }, () => ({ action: 'wait' }));
  expect(() => coerceHandsSteps(steps)).toThrow(/too many steps/);
});

test('carries stepIndex on validation errors', () => {
  try {
    coerceHandsSteps([{ action: 'click', ref: 'e1' }, { action: 'nope' }]);
    throw new Error('should have thrown');
  } catch (err) {
    expect(err).toBeInstanceOf(HandsError);
    expect(err.stepIndex).toBe(1);
  }
});
