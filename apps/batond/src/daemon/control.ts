import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { Schema } from 'effect'
import { DeviceLoginCreateInput, UUID, WorkerRequest } from '@baton/protocol'
import { coordinatorURL } from './identity.ts'

export type ConnectionState = 'unbound' | 'authorizing' | 'connecting' | 'syncing' | 'online' | 'rejected'
export interface PendingLogin {
  readonly status: 'pending'
  readonly session_id: string
  readonly user_code: string
  readonly verification_uri: string
  readonly verification_uri_complete: string
  readonly expires_at: string
  readonly expires_in_seconds: number
}
export type ControlRequest =
  | { readonly method: 'status' | 'shutdown' | 'login_cancel' | 'logout' | 'diagnostics' }
  | { readonly method: 'login_start'; readonly coordinator_url: string; readonly display_name?: string }
  | { readonly method: 'resolve_thread_directory'; readonly thread_id: string }
  | { readonly method: 'thread_request'; readonly thread_id: string; readonly request: typeof WorkerRequest.Type }
export interface ControlResponse {
  readonly ok: boolean
  readonly code?: string
  readonly message?: string
  readonly status?: 'pending' | 'already_bound'
  readonly pid?: number
  readonly batond_version?: string
  readonly protocol_version?: number
  readonly platform?: string
  readonly state?: ConnectionState
  readonly coordinator_url?: string
  readonly node_id?: string
  readonly employee_id?: string
  readonly display_name?: string
  readonly rejection?: { readonly code: string; readonly message: string; readonly at: string }
  readonly pending_login?: PendingLogin
  readonly last_error?: { readonly code: string; readonly message: string; readonly at: string }
  readonly service_installed?: boolean
  readonly session_id?: string
  readonly user_code?: string
  readonly verification_uri?: string
  readonly verification_uri_complete?: string
  readonly expires_at?: string
  readonly expires_in_seconds?: number
  readonly directory?: string
  readonly logs?: string
  readonly result?: unknown
}

const ControlRequestSchema = Schema.Union([
  Schema.Struct({ method: Schema.Literals(['status', 'shutdown', 'login_cancel', 'logout', 'diagnostics']) }),
  Schema.Struct({
    method: Schema.Literal('login_start'),
    coordinator_url: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048)),
    display_name: Schema.optionalKey(DeviceLoginCreateInput.fields.display_name),
  }),
  Schema.Struct({ method: Schema.Literal('resolve_thread_directory'), thread_id: UUID }),
  Schema.Struct({ method: Schema.Literal('thread_request'), thread_id: UUID, request: WorkerRequest }),
])
const PendingLoginSchema = Schema.Struct({
  status: Schema.Literal('pending'),
  session_id: Schema.String,
  user_code: Schema.String,
  verification_uri: Schema.String,
  verification_uri_complete: Schema.String,
  expires_at: Schema.String,
  expires_in_seconds: Schema.Number,
})
const ErrorSummary = Schema.Struct({ code: Schema.String, message: Schema.String, at: Schema.String })
const ControlResponseSchema = Schema.Struct({
  ok: Schema.Boolean,
  code: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.Literals(['pending', 'already_bound'])),
  pid: Schema.optionalKey(Schema.Int),
  batond_version: Schema.optionalKey(Schema.String),
  protocol_version: Schema.optionalKey(Schema.Int),
  platform: Schema.optionalKey(Schema.String),
  state: Schema.optionalKey(Schema.Literals(['unbound', 'authorizing', 'connecting', 'syncing', 'online', 'rejected'])),
  coordinator_url: Schema.optionalKey(Schema.String),
  node_id: Schema.optionalKey(Schema.String),
  employee_id: Schema.optionalKey(Schema.String),
  display_name: Schema.optionalKey(Schema.String),
  rejection: Schema.optionalKey(ErrorSummary),
  pending_login: Schema.optionalKey(PendingLoginSchema),
  last_error: Schema.optionalKey(ErrorSummary),
  service_installed: Schema.optionalKey(Schema.Boolean),
  session_id: Schema.optionalKey(Schema.String),
  user_code: Schema.optionalKey(Schema.String),
  verification_uri: Schema.optionalKey(Schema.String),
  verification_uri_complete: Schema.optionalKey(Schema.String),
  expires_at: Schema.optionalKey(Schema.String),
  expires_in_seconds: Schema.optionalKey(Schema.Number),
  directory: Schema.optionalKey(Schema.String),
  logs: Schema.optionalKey(Schema.String),
})
export const decodeControlRequest = (value: unknown): ControlRequest => {
  const request = Schema.decodeUnknownSync(ControlRequestSchema)(value, { onExcessProperty: 'error' })
  if (request.method === 'login_start') return { ...request, coordinator_url: coordinatorURL(request.coordinator_url) }
  return request
}
export const decodeControlResponse = Schema.decodeUnknownSync(ControlResponseSchema)

export function controlPaths(
  dataDirectory: string,
  options: {
    readonly platform?: NodeJS.Platform
    readonly runtimeDirectory?: string
    readonly uid?: number
  } = {},
) {
  const root = resolve(dataDirectory)
  const platform = options.platform ?? process.platform
  const hash = createHash('sha256').update(root).digest('hex')
  let endpoint: string
  if (platform === 'win32') endpoint = `\\\\.\\pipe\\baton-ctl-${hash.slice(0, 24)}`
  else {
    const filename = `ctl-${hash.slice(0, 20)}.sock`
    endpoint = join(root, 'ipc', filename)
    if (Buffer.byteLength(endpoint) > 103) {
      const runtime = options.runtimeDirectory ?? process.env.XDG_RUNTIME_DIR
      const directory =
        runtime && Buffer.byteLength(join(runtime, 'baton', filename)) <= 103
          ? join(runtime, 'baton')
          : `/tmp/baton-${options.uid ?? process.getuid?.() ?? 'user'}`
      endpoint = join(directory, filename)
    }
  }
  return {
    root,
    endpoint,
    ipcDirectory: platform === 'win32' ? join(root, 'ipc') : dirname(endpoint),
    token: join(root, 'control.token'),
  }
}
