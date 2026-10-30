import type { DownloadsOptions } from '../downloads.ts'
import type { Gateway } from '../gateway.ts'
import type { CredentialSigner } from '../nodes.ts'
import type { TelemetrySignal } from '../telemetry-forward-client.ts'
import type { LoginProtection } from './login-protection.ts'
import type { parseTrustedProxies } from './login-ip.ts'

export interface HTTPOptions {
  readonly telemetryEnv?: NodeJS.ProcessEnv
  readonly allowedOrigins: ReadonlyArray<string>
  readonly loginProtection: LoginProtection
  readonly trustedProxies: ReturnType<typeof parseTrustedProxies>
  readonly signer: CredentialSigner
  readonly sessionTTLSeconds?: number
  readonly enrollmentTTLSeconds?: number
  readonly webDirectory?: string
  readonly downloads?: DownloadsOptions
  readonly gateway: () => Pick<Gateway, 'request' | 'notify' | 'disconnect' | 'disconnectBrowsers' | 'diagnostics'>
  readonly forwardTelemetry?: (signal: TelemetrySignal, payload: unknown, employeeId: string) => void
}
