import { Schema } from 'effect'
import type { PublicIdentity } from './status.ts'
import { NotificationTarget } from './notifications.ts'

const text = (max: number) => Schema.String.check(Schema.isMaxLength(max))
export const NotificationScope = text(1024).check(Schema.isMinLength(1))
export const NotificationBatch = Schema.Struct({
  scope: NotificationScope,
  cursor: Schema.NullOr(text(256)),
  events: Schema.Array(
    Schema.Struct({
      event_id: text(256).check(Schema.isMinLength(1)),
      title: text(4096),
      body: text(4096),
      kind: Schema.optionalKey(text(64)),
      ...NotificationTarget.fields,
    }),
  ).check(Schema.isMaxLength(200)),
})
export const TrayActivity = Schema.Struct({
  running: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  waiting: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  threads: Schema.Array(Schema.Struct({ id: text(256), title: text(512) })).check(Schema.isMaxLength(5)),
})
export const ViewingThread = Schema.NullOr(text(256))

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
