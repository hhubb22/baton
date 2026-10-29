export const signals = ['TRACES', 'LOGS', 'METRICS'] as const
export type OtlpSignal = (typeof signals)[number]
type Environment = Record<string, string | undefined>

export const otlpTimeout = (env: Environment, signal: OtlpSignal): number => {
  const value = Number(env[`OTEL_EXPORTER_OTLP_${signal}_TIMEOUT`] ?? env.OTEL_EXPORTER_OTLP_TIMEOUT ?? 3000)
  return Number.isFinite(value) && value > 0 ? Math.min(value, 3000) : 3000
}

export const otlpEndpoint = (env: Environment, signal: OtlpSignal): URL | undefined => {
  const specific = env[`OTEL_EXPORTER_OTLP_${signal}_ENDPOINT`]
  const endpoint = specific ?? env.OTEL_EXPORTER_OTLP_ENDPOINT
  if (!endpoint) return undefined
  const url = new URL(endpoint)
  if (!specific) url.pathname += `${url.pathname.endsWith('/') ? '' : '/'}v1/${signal.toLowerCase()}`
  return url
}

export const otlpTimeouts = (env: Environment, endpoints: Environment = env): Record<string, number> => {
  const result: Record<string, number> = {}
  for (const signal of signals) {
    try {
      const url = otlpEndpoint(endpoints, signal)?.toString()
      if (url) result[url] = Math.min(result[url] ?? 3000, otlpTimeout(env, signal))
    } catch {
      // Invalid endpoint is handled by the exporter.
    }
  }
  return result
}
