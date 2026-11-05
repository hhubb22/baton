import type { DownloadsOptions } from '../downloads.ts'
import type { Gateway } from '../gateway.ts'
import type { CredentialSigner } from '../nodes.ts'
import type { LoginProtection } from './login-protection.ts'
import type { parseTrustedProxies } from './login-ip.ts'

export interface HTTPOptions {
  readonly allowedOrigins: ReadonlyArray<string>
  readonly loginProtection: LoginProtection
  readonly trustedProxies: ReturnType<typeof parseTrustedProxies>
  readonly signer: CredentialSigner
  readonly sessionTTLSeconds?: number
  readonly webDirectory?: string
  readonly downloads?: DownloadsOptions
  readonly gateway: () => Pick<Gateway, 'request' | 'notify' | 'disconnect' | 'disconnectBrowsers' | 'diagnostics'>
}
