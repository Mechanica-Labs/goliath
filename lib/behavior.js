const MAX_BEHAVIOR_EVENTS = 512;

function shannonEntropy(values) {
  if (values.length === 0) return 0;
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / values.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}
function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function standardDeviation(values, average) {
  if (values.length < 2) return 0;
  const variance = values.reduce((sum, value) => sum + ((value - average) ** 2), 0) / values.length;
  return Math.sqrt(variance);
}

export function createBehaviorTracker() {
  return { events: [], startedAt: Date.now() };
}

export function recordBehaviorEvent(tracker, type, detail = {}, at = Date.now()) {
  if (!tracker || typeof type !== 'string') return;
  tracker.events.push({ type, at, ...detail });
  if (tracker.events.length > MAX_BEHAVIOR_EVENTS) {
    tracker.events.splice(0, tracker.events.length - MAX_BEHAVIOR_EVENTS);
  }
}

export function behaviorReport(tracker) {
  const events = tracker?.events || [];
  const intervals = [];
  for (let i = 1; i < events.length; i++) {
    const interval = events[i].at - events[i - 1].at;
    if (Number.isFinite(interval) && interval >= 0) intervals.push(interval);
  }

  const positiveIntervals = intervals.filter(value => value > 0);
  const averageIntervalMs = mean(positiveIntervals);
  const deviationMs = standardDeviation(positiveIntervals, averageIntervalMs);
  const coefficientOfVariation = averageIntervalMs > 0 ? deviationMs / averageIntervalMs : 0;
  // Ten millisecond buckets suppress scheduler noise while preserving deliberate pauses.
  const intervalBuckets = positiveIntervals.map(value => Math.min(50, Math.floor(value / 10)));
  const entropyBits = shannonEntropy(intervalBuckets);
  const eventTypes = Object.fromEntries(
    Array.from(events.reduce((counts, event) => {
      counts.set(event.type, (counts.get(event.type) || 0) + 1);
      return counts;
    }, new Map())).sort(([a], [b]) => a.localeCompare(b)),
  );
  const sampleSufficient = positiveIntervals.length >= 12;
  const timingDiverse = sampleSufficient && entropyBits >= 1.5 && coefficientOfVariation >= 0.15;

  return {
    events: events.length,
    eventTypes,
    intervalSamples: positiveIntervals.length,
    averageIntervalMs: Number(averageIntervalMs.toFixed(2)),
    intervalStdDevMs: Number(deviationMs.toFixed(2)),
    coefficientOfVariation: Number(coefficientOfVariation.toFixed(3)),
    entropyBits: Number(entropyBits.toFixed(3)),
    sampleSufficient,
    timingDiverse,
    assessment: !sampleSufficient ? 'insufficient-samples' : timingDiverse ? 'diverse' : 'low-diversity',
    caveat: 'Heuristic timing diversity only; this is not proof of acceptance by a third-party bot detector.',
  };
}
