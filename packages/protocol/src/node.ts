import { Schema } from 'effect'
import { NodeVersionIncompatibility } from './release.ts'
import { PROTOCOL_VERSION } from './release.mjs'
import { UUID, Text, jsonLimit, summary } from './common.ts'
import { MaxMessageBytes } from './constants.ts'
import {
  BrowseRootsRequest,
  BrowseRootsGetRequest,
  BrowseRootsResult,
  BrowseRootsGetResult,
  FileRequest,
  FileResult,
  NodeSyncRequest,
  NodeSyncResult,
  NodeUpgradeStateRequest,
  NodeUpgradeStateResult,
  ProjectExecRequest,
  ProjectExecResult,
  RuntimeReportRequest,
  RuntimeReportResult,
  SubscriptionLoginRequest,
  SubscriptionLoginResult,
  ModelConnectionRequest,
  ModelConnectionResult,
  SubscriptionLogoutRequest,
  SubscriptionLogoutResult,
} from './device.ts'
import { ProjectRunCommand, ProjectRuntimeRequest, ProjectRuntimeResult } from './project.ts'
import {
  SessionRequest,
  SessionResult,
  ThreadCommand,
  ThreadCommandResult,
  ThreadReport,
  ThreadReportResult,
} from './thread.ts'

export const Route = Schema.Struct({
  to: Text,
})
export type Route = typeof Route.Type

export const Source = Schema.Struct({
  kind: Schema.Literals(['node', 'control']),
  node_id: Schema.optionalKey(UUID),
  employee_id: Schema.optionalKey(UUID),
  credential_id: Schema.optionalKey(UUID),
  incarnation: Schema.optionalKey(Text),
  conn_id: Schema.optionalKey(Text),
})
export type Source = typeof Source.Type

export const Envelope = Schema.Struct({
  version: Schema.Literal(PROTOCOL_VERSION),
  message_id: UUID,
  route: Route,
  priority: Schema.Literals(['control', 'output', '']),
  correlation_id: Schema.optionalKey(summary(128)),
  body: Schema.optionalKey(Schema.Json),
  source: Schema.optionalKey(Schema.NullOr(Source)),
}).check(jsonLimit(256 * 1024))
export type Envelope = typeof Envelope.Type

export const Frame = Schema.Struct({
  kind: Schema.Literals(['auth', 'auth_result', 'heartbeat', 'envelope', 'error']),
  ok: Schema.optionalKey(Schema.Boolean),
  code: Schema.optionalKey(Text),
  message: Schema.optionalKey(Text),
  token: Schema.optionalKey(Text),
  incarnation: Schema.optionalKey(Text),
  daemon_version: Schema.optionalKey(summary(128)),
  protocol_version: Schema.optionalKey(Schema.Int),
  version_incompatibility: Schema.optionalKey(NodeVersionIncompatibility),
  correlation_id: Schema.optionalKey(Text),
  envelope: Schema.optionalKey(Schema.Json),
}).check(jsonLimit(256 * 1024))
export type Frame = typeof Frame.Type

// 仅收窄帧字段，父结构的整体容量检查继续适用。
const preserveChecks = { unsafePreserveChecks: true } as const
export const AuthFrame = Frame.mapFields(
  (fields) => ({
    ...fields,
    kind: Schema.Literal('auth'),
    token: summary(4096),
    incarnation: UUID,
    daemon_version: summary(128).check(Schema.isMinLength(1)),
    protocol_version: Schema.Int,
  }),
  preserveChecks,
)
export const AuthResultFrame = Frame.mapFields(
  (fields) => ({ ...fields, kind: Schema.Literal('auth_result') }),
  preserveChecks,
)
export const HeartbeatFrame = Frame.mapFields(
  (fields) => ({ ...fields, kind: Schema.Literal('heartbeat') }),
  preserveChecks,
)
export const EnvelopeFrame = Frame.mapFields(
  (fields) => ({ ...fields, kind: Schema.Literal('envelope'), envelope: Envelope }),
  preserveChecks,
)
export const ErrorFrame = Frame.mapFields((fields) => ({ ...fields, kind: Schema.Literal('error') }), preserveChecks)
export const NodeFrame = Schema.Union([AuthFrame, AuthResultFrame, HeartbeatFrame, EnvelopeFrame, ErrorFrame]).check(
  jsonLimit(MaxMessageBytes),
)
export type NodeFrame = typeof NodeFrame.Type

export const TelemetryExport = Schema.Struct({
  type: Schema.Literal('telemetry.export'),
  signal: Schema.Literals(['traces', 'logs', 'metrics']),
  payload: Schema.Json,
}).check(jsonLimit(MaxMessageBytes))
export type TelemetryExport = typeof TelemetryExport.Type

export const NodeToControlBody = Schema.Union([
  TelemetryExport,
  NodeSyncRequest,
  NodeUpgradeStateRequest,
  ThreadCommandResult,
  ThreadReport,
  RuntimeReportRequest,
  FileResult,
  SessionResult,
  ProjectExecResult,
  BrowseRootsResult,
  BrowseRootsGetResult,
  SubscriptionLoginResult,
  ModelConnectionResult,
  SubscriptionLogoutResult,
  ProjectRuntimeRequest,
])
export type NodeToControlBody = typeof NodeToControlBody.Type
export const ControlToNodeBody = Schema.Union([
  NodeSyncResult,
  NodeUpgradeStateResult,
  ThreadCommand,
  ThreadReportResult,
  RuntimeReportResult,
  FileRequest,
  SessionRequest,
  ProjectExecRequest,
  BrowseRootsRequest,
  BrowseRootsGetRequest,
  SubscriptionLoginRequest,
  ModelConnectionRequest,
  SubscriptionLogoutRequest,
  ProjectRunCommand,
  ProjectRuntimeResult,
])
export type ControlToNodeBody = typeof ControlToNodeBody.Type
export const NodeBody = Schema.Union([NodeToControlBody, ControlToNodeBody])
export type NodeBody = typeof NodeBody.Type
export type AuthFrame = typeof AuthFrame.Type
export type AuthResultFrame = typeof AuthResultFrame.Type
export type HeartbeatFrame = typeof HeartbeatFrame.Type
export type EnvelopeFrame = typeof EnvelopeFrame.Type
export type ErrorFrame = typeof ErrorFrame.Type
