/*
Numeric helpers used when summarizing run metrics.
Assumes input values are counts or millisecond durations.
*/

function roundToDecimals(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(decimals));
}

export function averageRounded(total: number, count: number, decimals: number): number {
  if (count === 0) return 0;
  return roundToDecimals(total / count, decimals);
}

export function secondsFromMs(durationMs: number): number {
  return roundToDecimals(durationMs / 1000, 3);
}
