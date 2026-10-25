import { Schema } from 'effect'
import { UUID, jsonLimit, summary } from './common.ts'
import { MaxMessageBytes } from './constants.ts'
import {
  BrowseRootsRequest,
  BrowseRootsResult,
  BrowseRootsGetRequest,
  BrowseRootsGetResult,
  Envelope,
  FileRequest,
  FileResult,
  Frame,
  NodeSyncRequest,
  NodeSyncResult,
  ProjectExecRequest,
  ProjectExecResult,
  ProjectRunCommand,
  ProjectRuntimeRequest,
  ProjectRuntimeResult,
  RuntimeReportRequest,
  RuntimeReportResult,
  SessionRequest,
  SessionResult,
  ThreadCommand,
  ThreadCommandResult,
  ThreadReport,
  ThreadReportResult,
  SubscriptionLoginRequest,
  SubscriptionLoginResult,
} from './dto.ts'

// 仅收窄帧字段，父结构的整体容量检查继续适用。
const preserveChecks = { unsafePreserveChecks: true } as const
export const AuthFrame = Frame.mapFields(
  (fields) => ({ ...fields, kind: Schema.Literal('auth'), token: summary(4096), incarnation: UUID }),
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

export const NodeToControlBody = Schema.Union([
  NodeSyncRequest,
  ThreadCommandResult,
  ThreadReport,
  RuntimeReportRequest,
  FileResult,
  SessionResult,
  ProjectExecResult,
  BrowseRootsResult,
  BrowseRootsGetResult,
  SubscriptionLoginResult,
  ProjectRuntimeRequest,
])
export type NodeToControlBody = typeof NodeToControlBody.Type
export const ControlToNodeBody = Schema.Union([
  NodeSyncResult,
  ThreadCommand,
  ThreadReportResult,
  RuntimeReportResult,
  FileRequest,
  SessionRequest,
  ProjectExecRequest,
  BrowseRootsRequest,
  BrowseRootsGetRequest,
  SubscriptionLoginRequest,
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
