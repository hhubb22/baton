import type { DownloadsOptions } from '../downloads.ts'
import type { Gateway } from '../gateway.ts'
import type { CredentialSigner } from '../nodes.ts'
import type { TelemetrySignal } from '../telemetry-forward-client.ts'

export interface HTTPOptions {
  readonly telemetryEnv?: NodeJS.ProcessEnv
  readonly allowedOrigins: ReadonlyArray<string>
  readonly signer: CredentialSigner
  readonly sessionTTLSeconds?: number
  readonly enrollmentTTLSeconds?: number
  readonly webDirectory?: string
  readonly downloads?: DownloadsOptions
  readonly gateway: () => Pick<Gateway, 'request' | 'notify' | 'disconnect' | 'disconnectBrowsers' | 'diagnostics'>
  readonly forwardTelemetry?: (signal: TelemetrySignal, payload: unknown, employeeId: string) => void
}
