import { Effect } from 'effect'
import { DEFAULT_MODEL } from '@t3tools/contracts'
import { agentCapabilities } from './capabilities.ts'
import { dirname, isAbsolute } from 'node:path'
import type { RuntimeAgent, WorkerOpenConfig } from '@baton/protocol'
import type { ProbeResult } from '../agent-host/protocol.ts'
import { inspectCursorSdk } from './cursor/sdk-loader.ts'
import { makeCursorAgentFactory, probeCursor } from './cursor/index.ts'
import { makeCodexAgentFactory, probeCodex } from './codex/index.ts'
import { makePiAgentFactory, probePi } from './pi/index.ts'
import { makeKiroAgentFactory, probeKiro } from './kiro/index.ts'
import { makeShellAgentFactory } from './shell/index.ts'
import { startProcessWatchdog } from '../platform/process.ts'
import { currentBatondCommand } from '../daemon/host.ts'
import { AgentError } from '../worker/agent.ts'

/** Adapter combinations validated through the host with upstream offline transcripts. */
const verifiedCombinations = new Set(['darwin-arm64'])
const verifiedProviderVersions = { pi: '1.0.0', codex: '0.156.1', kiro: '2.32.0' }

/** The Thread working directory and the private directory beside the native mapping. */
const agentPaths = (label: string) => (config: WorkerOpenConfig) => {
  const statePath = config.adapter_config.state_path
  if (!statePath || !isAbsolute(statePath)) throw new AgentError(`${label} requires an absolute private state_path`)
  return { workingDirectory: config.working_directory, privateDirectory: dirname(statePath) }
}

const cursorPaths = agentPaths('Cursor')
const narrowed = { create: false, queue: true, steer: false, stop: true, resume: false, switch_model: false }

/** Availability gates creation and resume; active steering follows the registered provider. */
export function hostedAgentReport(
  agentType: 'pi' | 'codex' | 'kiro',
  result: ProbeResult,
  missingReason: string,
): RuntimeAgent {
  const version = typeof result.details.version === 'string' ? result.details.version : 'unknown'
  const platform =
    typeof result.details.platform === 'string' ? result.details.platform : `${process.platform}-${process.arch}`
  const models = [...new Set(result.models)].map((id) => ({ id, name: id }))
  const base: RuntimeAgent = {
    agent_type: agentType,
    version,
    status: 'unverified',
    models,
    default_model: '',
    capabilities: narrowed,
  }
  if (result.details.installed === false)
    return { ...base, status: 'unavailable', reason: result.reason ?? missingReason }
  if (result.authenticated === 'missing')
    return { ...base, status: 'unavailable', reason: result.reason ?? missingReason }
  if (result.authenticated !== 'valid') return { ...base, reason: result.reason ?? `${agentType} 认证状态尚未确认` }
  const ready = {
    ...base,
    default_model: models[0]?.id || (agentType === 'codex' ? DEFAULT_MODEL : 'default'),
    ...(result.models.length === 0 ? { reason: result.reason ?? '模型目录暂不可读，可使用默认模型' } : {}),
  }
  if (version !== verifiedProviderVersions[agentType] || !verifiedCombinations.has(platform))
    return { ...ready, reason: `${agentType} ${version} / ${platform} 尚未通过执行、停止与恢复验证` }
  return {
    ...ready,
    status: 'available',
    capabilities: agentCapabilities[agentType],
  }
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
      return { ...report, reason: `Cursor SDK ${version} / ${platform} 尚未通过执行、停止与恢复验证` }
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

const probeHost = (probe: typeof probeCursor) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const watchdog = yield* Effect.acquireRelease(
          Effect.promise(() =>
            startProcessWatchdog({
              file: currentBatondCommand().executable,
              args: [...currentBatondCommand().args, 'watchdog'],
            }),
          ),
          (owned) => Effect.promise(() => owned.close()),
        )
        const invocation = currentBatondCommand()
        return yield* probe({
          command: { file: invocation.executable, args: invocation.args },
          watchdog,
        }).pipe(Effect.timeout('30 seconds'))
      }),
    ),
  )

export async function probeLocalPi(): Promise<RuntimeAgent> {
  try {
    return hostedAgentReport('pi', await probeHost(probePi), 'Pi CLI 未安装或尚未认证')
  } catch {
    return hostedAgentReport(
      'pi',
      {
        authenticated: 'unknown',
        models: [],
        details: { installed: false, version: 'unknown', platform: `${process.platform}-${process.arch}` },
        reason: 'Pi 依赖或只读探测暂不可用',
      },
      'Pi CLI 未安装或尚未认证',
    )
  }
}

export async function probeLocalCodex(): Promise<RuntimeAgent> {
  try {
    return hostedAgentReport('codex', await probeHost(probeCodex), 'Codex CLI 未安装或尚未认证')
  } catch {
    return hostedAgentReport(
      'codex',
      {
        authenticated: 'unknown',
        models: [],
        details: { installed: false, version: 'unknown', platform: `${process.platform}-${process.arch}` },
        reason: 'Codex 依赖或只读探测暂不可用',
      },
      'Codex CLI 未安装或尚未认证',
    )
  }
}

export async function probeLocalKiro(): Promise<RuntimeAgent> {
  try {
    return hostedAgentReport('kiro', await probeHost(probeKiro), 'Kiro CLI 未安装或尚未认证')
  } catch {
    return hostedAgentReport(
      'kiro',
      {
        authenticated: 'unknown',
        models: [],
        details: { installed: false, version: 'unknown', platform: `${process.platform}-${process.arch}` },
        reason: 'Kiro 依赖或只读探测暂不可用',
      },
      'Kiro CLI 未安装或尚未认证',
    )
  }
}

export async function probeLocalAgents(): Promise<RuntimeAgent[]> {
  return Promise.all([probeLocalCursor(), probeLocalPi(), probeLocalCodex(), probeLocalKiro()])
}

export const agentRegistry = {
  cursor: {
    type: 'cursor',
    capabilities: agentCapabilities.cursor,
    makeFactory: makeCursorAgentFactory,
    probe: probeLocalCursor,
    paths: cursorPaths,
  },
  pi: {
    type: 'pi',
    capabilities: agentCapabilities.pi,
    makeFactory: makePiAgentFactory,
    probe: probeLocalPi,
    paths: agentPaths('Pi'),
  },
  codex: {
    type: 'codex',
    capabilities: agentCapabilities.codex,
    makeFactory: makeCodexAgentFactory,
    probe: probeLocalCodex,
    paths: agentPaths('Codex'),
  },
  kiro: {
    type: 'kiro',
    capabilities: agentCapabilities.kiro,
    makeFactory: makeKiroAgentFactory,
    probe: probeLocalKiro,
    paths: agentPaths('Kiro'),
  },
  shell: { type: 'shell', capabilities: agentCapabilities.shell, makeFactory: makeShellAgentFactory },
} as const
