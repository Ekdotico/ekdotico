// The figures of procedure 1: nearest-rank percentiles (the smallest value that at least p per cent of the values
// do not exceed), so that a P99 is a time that was measured and never one that was interpolated between two.
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) throw new Error('No values: a percentile of nothing is not 0.');
  if (!(p > 0 && p <= 100)) throw new Error('A percentile is above 0 and at most 100.');
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

export interface Summary {
  n: number;
  p50: number;
  p99: number;
  max: number;
}

export function summary(values: readonly number[]): Summary {
  return {
    n: values.length,
    p50: round(percentile(values, 50)),
    p99: round(percentile(values, 99)),
    max: round(Math.max(...values)),
  };
}

const round = (value: number) => Math.round(value * 100) / 100;
