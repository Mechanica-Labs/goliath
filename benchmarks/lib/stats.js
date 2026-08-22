/**
 * Deterministic summary statistics for benchmark reports.
 *
 * Percentiles use the nearest-rank definition. It is intentionally simple,
 * stable across Node versions, and appropriate for the small sample sizes used
 * by this smoke-oriented benchmark suite.
 */
export function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  if (!Number.isFinite(p) || p < 0 || p > 1) {
    throw new RangeError('p must be between 0 and 1');
  }

  const sorted = [...values].sort((a, b) => a - b);
  if (p === 0) return sorted[0];
  const rank = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(rank, sorted.length - 1))];
}

export function summarizeNumbers(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return { min: 0, p50: 0, p95: 0, max: 0, mean: 0 };
  }

  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    min: round(Math.min(...values)),
    p50: round(percentile(values, 0.50)),
    p95: round(percentile(values, 0.95)),
    max: round(Math.max(...values)),
    mean: round(total / values.length),
  };
}

function round(value) {
  return Number(value.toFixed(2));
}
