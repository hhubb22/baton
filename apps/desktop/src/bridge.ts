import { Schema } from 'effect'
import type { PublicIdentity } from './status.ts'

export const EnrollmentInput = Schema.Struct({
  code: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512), Schema.isPattern(/^\S+$/)),
  displayName: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120))),
})

export function sameOrigin(url: string, origin: string | undefined): boolean {
  if (!origin) return false
  try {
    return new URL(url).origin === origin
  } catch {
    return false
  }
}

export function assertIdentityOrigin(identity: PublicIdentity, origin: string): void {
  if (identity.registered && identity.coordinator_url !== origin)
    throw new Error(`本机已接入 ${identity.coordinator_url}，请使用该中心，现有身份未修改`)
}

export function authorizeBridge(senderURL: string, origin: string | undefined, mainFrame: boolean): void {
  if (!mainFrame || !sameOrigin(senderURL, origin)) throw new Error('只有中心主页面可以管理本机设备')
}
