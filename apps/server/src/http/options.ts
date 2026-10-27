import type { DownloadsOptions } from '../downloads.ts'
import type { Gateway } from '../gateway.ts'
import type { CredentialSigner } from '../nodes.ts'

export interface HTTPOptions {
  readonly allowedOrigins: ReadonlyArray<string>
  readonly signer: CredentialSigner
  readonly sessionTTLSeconds?: number
  readonly enrollmentTTLSeconds?: number
  readonly webDirectory?: string
  readonly downloads?: DownloadsOptions
  readonly gateway: () => Pick<Gateway, 'request' | 'notify' | 'disconnect' | 'disconnectBrowsers' | 'diagnostics'>
}
