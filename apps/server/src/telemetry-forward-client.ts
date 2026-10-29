import { Effect, Option } from 'effect'
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/http'
import { otlpEndpoint, otlpTimeouts, type OtlpSignal } from '@baton/telemetry/otlp-config'

export type TelemetrySignal = 'traces' | 'logs' | 'metrics'

export function telemetryForwardEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env.BATON_TELEMETRY_FORWARD !== 'off' &&
    Boolean(
      env.OTEL_EXPORTER_OTLP_ENDPOINT ||
      ['TRACES', 'LOGS', 'METRICS'].some((signal) => env[`OTEL_EXPORTER_OTLP_${signal}_ENDPOINT`]),
    )
  )
}

export function makeTelemetryForwardClient(env: NodeJS.ProcessEnv = process.env) {
  let active = 0
  let suspendedUntil = 0
  const forward = (signal: TelemetrySignal, payload: unknown): void => {
    if (!telemetryForwardEnabled(env) || Date.now() < suspendedUntil) return
    if (active >= 4) return
    const upper = signal.toUpperCase() as OtlpSignal
    const exporters = env[`OTEL_${upper}_EXPORTER`] ?? 'otlp'
    if (
      env.OTEL_SDK_DISABLED?.toLowerCase() === 'true' ||
      !exporters.split(',').some((value) => value.trim().toLowerCase() === 'otlp')
    )
      return
    let url: URL
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    try {
      const endpoint = otlpEndpoint(env, upper)
      if (!endpoint) return
      url = endpoint
      const configured = env[`OTEL_EXPORTER_OTLP_${upper}_HEADERS`] ?? env.OTEL_EXPORTER_OTLP_HEADERS
      for (const entry of configured?.split(',') ?? []) {
        const separator = entry.indexOf('=')
        if (separator > 0)
          headers[entry.slice(0, separator).trim()] = decodeURIComponent(entry.slice(separator + 1).trim())
      }
    } catch {
      suspendedUntil = Date.now() + 60_000
      return
    }
    const timeout = otlpTimeouts(env)[url.toString()] ?? 3000
    active++
    const request = HttpClientRequest.post(url.toString()).pipe(
      HttpClientRequest.setHeaders(headers),
      HttpClientRequest.bodyText(JSON.stringify(payload), 'application/json'),
    )
    const send = Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const response = yield* client.execute(request)
      const raw = HttpClientResponse.toWeb(response)
      yield* Effect.tryPromise(() =>
        Option.isSome(raw) ? (raw.value.body?.cancel() ?? Promise.resolve()) : Promise.resolve(),
      )
      if (response.status < 200 || response.status >= 300)
        return yield* Effect.fail(new Error('OTLP forwarding failed'))
    }).pipe(
      Effect.timeout(timeout),
      Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: 'error' }),
      Effect.provide(FetchHttpClient.layer),
    )
    void Effect.runPromise(send)
      .catch(() => {
        suspendedUntil = Date.now() + 60_000
      })
      .finally(() => {
        active--
      })
  }
  return Object.assign(forward, { available: () => active < 4 && Date.now() >= suspendedUntil })
}
