import { randomUUID } from 'node:crypto'
import { posix, win32 } from 'node:path'
import {
  BrowseRootsRequest,
  BrowseRootsResult,
  FileRequest,
  FileResult,
  FileView,
  NodeStatus,
  ProjectExecResult,
  RuntimeRoot,
  RuntimeRepo,
  SubscriptionLoginResult,
  SubscriptionLoginResponse,
  type RuntimeReport,
} from '@baton/protocol'
import { Effect, Schema } from 'effect'
import type { Gateway } from './gateway.ts'
import { AppError } from './errors.ts'
import * as Nodes from './nodes.ts'
import { directoryAllowed } from './threads-core.ts'
import { hasControlCharacters } from './auth.ts'

export type DeviceGateway = Pick<Gateway, 'request'>
const invalidResponse = () => new AppError(503, 'invalid_node_response', '设备未确认请求内容')
const decode = <A>(schema: Schema.Decoder<A>, input: unknown) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(schema)(input),
    catch: invalidResponse,
  })
const authorize = Effect.fn('DeviceManagement.authorize')(function* (employeeId: string, nodeId: string) {
  const node = yield* decode(NodeStatus, yield* Nodes.getNode(employeeId, nodeId))
  if (node.revocation_status !== 'none') return yield* Effect.fail(new AppError(403, 'forbidden', '不能操作该设备'))
  if (!node.online) return yield* Effect.fail(new AppError(503, 'node_offline'))
  if (!node.synced) return yield* Effect.fail(new AppError(503, 'node_syncing'))
  return node
})
const request = (
  gateway: DeviceGateway,
  employeeId: string,
  nodeId: string,
  body: Parameters<Gateway['request']>[2],
  timeoutMs: number,
) =>
  Effect.tryPromise({
    try: () => gateway.request(nodeId, employeeId, body, timeoutMs),
    catch: (error) => (error instanceof AppError ? error : new AppError(503, 'node_unavailable', '设备未确认请求')),
  })
function checkedResult(
  result: { ok: boolean; operation_id: string; code?: string; message?: string },
  operationId: string,
): void {
  if (result.operation_id !== operationId) throw invalidResponse()
  if (!result.ok)
    throw new AppError(
      result.code === 'not_found'
        ? 404
        : ['invalid_path', 'invalid_request'].includes(result.code ?? '')
          ? 400
          : ['path_escaped', 'root_forbidden'].includes(result.code ?? '')
            ? 403
            : ['not_text', 'unsupported_type'].includes(result.code ?? '')
              ? 415
              : 503,
      result.code ?? 'node_unavailable',
      result.message ?? '设备未确认请求',
    )
}
const confirm = (result: Parameters<typeof checkedResult>[0], operationId: string) =>
  Effect.try({
    try: () => checkedResult(result, operationId),
    catch: (error) => (error instanceof AppError ? error : invalidResponse()),
  })
const overlay = Effect.fn('DeviceManagement.overlay')(function* (
  employeeId: string,
  nodeId: string,
  fields: Partial<RuntimeReport>,
) {
  const current = yield* authorize(employeeId, nodeId)
  if (!current.runtime_report)
    return yield* Effect.fail(new AppError(503, 'runtime_report_unavailable', '设备尚未报告完整能力'))
  return yield* decode(NodeStatus, { ...current, runtime_report: { ...current.runtime_report, ...fields } })
})

export const setProjectExec = Effect.fn('DeviceManagement.setProjectExec')(function* (
  employeeId: string,
  nodeId: string,
  enabled: boolean,
  gateway: DeviceGateway,
) {
  yield* authorize(employeeId, nodeId)
  if (!Schema.is(Schema.Boolean)(enabled)) return yield* Effect.fail(new AppError(400, 'invalid_request'))
  const operationId = randomUUID()
  const result = yield* decode(
    ProjectExecResult,
    yield* request(
      gateway,
      employeeId,
      nodeId,
      { type: 'node.project_exec_set', operation_id: operationId, enabled },
      5000,
    ),
  )
  yield* confirm(result, operationId)
  if (result.type !== 'node.project_exec_result' || !result.exec || result.exec.enabled !== enabled)
    return yield* Effect.fail(invalidResponse())
  return yield* overlay(employeeId, nodeId, { exec: result.exec })
})

export const updateBrowseRoots = Effect.fn('DeviceManagement.updateBrowseRoots')(function* (
  employeeId: string,
  nodeId: string,
  action: 'add' | 'remove',
  path: string,
  gateway: DeviceGateway,
) {
  const node = yield* authorize(employeeId, nodeId)
  const operationId = randomUUID()
  const body = yield* Effect.try({
    try: () =>
      Schema.decodeUnknownSync(BrowseRootsRequest)({
        type: 'node.browse_roots_set',
        operation_id: operationId,
        action,
        path,
      }),
    catch: () => new AppError(400, 'invalid_request'),
  })
  if (!path || Buffer.byteLength(path) > 4096 || hasControlCharacters(path))
    return yield* Effect.fail(new AppError(400, 'invalid_path'))
  const parser = node.system === 'windows' ? win32 : posix
  if (
    (action === 'add' && !parser.isAbsolute(path)) ||
    (action === 'remove' && !parser.isAbsolute(path) && !/^[a-z][a-z0-9._-]{0,63}$/.test(path))
  )
    return yield* Effect.fail(new AppError(400, 'invalid_path'))
  const result = yield* decode(BrowseRootsResult, yield* request(gateway, employeeId, nodeId, body, 5000))
  yield* confirm(result, operationId)
  if (!result.roots || !result.repos || result.roots.length > 4096 || result.repos.length > 128)
    return yield* Effect.fail(invalidResponse())
  const roots = yield* decode(Schema.Array(RuntimeRoot), result.roots)
  const repos = yield* decode(Schema.Array(RuntimeRepo), result.repos)
  if (
    new Set(roots.map((root) => root.root_id)).size !== roots.length ||
    new Set(roots.map((root) => root.path)).size !== roots.length ||
    roots.some((root) => !directoryAllowed(node.system, root.path, [root])) ||
    repos.some((repo) => !directoryAllowed(node.system, repo.path, roots)) ||
    (action === 'remove' && roots.some((root) => root.path === path || root.root_id === path)) ||
    (action === 'add' && roots.length === 0)
  )
    return yield* Effect.fail(invalidResponse())
  return yield* overlay(employeeId, nodeId, { roots, repos })
})

export const startSubscriptionLogin = Effect.fn('DeviceManagement.startSubscriptionLogin')(function* (
  employeeId: string,
  nodeId: string,
  provider: string,
  gateway: DeviceGateway,
) {
  yield* authorize(employeeId, nodeId)
  if (!['openai-codex', 'chatgpt', 'ChatGPT', 'xai', 'xAI'].includes(provider))
    return yield* Effect.fail(new AppError(400, 'invalid_provider', '订阅服务无效'))
  const normalized = provider === 'xai' || provider === 'xAI' ? 'xai' : 'openai-codex'
  const operationId = randomUUID()
  const result = yield* decode(
    SubscriptionLoginResult,
    yield* request(
      gateway,
      employeeId,
      nodeId,
      { type: 'node.subscription_login', operation_id: operationId, provider: normalized },
      12000,
    ),
  )
  yield* confirm(result, operationId)
  let verification: URL
  try {
    verification = new URL(result.verification_uri ?? '')
  } catch {
    return yield* Effect.fail(invalidResponse())
  }
  if (
    result.provider !== normalized ||
    !result.user_code ||
    Buffer.byteLength(result.user_code) > 1024 ||
    hasControlCharacters(result.user_code) ||
    verification.protocol !== 'https:' ||
    verification.username ||
    verification.password ||
    !Number.isSafeInteger(result.expires_in_seconds) ||
    result.expires_in_seconds! <= 0 ||
    result.expires_in_seconds! > 900
  )
    return yield* Effect.fail(invalidResponse())
  yield* authorize(employeeId, nodeId)
  return yield* decode(SubscriptionLoginResponse, result)
})

export const browse = Effect.fn('DeviceManagement.browse')(function* (
  employeeId: string,
  nodeId: string,
  query: { root_id?: string; path?: string; cursor?: string },
  gateway: DeviceGateway,
) {
  yield* authorize(employeeId, nodeId)
  const operationId = randomUUID()
  const body = yield* Effect.try({
    try: () => Schema.decodeUnknownSync(FileRequest)({ type: 'files.browse', operation_id: operationId, ...query }),
    catch: () => new AppError(400, 'invalid_path'),
  })
  const path = (body.path ?? '').replace(/^\.\//, '').replace(/\/$/, '')
  if (
    (!body.root_id && (path || body.cursor)) ||
    (body.root_id && !/^[a-z][a-z0-9._-]{0,63}$/.test(body.root_id)) ||
    Buffer.byteLength(path) > 4096 ||
    posix.isAbsolute(path) ||
    /[\\:]/.test(path) ||
    hasControlCharacters(path) ||
    path.split('/').includes('..') ||
    (body.cursor &&
      (Buffer.byteLength(body.cursor) > 4096 || /[/\\]/.test(body.cursor) || hasControlCharacters(body.cursor)))
  )
    return yield* Effect.fail(new AppError(400, 'invalid_path'))
  const result = yield* decode(FileResult, yield* request(gateway, employeeId, nodeId, body, 12000))
  yield* confirm(result, operationId)
  if (
    !['roots', 'directory', 'file'].includes(result.kind ?? '') ||
    (!body.root_id && result.kind !== 'roots') ||
    (result.kind === 'roots' && !Array.isArray(result.roots)) ||
    (result.kind === 'directory' && !Array.isArray(result.entries)) ||
    (body.root_id && result.root_id !== body.root_id) ||
    (result.kind === 'file' && typeof result.content !== 'string')
  )
    return yield* Effect.fail(invalidResponse())
  if (
    result.kind === 'file' &&
    (result.content?.includes('\0') || Buffer.from(result.content ?? '').toString('utf8') !== result.content)
  )
    return yield* Effect.fail(new AppError(415, 'not_text', '只能预览文本，不能通过浏览接口读取该文件'))
  if (
    (result.kind === 'roots' && body.root_id) ||
    (result.kind !== 'roots' && result.path !== (path === '.' ? '' : path))
  )
    return yield* Effect.fail(invalidResponse())
  yield* authorize(employeeId, nodeId)
  const { content, ...metadata } = result
  return yield* decode(FileView, {
    ...metadata,
    ...(result.kind === 'file' ? { content } : {}),
    node_id: nodeId,
    truncated: result.truncated ?? false,
  })
})
