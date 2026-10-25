import type { Gateway } from '../gateway.ts'
import type { CredentialSigner } from '../nodes.ts'

export interface HTTPOptions {
  readonly allowedOrigins: ReadonlyArray<string>
  readonly signer: CredentialSigner
  readonly sessionTTLSeconds?: number
  readonly enrollmentTTLSeconds?: number
  readonly nodeCredentialTTLSeconds?: number
  readonly webDirectory?: string
  readonly gateway: () => Gateway
}
