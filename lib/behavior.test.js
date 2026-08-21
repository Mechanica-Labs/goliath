import { behaviorReport, createBehaviorTracker, recordBehaviorEvent } from './behavior.js';

function trackerWithIntervals(intervals) {
  const tracker = createBehaviorTracker();
  let at = 1000;
  recordBehaviorEvent(tracker, 'start', {}, at);
  for (const interval of intervals) {
    at += interval;
    recordBehaviorEvent(tracker, 'sample', {}, at);
  }
  return tracker;
}

test('behavior report labels small samples as insufficient', () => {
  const report = behaviorReport(trackerWithIntervals([50, 80, 120]));
  expect(report.sampleSufficient).toBe(false);
  expect(report.assessment).toBe('insufficient-samples');
  expect(report.caveat).toMatch(/not proof/i);
});
test('behavior report distinguishes diverse timing from a fixed cadence', () => {
  const varied = behaviorReport(trackerWithIntervals([25, 48, 81, 130, 54, 240, 92, 37, 175, 63, 310, 110, 46, 205, 72]));
  const fixed = behaviorReport(trackerWithIntervals(Array(15).fill(100)));

  expect(varied.sampleSufficient).toBe(true);
  expect(varied.timingDiverse).toBe(true);
  expect(varied.assessment).toBe('diverse');
  expect(fixed.timingDiverse).toBe(false);
  expect(fixed.assessment).toBe('low-diversity');
  expect(varied.entropyBits).toBeGreaterThan(fixed.entropyBits);
});

test('behavior tracker remains bounded', () => {
  const tracker = createBehaviorTracker();
  for (let index = 0; index < 700; index++) recordBehaviorEvent(tracker, 'move', {}, index);
  expect(tracker.events).toHaveLength(512);
  expect(tracker.events[0].at).toBe(188);
});
