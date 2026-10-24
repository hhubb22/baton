import { Effect } from 'effect'
import { dirname, isAbsolute } from 'node:path'
import type { RuntimeAgent, WorkerOpenConfig } from '@baton/protocol'
import { inspectCursorSdk } from './cursor/sdk-loader.ts'
import { makeCursorAgentFactory, probeCursor } from './cursor/index.ts'
import { makeShellAgentFactory } from './shell/index.ts'
import { startProcessWatchdog } from '../platform/process.ts'
import { currentBatondCommand } from '../daemon/host.ts'
import { AgentError } from '../worker/agent.ts'

/** Delivery combinations are enabled only after real send, cancellation, history and resume validation. */
const verifiedCombinations = new Set(['darwin-arm64'])

/** The Thread working directory and the private directory beside the native mapping. */
const cursorPaths = (config: WorkerOpenConfig) => {
  const statePath = config.adapter_config.state_path
  if (!statePath || !isAbsolute(statePath)) throw new AgentError('Cursor requires an absolute private state_path')
  return { workingDirectory: config.working_directory, privateDirectory: dirname(statePath) }
}

export async function probeLocalCursor(): Promise<RuntimeAgent> {
  const platform = `${process.platform}-${process.arch}`
  const disabled = { create: false, queue: true, steer: false, stop: true, resume: false, switch_model: false }
  let base: RuntimeAgent = {
    agent_type: 'cursor',
    version: 'unknown',
    status: 'unverified',
    models: [],
    default_model: '',
    capabilities: disabled,
  }
  try {
    const installed = inspectCursorSdk()
    base = { ...base, version: installed.version }
    if (installed.missingAssets.length || installed.version !== installed.platformVersion)
      return {
        ...base,
        status: 'unavailable',
        reason: 'Cursor SDK 安装不完整或平台包版本不符',
      }
  } catch {
    return { ...base, status: 'unavailable', reason: 'Cursor SDK 安装不完整' }
  }
  if (!process.env.CURSOR_API_KEY?.trim())
    return { ...base, status: 'unavailable', reason: '需要显式配置 CURSOR_API_KEY' }
  if (process.platform === 'win32') return { ...base, reason: 'Windows Cursor 执行、sandbox 与进程回收组合尚未验证' }
  const invocation = currentBatondCommand()
  try {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const watchdog = yield* Effect.acquireRelease(
            Effect.promise(() =>
              startProcessWatchdog({ file: invocation.executable, args: [...invocation.args, 'watchdog'] }),
            ),
            (owned) => Effect.promise(() => owned.close()),
          )
          return yield* probeCursor({
            command: { file: invocation.executable, args: invocation.args },
            watchdog,
          }).pipe(Effect.timeout('30 seconds'))
        }),
      ),
    )
    const version = typeof result.details.version === 'string' ? result.details.version : 'unknown'
    const integrity = result.details.integrity === true
    const sandboxHelper = result.details.sandboxHelper === true
    const report = {
      ...base,
      version,
      default_model: result.authenticated === 'valid' ? 'default' : '',
      models: [...new Set(result.models)].map((id) => ({ id, name: id })),
    }
    if (!integrity || !sandboxHelper)
      return {
        ...report,
        status: 'unavailable',
        reason: integrity ? 'Cursor SDK 的本机辅助程序不可用' : 'Cursor SDK 安装不完整',
      }
    if (result.authenticated !== 'valid')
      return {
        ...report,
        status: result.authenticated === 'missing' ? 'unavailable' : 'unverified',
        reason: result.authenticated === 'missing' ? '需要显式配置 CURSOR_API_KEY' : 'Cursor 认证状态尚未确认',
      }
    if (version !== '1.0.35' || !verifiedCombinations.has(platform))
      return { ...report, reason: `Cursor SDK ${version} / ${platform} 尚未通过执行、停止、历史与恢复验证` }
    return {
      ...report,
      status: 'available',
      capabilities: { ...disabled, create: true, resume: true },
      ...(result.reason ? { reason: 'Cursor 模型目录暂不可读，可使用默认模型' } : {}),
    }
  } catch {
    return { ...base, reason: 'Cursor 依赖、认证或只读探测暂不可用' }
  }
}

export const agentRegistry = {
  cursor: {
    type: 'cursor',
    makeFactory: makeCursorAgentFactory,
    probe: probeLocalCursor,
    paths: cursorPaths,
  },
  shell: { type: 'shell', makeFactory: makeShellAgentFactory },
} as const
