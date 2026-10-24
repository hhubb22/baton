import {
  BrowseRootsRequest,
  ProjectExecRequest,
  SubscriptionLoginRequest,
  SubscriptionLoginResponse,
  type BrowseRootsResult,
  type FileRequest,
  type FileResult,
  type ProjectExecResult,
  type ProjectRuntime,
  type RuntimeReport,
  type SubscriptionLoginResult,
} from '@baton/protocol'
import { Schema } from 'effect'
import { ensurePrivateDirectory } from '../platform/private.ts'
import { DeviceError, defaultProjectShell, readProjectExec, setProjectExec, updateBrowseRoots } from './config.ts'
import { boundRuntimeReport } from './report.ts'
import { browseFiles } from './files.ts'
import { scanRuntimeRoots } from './scan.ts'

export * from './config.ts'
export { boundRuntimeReport } from './report.ts'
export { parseThreadAttachments } from './attachments.ts'
export { runDeviceCLI } from './cli.ts'
export { browseFiles } from './files.ts'
export { scanRuntimeRoots, sanitizeOrigin } from './scan.ts'
export type DeviceRequest = FileRequest | BrowseRootsRequest | ProjectExecRequest | SubscriptionLoginRequest
export type DeviceResult = FileResult | BrowseRootsResult | ProjectExecResult | SubscriptionLoginResult
export interface DeviceRuntime {
  probe(signal?: AbortSignal): Promise<ProjectRuntime>
  startDeviceLogin(provider: string, signal?: AbortSignal, onDone?: () => void): Promise<SubscriptionLoginResponse>
}
export interface DeviceServiceOptions {
  readonly dataDirectory: string
  readonly runtime?: DeviceRuntime
  readonly onChanged?: () => void | Promise<void>
}
export type DeviceReport = Pick<RuntimeReport, 'roots' | 'repos' | 'exec' | 'truncated' | 'project_runtime'>
export interface DeviceService {
  handle(body: DeviceRequest, signal?: AbortSignal): Promise<DeviceResult>
  collect(signal?: AbortSignal): Promise<DeviceReport>
  report(signal?: AbortSignal): Promise<DeviceReport>
  close(): Promise<void>
}
const Provider = Schema.Literals(['openai-codex', 'chatgpt', 'ChatGPT', 'xai', 'xAI'])
export function normalizeProvider(value: string): 'openai-codex' | 'xai' {
  const provider = Schema.decodeUnknownSync(Provider)(value)
  return provider === 'xai' || provider === 'xAI' ? 'xai' : 'openai-codex'
}

function decodeRequest<A>(schema: Schema.Decoder<A>, input: unknown): A {
  try {
    return Schema.decodeUnknownSync(schema)(input)
  } catch {
    throw new DeviceError('invalid_request', '设备管理请求无效')
  }
}

export async function makeDeviceService(options: DeviceServiceOptions): Promise<DeviceService> {
  await ensurePrivateDirectory(options.dataDirectory)
  const lifetime = new AbortController()
  const active = new Set<Promise<unknown>>()
  const loginStarts = new Map<string, Promise<unknown>>()
  const changed = () => {
    void Promise.resolve()
      .then(() => options.onChanged?.())
      .catch(() => undefined)
  }
  const collect = async (signal?: AbortSignal): Promise<DeviceReport> => {
    const combined = AbortSignal.any([lifetime.signal, AbortSignal.timeout(2000), ...(signal ? [signal] : [])])
    if (lifetime.signal.aborted || signal?.aborted) combined.throwIfAborted()
    const probing = options.runtime?.probe(combined).catch(() => undefined)
    const scan = await scanRuntimeRoots(options.dataDirectory, combined).catch(() => ({
      roots: [],
      repos: [],
      truncated: true,
    }))
    const exec = await readProjectExec(options.dataDirectory).catch(() => {
      scan.truncated = true
      return { enabled: false, shell: defaultProjectShell() }
    })
    const runtime = await probing
    return boundRuntimeReport({ ...scan, exec, ...(runtime ? { project_runtime: runtime } : {}) })
  }
  const handle = async (body: DeviceRequest, signal?: AbortSignal): Promise<DeviceResult> => {
    const combined = signal ? AbortSignal.any([lifetime.signal, signal]) : lifetime.signal
    const run = async (): Promise<DeviceResult> => {
      if (body.type === 'files.browse') return browseFiles(options.dataDirectory, body, combined)
      const base = { operation_id: body.operation_id }
      try {
        combined.throwIfAborted()
        if (body.type === 'node.project_exec_set') {
          const req = decodeRequest(ProjectExecRequest, body)
          const exec = await setProjectExec(options.dataDirectory, req.enabled)
          changed()
          return { ...base, type: 'node.project_exec_result', ok: true, exec }
        }
        if (body.type === 'node.browse_roots_set') {
          const req = decodeRequest(BrowseRootsRequest, body)
          const roots = await updateBrowseRoots(options.dataDirectory, req.action, req.path)
          const scan = await scanRuntimeRoots(options.dataDirectory, combined)
          changed()
          return {
            ...base,
            type: 'node.browse_roots_result',
            ok: true,
            roots: roots.map((root) => ({ root_id: root.id, path: root.path })),
            repos: scan.repos,
          }
        }
        const req = decodeRequest(SubscriptionLoginRequest, body)
        let provider: 'openai-codex' | 'xai'
        try {
          provider = normalizeProvider(req.provider)
        } catch {
          throw new DeviceError('invalid_request', '订阅服务无效')
        }
        if (!options.runtime) throw new DeviceError('login_unavailable', 'Project Runtime 不可用')
        const runtime = options.runtime
        const previous = loginStarts.get(provider) ?? Promise.resolve()
        const starting = previous
          .catch(() => undefined)
          .then(() => {
            combined.throwIfAborted()
            return runtime.startDeviceLogin(provider, combined, changed)
          })
        loginStarts.set(provider, starting)
        let login: SubscriptionLoginResponse
        try {
          login = Schema.decodeUnknownSync(SubscriptionLoginResponse)(await starting)
        } finally {
          if (loginStarts.get(provider) === starting) loginStarts.delete(provider)
        }
        if (
          login.provider !== provider ||
          !login.user_code ||
          !login.verification_uri ||
          login.expires_in_seconds <= 0 ||
          login.expires_in_seconds > 3600
        )
          throw new DeviceError('login_unavailable', '无法取得订阅登录验证码')
        return {
          ...base,
          type: 'node.subscription_login_result',
          ok: true,
          ...login,
          expires_in_seconds: Math.min(900, login.expires_in_seconds),
        }
      } catch (error) {
        const type =
          body.type === 'node.project_exec_set'
            ? 'node.project_exec_result'
            : body.type === 'node.browse_roots_set'
              ? 'node.browse_roots_result'
              : 'node.subscription_login_result'
        const code =
          error instanceof DeviceError
            ? error.code
            : body.type === 'node.subscription_login'
              ? 'login_unavailable'
              : 'config_unavailable'
        return {
          ...base,
          type,
          ok: false,
          code,
          message: error instanceof DeviceError ? error.message : '设备未能确认请求',
        }
      }
    }
    const pending = run()
    active.add(pending)
    try {
      return await pending
    } finally {
      active.delete(pending)
    }
  }
  return {
    handle,
    collect,
    report: collect,
    close: async () => {
      lifetime.abort()
      await Promise.allSettled(active)
    },
  }
}
