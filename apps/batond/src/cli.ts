import { BUNDLED, releaseMetadata, NodeVersionIncompatibility } from '@baton/protocol/release'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import type { Writable } from 'node:stream'
import { realpath } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { parseArgs } from 'node:util'
import { isSea } from 'node:sea'
import { Effect, Schema } from 'effect'
import { telemetryLayer } from '@baton/telemetry'
import {
  DEFAULT_RUNTIME_MODE,
  RuntimeMode,
  ExecutionTimeoutSeconds,
  WorkerIPCMessage,
  WorkerOpen,
  type RuntimeAgent,
  type WorkerRequest,
} from '@baton/protocol'
import { type DaemonWorkerHost, initializeWorkerDirectory } from './daemon/host.ts'
import { workerPaths } from './daemon/paths.ts'
import { IPCError } from './daemon/ipc.ts'
import { ControlClient } from './daemon/control-client.ts'
import { ServiceError } from './daemon/service.ts'
import { ProcessLockBusy } from './platform/lock.ts'
import { StorageFormatError } from './storage-format.ts'
import { readPrivateFile, writePrivateFileAtomic } from './platform/private.ts'
import { defaultDataDirectory } from './platform/layout.ts'

const usage = `Baton 节点

  --version
  login [--coordinator <https://中心>] [--display-name <设备名>]
  login --cancel
  logout
  status
  serve | run
  identity

login 展示验证网址与短验证码，并等待浏览器确认后上线。
Ctrl-C 仅退出终端等待；login --cancel 取消后台登录。
serve/run 常驻运行守护进程；控制命令在需要时自动后台启动。

设备管理：

  install [--data-dir <私有目录>]
  uninstall [--purge] [--data-dir <私有目录>]
  doctor [--data-dir <私有目录>]
  service install|uninstall|status
  env import [--shell] | list | doctor | set|unset|reset <名称> [--scope <范围>]
  files add --id <标识> --path <绝对目录>
  files remove --id <标识>
  files list
  project-exec --enabled=true|false [--shell <程序>]
  login <openai-codex|xai>
  subscriptions

本地 Thread：

  open --cwd <目录> [--thread-id <UUID>] [--agent <cursor|pi|codex|kiro|antigravity|droid>] [--model <模型>] [--runtime-mode <approval-required|auto-accept-edits|auto|full-access>] [--execution-timeout-seconds <秒>]
  message --thread-id <UUID> --text <正文> [--message-id <ID>] [--mode <queue|steer>] [--model <模型>]
  status | stop | resume | reports --thread-id <UUID>
  command --thread-id <UUID> --command-id <UUID>
  withdraw --thread-id <UUID> --message-id <ID>
  ack --thread-id <UUID> --event-id <UUID> --worker-seq <序号>
  probe [--agent <cursor|pi|codex|kiro|antigravity|droid>]

设备与 Thread 命令支持 --data-dir <私有目录>，默认 ~/.baton/data。
订阅凭据目录使用 BATON_PROJECT_RUNTIME_DATA_DIR，默认 ~/.baton/data/credentials。
执行命令支持 --command-id <UUID>；重试时使用同一个 ID。
open 返回持久接收回执，实际结果通过 command 或 reports 查询。`

export async function runBatondCLI(argv: string[] = process.argv.slice(2)): Promise<void> {
  const [action, ...args] = argv
  if (action === 'install') {
    if (!isSea()) throw new Error('只有 SEA 安装包可以运行 install')
    const { values } = parseArgs({
      args,
      options: { 'data-dir': { type: 'string', default: defaultDataDirectory() } },
    })
    const { installBatond } = await import('./daemon/install.ts')
    console.log(JSON.stringify(await installBatond(values['data-dir']!)))
    return
  }
  if (action === 'doctor' || action === 'uninstall') {
    const { values } = parseArgs({
      args,
      options: {
        'data-dir': { type: 'string', default: defaultDataDirectory() },
        ...(action === 'uninstall' ? { purge: { type: 'boolean' as const, default: false } } : {}),
      },
    })
    const { diagnoseInstallation, uninstallBatond } = await import('./daemon/install.ts')
    console.log(
      JSON.stringify(
        action === 'doctor'
          ? await diagnoseInstallation(values['data-dir']!)
          : await uninstallBatond(values['data-dir']!, { purge: values.purge === true }),
      ),
    )
    return
  }
  if (action === 'env') {
    const { runEnvironmentCLI } = await import('./environment-cli.ts')
    await runEnvironmentCLI(args)
    return
  }
  if ((action === 'run' || action === 'serve') && process.env.BATON_ENV_REEXEC !== '1') {
    const index = argv.findIndex((arg) => arg === '--data-dir' || arg.startsWith('--data-dir='))
    const directory =
      index < 0
        ? defaultDataDirectory()
        : argv[index] === '--data-dir'
          ? argv[index + 1]
          : argv[index]!.slice('--data-dir='.length)
    if (directory) {
      const { initializeEnvironment, applyEnvironment } = await import('./environment.ts')
      const config = await initializeEnvironment(directory, process.env)
      if (config.revision) {
        const env = applyEnvironment(config, process.env)
        Object.assign(env, {
          BATON_ENV_REEXEC: '1',
          BATON_ENV_DATA_DIR: directory,
          BATON_ENV_REVISION: config.revision,
        })
        const nextArgs = [...(isSea() ? [] : [...process.execArgv, process.argv[1]!]), ...argv]
        if (process.platform !== 'win32') {
          if (!process.execve) throw new Error('当前 Node 不支持环境启动入口')
          process.execve(process.execPath, [process.execPath, ...nextArgs], env)
        }
        env.BATON_ENV_PARENT_PIPE = '1'
        const child = spawn(process.execPath, nextArgs, {
          env,
          stdio: ['inherit', 'inherit', 'inherit', 'pipe'],
          windowsHide: true,
        })
        const forwardInt = () => (child.stdio[3] as Writable | null)?.end()
        const forwardTerm = forwardInt
        process.on('SIGINT', forwardInt)
        process.on('SIGTERM', forwardTerm)
        try {
          process.exitCode = await new Promise<number>((resolve, reject) => {
            child.once('error', reject)
            child.once('exit', (code, signal) => resolve(code ?? (signal === 'SIGTERM' ? 0 : 1)))
          })
        } finally {
          process.off('SIGINT', forwardInt)
          process.off('SIGTERM', forwardTerm)
        }
        return
      }
    }
  }
  if (
    action === '--version' ||
    action === '--binary-version' ||
    (['agent-host', 'watchdog', 'project-runtime'].includes(action) && args.length === 1 && args[0] === '--version')
  ) {
    console.log(JSON.stringify({ ...releaseMetadata(), sea: isSea(), node: process.version }))
    return
  }
  if (action === 'agent-host' && args.length === 1 && args[0] === '--probe') {
    try {
      const { inspectAgentHostModules } = await import('./cli/agent-host.ts')
      console.log(JSON.stringify(await inspectAgentHostModules()))
    } catch {
      console.error(
        JSON.stringify({
          ok: false,
          code: 'installation_incomplete',
          message: '无法加载 Agent 模块，请检查安装包旁的 node_modules 目录及其平台依赖。',
        }),
      )
      process.exitCode = 1
    }
    return
  }
  if (action === 'run' || action === 'serve' || action === 'identity') {
    const { runDaemonCLI } = await import('./daemon/cli.ts')
    await runDaemonCLI(action, args)
    return
  }
  if (action === 'service') {
    const { positionals, values } = parseArgs({
      args,
      allowPositionals: true,
      options: { 'data-dir': { type: 'string', default: defaultDataDirectory() } },
    })
    const command = positionals[0]
    if (positionals.length !== 1 || (command !== 'install' && command !== 'uninstall' && command !== 'status'))
      throw new Error('用法：service install|uninstall|status [--data-dir <私有目录>]')
    const { manageService } = await import('./daemon/service.ts')
    console.log(JSON.stringify(await manageService(command, values['data-dir']!)))
    return
  }
  if (action === 'files' || action === 'project-exec') {
    const { runDeviceCLI } = await import('./devices/cli.ts')
    await runDeviceCLI(action, args, defaultDataDirectory())
    return
  }
  const loginPositionals =
    action === 'login'
      ? parseArgs({
          args,
          allowPositionals: true,
          options: {
            coordinator: { type: 'string' },
            'display-name': { type: 'string' },
            'data-dir': { type: 'string' },
            cancel: { type: 'boolean' },
          },
        }).positionals
      : []
  if (
    action === 'logout' ||
    (action === 'status' && !args.some((value) => value === '--thread-id' || value.startsWith('--thread-id='))) ||
    (action === 'login' && loginPositionals.length === 0)
  ) {
    const { runControlCLI } = await import('./daemon/control-cli.ts')
    await runControlCLI(action, args)
    return
  }
  if (action === 'login' || action === 'subscriptions') {
    const { positionals } = parseArgs({ args, allowPositionals: true, options: {} })
    if ((action === 'login' && positionals.length !== 1) || (action === 'subscriptions' && positionals.length !== 0))
      throw new Error('用法：login [--coordinator <https://中心>] 或 login <openai-codex|xai> 或 subscriptions')
    const { runProjectCLI } = await import('./project/index.ts')
    await runProjectCLI(action, positionals[0])
    return
  }
  if (action === 'project-runtime') {
    if (!isSea() && !BUNDLED) {
      const { defaultRuntimeCommand } = await import('./project/runner.ts')
      const command = defaultRuntimeCommand()
      const child = spawn(command.file, [...(command.args ?? []), ...args], {
        stdio: 'inherit',
        env: { ...process.env, ...command.env },
        windowsHide: true,
      })
      const interrupt = () => child.kill('SIGINT')
      const terminate = () => child.kill('SIGTERM')
      process.once('SIGINT', interrupt)
      process.once('SIGTERM', terminate)
      try {
        process.exitCode = await new Promise<number>((resolve, reject) => {
          child.once('error', reject)
          child.once('close', (code) => resolve(code ?? 1))
        })
      } finally {
        process.removeListener('SIGINT', interrupt)
        process.removeListener('SIGTERM', terminate)
      }
      return
    }
    const { runProjectRuntimeCLI, reportProjectRuntimeError } =
      await import('../../../runtimes/project-agent/src/command.js')
    await runProjectRuntimeCLI(args).catch(reportProjectRuntimeError)
    return
  }
  if (action === 'watchdog') {
    const { runWatchdogCommand } = await import('./platform/process.ts')
    await runWatchdogCommand()
    return
  }
  if (action === 'agent-host') {
    const controller = new AbortController()
    const stop = () => controller.abort()
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
    try {
      const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: { cwd: { type: 'string' }, state: { type: 'string' } },
      })
      const agentType = positionals[0]
      if (!agentType || !values.cwd || !values.state)
        throw new Error('Agent host needs an Agent type, --cwd and --state')
      const { runAgentHostCommand } = await import('./cli/agent-host.ts')
      const telemetryEnv = { ...process.env }
      for (const name of Object.keys(process.env)) if (name.startsWith('OTEL_')) delete process.env[name]
      await Effect.runPromise(
        Effect.scoped(
          runAgentHostCommand(agentType, { workingDirectory: values.cwd, privateDirectory: values.state }),
        ).pipe(Effect.provide(telemetryLayer('baton-agent-host', telemetryEnv))),
        { signal: controller.signal },
      )
    } catch (error) {
      if (!controller.signal.aborted) throw error
    } finally {
      process.removeListener('SIGINT', stop)
      process.removeListener('SIGTERM', stop)
    }
    return
  }
  await runLocalCLI(argv)
}

export function reportBatondError(error: unknown, action = process.argv[2]): void {
  const incompatible = error instanceof Error && 'code' in error && error.code === 'node_version_incompatible'
  const detail =
    incompatible &&
    'version_incompatibility' in error &&
    Schema.is(NodeVersionIncompatibility)(error.version_incompatibility)
      ? error.version_incompatibility
      : undefined
  const daemonRunning = error instanceof ProcessLockBusy && basename(error.path) === 'daemon.lock'
  const knownCode =
    error instanceof Error && 'code' in error && String(error.code) === 'credential_revoked'
      ? String(error.code)
      : undefined
  const code = incompatible
    ? 'node_version_incompatible'
    : daemonRunning
      ? 'daemon_running'
      : (knownCode ??
        (error instanceof IPCError || error instanceof ServiceError || error instanceof StorageFormatError
          ? error.code
          : 'batond_failed'))
  // SDK 诊断留在隔离宿主内，公开错误不包含原始 SDK 输出。
  console.error(
    JSON.stringify({
      ok: false,
      code,
      ...(detail ? { version_incompatibility: detail } : {}),
      message:
        action === 'agent-host' || action === 'watchdog'
          ? `${action} failed`
          : daemonRunning
            ? '服务或桌面客户端正在运行，请先停止已有 batond 再重试'
            : error instanceof Error
              ? error.message
              : 'Baton 本地命令失败',
    }),
  )
  process.exitCode = code === 'node_version_incompatible' ? 78 : 1
}

export function makeThreadControlHost(dataDirectory: string): Pick<DaemonWorkerHost, 'request'> {
  const client = new ControlClient(dataDirectory)
  return {
    async request(threadId, request, options = {}) {
      const response = await client.request(
        { method: 'thread_request', thread_id: threadId, request },
        { autostart: options.start !== false, timeoutMs: options.timeoutMs ?? 30000 },
      )
      if (!response.ok) throw new IPCError(response.code ?? 'control_failed', response.message ?? '本机请求失败')
      return Schema.decodeUnknownSync(WorkerIPCMessage)(response.result)
    },
  }
}

export async function runLocalCLI(
  args: string[],
  dependencies: {
    host?: Pick<DaemonWorkerHost, 'request'>
    probeAgent?: (agent: 'cursor' | 'pi' | 'codex' | 'kiro' | 'antigravity' | 'droid') => Promise<RuntimeAgent>
  } = {},
): Promise<void> {
  const action = args[0]
  if (!action || action === '--help' || action === 'help') {
    console.log(usage)
    return
  }
  const { values } = parseArgs({
    args: args.slice(1),
    options: {
      'data-dir': { type: 'string', default: defaultDataDirectory() },
      'thread-id': { type: 'string' },
      'command-id': { type: 'string' },
      'message-id': { type: 'string' },
      'event-id': { type: 'string' },
      'worker-seq': { type: 'string' },
      'after-worker-seq': { type: 'string' },
      cwd: { type: 'string' },
      model: { type: 'string' },
      'runtime-mode': { type: 'string' },
      agent: { type: 'string' },
      mode: { type: 'string' },
      'execution-timeout-seconds': { type: 'string' },
      text: { type: 'string' },
    },
  })
  const dataDirectory = values['data-dir']!
  const requireValue = (key: keyof typeof values) => {
    const value = values[key]
    if (!value) throw new Error(`缺少 --${key}`)
    return value
  }
  if (action === 'probe') {
    const { probeAgents } = await import('./agents/probe.ts')
    const agent = Schema.decodeUnknownSync(Schema.Literals(['cursor', 'pi', 'codex', 'kiro', 'antigravity', 'droid']))(
      values.agent ?? 'cursor',
    )
    const [report] = await probeAgents({ dataDirectory, agentTypes: [agent] })
    console.log(JSON.stringify(report, null, 2))
    return
  }
  const timeout =
    values['execution-timeout-seconds'] === undefined
      ? undefined
      : Schema.decodeUnknownSync(ExecutionTimeoutSeconds)(Number(values['execution-timeout-seconds']))
  const mode = Schema.decodeUnknownSync(Schema.Literals(['queue', 'steer']))(values.mode ?? 'queue')
  if (action === 'message' && mode === 'steer' && values.model) throw new Error('插入消息不能更换模型')
  const threadId = values['thread-id'] ?? (action === 'open' ? randomUUID() : requireValue('thread-id'))
  const host = dependencies.host ?? makeThreadControlHost(dataDirectory)
  let request: typeof WorkerRequest.Type
  if (action === 'open') {
    const paths = await initializeWorkerDirectory(dataDirectory, threadId)
    const savedPath = join(paths.threadDirectory, 'local-open.json')
    let saved: typeof WorkerOpen.Type | undefined
    try {
      saved = Schema.decodeUnknownSync(WorkerOpen)(JSON.parse((await readPrivateFile(savedPath)).toString('utf8')))
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
    const agent = Schema.decodeUnknownSync(Schema.Literals(['cursor', 'pi', 'codex', 'kiro', 'antigravity', 'droid']))(
      values.agent ?? saved?.open_config.agent_type ?? 'cursor',
    )
    const capability = await (dependencies.probeAgent
      ? dependencies.probeAgent(agent)
      : import('./agents/probe.ts').then(
          async ({ probeAgents }) => (await probeAgents({ dataDirectory, agentTypes: [agent] }))[0]!,
        ))
    if (capability.status !== 'available' || !capability.capabilities.create)
      throw new Error(capability.reason ?? `${agent} 尚不可用`)
    const runtimeMode = Schema.decodeUnknownSync(RuntimeMode)(
      values['runtime-mode'] ?? saved?.open_config.runtime_mode ?? DEFAULT_RUNTIME_MODE,
    )
    const reportedMode = capability.runtime_modes?.find((entry) => entry.id === runtimeMode)
    if (!reportedMode)
      throw new Error(
        `不支持执行模式 ${runtimeMode}；设备报告：${capability.runtime_modes?.map((entry) => entry.id).join('、') || '无'}`,
      )
    if (!reportedMode.available) throw new Error(reportedMode.reason ?? `执行模式 ${runtimeMode} 不可用`)
    const cwd = values.cwd ? await realpath(values.cwd) : saved?.open_config.working_directory
    if (!cwd) throw new Error('新建 Thread 需要 --cwd')
    if (
      saved &&
      (saved.open_config.working_directory !== cwd ||
        saved.open_config.agent_type !== agent ||
        saved.open_config.runtime_mode !== runtimeMode ||
        (timeout !== undefined && saved.open_config.execution_timeout_seconds !== timeout) ||
        (values.model && saved.open_config.model !== values.model))
    )
      throw new Error('Thread 已有不同的新建配置')
    const storageGeneration = saved?.storage_generation ?? randomUUID()
    const commandId = values['command-id'] ?? saved?.command_id ?? randomUUID()
    const model = values.model ?? saved?.open_config.model ?? capability.default_model
    request = {
      type: 'thread_open',
      ok: false,
      command_id: commandId,
      thread_id: threadId,
      storage_generation: storageGeneration,
      open_config: {
        thread_id: threadId,
        node_id: saved?.open_config.node_id ?? randomUUID(),
        storage_generation: storageGeneration,
        agent_type: agent,
        runtime_mode: runtimeMode,
        working_directory: cwd,
        execution_timeout_seconds: timeout ?? saved?.open_config.execution_timeout_seconds ?? 7200,
        ...(model ? { model } : {}),
        adapter_config: { state_path: join(paths.threadDirectory, 'native.json') },
      },
    }
    await writePrivateFileAtomic(savedPath, JSON.stringify(request))
  } else if (action === 'status') request = { type: 'status', ok: false }
  else if (action === 'reports')
    request = { type: 'thread_pending', ok: false, after_worker_seq: Number(values['after-worker-seq'] ?? 0) }
  else if (action === 'ack')
    request = {
      type: 'thread_ack',
      ok: false,
      event_id: requireValue('event-id'),
      worker_seq: Number(requireValue('worker-seq')),
    }
  else {
    if (!['message', 'stop', 'resume', 'withdraw', 'command'].includes(action)) throw new Error(`未知命令：${action}`)
    const status = await host.request(threadId, { type: 'status', ok: false }, { start: true })
    if (!status.storage_generation) throw new Error('Thread 尚未持久接收新建命令')
    if (action === 'resume') {
      const paths = workerPaths(dataDirectory, threadId)
      const saved = Schema.decodeUnknownSync(WorkerOpen)(
        JSON.parse((await readPrivateFile(join(paths.threadDirectory, 'local-open.json'))).toString('utf8')),
      )
      if (status.runtime_mode !== saved.open_config.runtime_mode) throw new Error('runtime_mode_conflict')
      const agent = saved.open_config.agent_type
      if (
        agent !== 'cursor' &&
        agent !== 'pi' &&
        agent !== 'codex' &&
        agent !== 'kiro' &&
        agent !== 'antigravity' &&
        agent !== 'droid'
      )
        throw new Error('agent_unavailable')
      const capability = await (dependencies.probeAgent
        ? dependencies.probeAgent(agent)
        : import('./agents/probe.ts').then(
            async ({ probeAgents }) => (await probeAgents({ dataDirectory, agentTypes: [agent] }))[0]!,
          ))
      const reportedMode = capability.runtime_modes?.find((entry) => entry.id === saved.open_config.runtime_mode)
      if (capability.status !== 'available' || !capability.capabilities.resume)
        throw new Error(capability.reason ?? 'agent_unavailable')
      if (!reportedMode) throw new Error('runtime_mode_unsupported')
      if (!reportedMode.available) throw new Error(reportedMode.reason ?? 'runtime_mode_unavailable')
    }
    const identity = {
      ok: false,
      thread_id: threadId,
      storage_generation: status.storage_generation,
      command_id: values['command-id'] ?? randomUUID(),
    }
    if (action === 'message')
      request = {
        ...identity,
        type: 'thread_message',
        client_message_id: values['message-id'] ?? randomUUID(),
        payload: requireValue('text'),
        mode,
        ...(values.model ? { model: values.model } : {}),
      }
    else if (action === 'withdraw')
      request = { ...identity, type: 'thread_withdraw', client_message_id: requireValue('message-id') }
    else if (action === 'command')
      request = { ...identity, type: 'thread_command_status', command_id: requireValue('command-id') }
    else request = { ...identity, type: action === 'stop' ? 'thread_stop' : 'thread_resume' }
  }
  const result = await host.request(threadId, request, {
    start: action !== 'status',
    timeoutMs: 1000,
  })
  console.log(
    JSON.stringify(
      {
        ...result,
        thread_id: threadId,
        ...(request.client_message_id ? { client_message_id: request.client_message_id } : {}),
      },
      null,
      2,
    ),
  )
  if (!result.ok) process.exitCode = 1
}
