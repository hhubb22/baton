import { Effect } from 'effect'
import { DEFAULT_MODEL } from '@t3tools/contracts'
import { agentCapabilities, capabilityLimitations } from './capabilities.ts'
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

/** The Thread working directory and the private directory beside the native mapping. */
const agentPaths = (label: string) => (config: WorkerOpenConfig) => {
  const statePath = config.adapter_config.state_path
  if (!statePath || !isAbsolute(statePath)) throw new AgentError(`${label} requires an absolute private state_path`)
  return { workingDirectory: config.working_directory, privateDirectory: dirname(statePath) }
}

const cursorPaths = agentPaths('Cursor')
const narrowed = { create: false, queue: true, steer: false, stop: true, resume: false, switch_model: false }

/** Installed providers accept valid or unknown authentication; diagnostics do not gate creation. */
export function hostedAgentReport(
  agentType: 'cursor' | 'pi' | 'codex' | 'kiro',
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
  if (result.details.installed === false || result.authenticated === 'missing')
    return { ...base, status: 'unavailable', reason: result.reason ?? missingReason }
  if (agentType === 'cursor' && (result.details.integrity === false || result.details.sandboxHelper === false))
    return { ...base, status: 'unavailable', reason: result.reason ?? 'Cursor SDK 安装或本机 sandbox 不可用' }
  const reason = [
    result.reason,
    `${agentType} ${version} / ${platform}`,
    ...(result.authenticated === 'unknown' ? ['认证状态未知，首次执行时由原生程序检查'] : []),
    ...(models.length === 0 ? ['模型目录暂不可读，可使用默认模型'] : []),
    capabilityLimitations[agentType],
  ]
    .filter(Boolean)
    .join('；')
  if (result.details.installed !== true) return { ...base, reason: `${reason}；安装状态尚未确认` }
  return {
    ...base,
    status: 'available',
    default_model:
      agentType === 'cursor' ? 'default' : models[0]?.id || (agentType === 'codex' ? DEFAULT_MODEL : 'default'),
    capabilities: agentCapabilities[agentType],
    reason,
  }
}

export async function probeLocalCursor(): Promise<RuntimeAgent> {
  let version = 'unknown'
  try {
    const installed = inspectCursorSdk()
    version = installed.version
    if (installed.missingAssets.length || installed.version !== installed.platformVersion)
      return hostedAgentReport(
        'cursor',
        {
          authenticated: 'unknown',
          models: [],
          details: { installed: false, version },
          reason: 'Cursor SDK 安装不完整或平台包版本不符',
        },
        'Cursor SDK 安装不完整',
      )
  } catch {
    return hostedAgentReport(
      'cursor',
      { authenticated: 'unknown', models: [], details: { installed: false }, reason: 'Cursor SDK 安装不完整' },
      'Cursor SDK 安装不完整',
    )
  }
  if (!process.env.CURSOR_API_KEY?.trim())
    return hostedAgentReport(
      'cursor',
      { authenticated: 'missing', models: [], details: { installed: true, version } },
      '需要显式配置 CURSOR_API_KEY',
    )
  try {
    return hostedAgentReport('cursor', await probeHost(probeCursor), 'Cursor SDK 未安装或尚未认证')
  } catch {
    return hostedAgentReport(
      'cursor',
      {
        authenticated: 'unknown',
        models: [],
        details: { installed: true, version },
        reason: 'Cursor 只读探测失败或超时',
      },
      'Cursor SDK 未安装或尚未认证',
    )
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
        details: { version: 'unknown', platform: `${process.platform}-${process.arch}` },
        reason: 'Pi 安装状态与只读探测暂不可确认',
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
        details: { version: 'unknown', platform: `${process.platform}-${process.arch}` },
        reason: 'Codex 安装状态与只读探测暂不可确认',
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
        details: { version: 'unknown', platform: `${process.platform}-${process.arch}` },
        reason: 'Kiro 安装状态与只读探测暂不可确认',
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
