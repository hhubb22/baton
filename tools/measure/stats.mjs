export function stats(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const percentile = (p) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]
  return { count: sorted.length, p50Ms: percentile(0.5), p99Ms: percentile(0.99), maxMs: sorted.at(-1) }
}
