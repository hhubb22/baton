import { BUNDLED, releaseMetadata, NodeVersionIncompatibility } from '@baton/protocol/release'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import type { Writable } from 'node:stream'
import { realpath, lstat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative } from 'node:path'
import { parseArgs } from 'node:util'
import { isSea } from 'node:sea'
import { Effect, Schema } from 'effect'
import { telemetryLayer } from '@baton/telemetry'
import {
  DEFAULT_RUNTIME_MODE,
  RuntimeMode,
  ExecutionTimeoutSeconds,
  WorkerOpen,
  type RuntimeAgent,
  type WorkerRequest,
} from '@baton/protocol'
import { LocalWorkerHost, initializeWorkerDirectory } from './daemon/host.ts'
import { workerPaths } from './daemon/paths.ts'
import { IPCError } from './daemon/ipc.ts'
import { desktopDirectory, DesktopDirectoryError } from './daemon/desktop-directory.ts'
import { ServiceError } from './daemon/service.ts'
import { ProcessLockBusy } from './platform/lock.ts'
import { StorageFormatError } from './storage-format.ts'
import { readUpgradeState, upgradeOffline } from './daemon/upgrade.ts'
import { readPrivateFile, writePrivateFileAtomic } from './platform/private.ts'

const usage = `Baton 节点

  --version
  up [--coordinator <https://中心>] [--workspace <绝对目录>]
  register [--coordinator <https://中心>] [--enrollment-file <私有文件>]
  identity
  desktop-directory --thread-id <UUID> --data-dir <已有数据目录>
  reauth [--enrollment-file <私有文件>] [--ca-file <CA证书>]
  run [--relay <wss://中心/v1/node>]

注册与重新认证凭据来自 BATON_ENROLLMENT_TOKEN 或 --enrollment-file。
reauth 使用已有身份和保存的中心地址；中断后再次运行沿用原操作，成功后用 up/run 连接。
up 复用已有身份，首次运行登记主目录；--workspace 可额外登记目录。
首次注册可使用 SEA 安装目录中的 deployment.json；显式 --coordinator / --ca-file 优先。
注册与重新认证成功后保存 CA，后续连接默认使用保存的 CA。identity 仅输出注册状态与公开身份。
up/run 支持 --control-timeout-seconds <秒>，认证与同步各默认等待 370 秒，范围 1～3600。

设备管理：

  service install|uninstall|status
  env import [--shell] | list | doctor | set|unset|reset <名称> [--scope <范围>]
  update
  update status | cancel
  update policy [manual|idle]
  files add --id <标识> --path <绝对目录>
  files remove --id <标识>
  files list
  project-exec --enabled=true|false [--shell <程序>]
  login <openai-codex|xai>
  subscriptions

本地 Thread：

  open --cwd <目录> [--thread-id <UUID>] [--agent <cursor|pi|codex|kiro|antigravity>] [--model <模型>] [--runtime-mode <approval-required|auto-accept-edits|auto|full-access>] [--execution-timeout-seconds <秒>]
  message --thread-id <UUID> --text <正文> [--message-id <ID>] [--mode <queue|steer>] [--model <模型>]
  status | stop | resume | reports --thread-id <UUID>
  command --thread-id <UUID> --command-id <UUID>
  withdraw --thread-id <UUID> --message-id <ID>
  ack --thread-id <UUID> --event-id <UUID> --worker-seq <序号>
  probe [--agent <cursor|pi|codex|kiro|antigravity>]

设备与 Thread 命令支持 --data-dir <私有目录>，默认 ~/.baton-ts。
订阅凭据目录使用 BATON_PROJECT_RUNTIME_DATA_DIR，默认 ~/.baton/project-runtime。
执行命令支持 --command-id <UUID>；重试时使用同一个 ID。
open 返回持久接收回执，实际结果通过 command 或 reports 查询。`

export async function runBatondCLI(argv: string[] = process.argv.slice(2)): Promise<void> {
  const [action, ...args] = argv
  if (
    isSea() &&
    action &&
    ![
      'dispatch',
      'versioned-dispatch',
      'update-worker',
      'update-recover',
      'update-preflight',
      '--binary-version',
      'worker',
      'execution-worker',
      'agent-host',
      'watchdog',
      'project-runtime',
    ].includes(action) &&
    !(action === 'update' && args[0] === 'bootstrap')
  ) {
    const index = argv.findIndex((arg) => arg === '--data-dir' || arg.startsWith('--data-dir='))
    const directory =
      index < 0
        ? join(homedir(), '.baton-ts')
        : argv[index] === '--data-dir'
          ? argv[index + 1]
          : argv[index]!.slice('--data-dir='.length)
    if (directory) {
      const { installationPaths, dispatchInstallation } = await import('./daemon/update-install.ts')
      const paths = installationPaths(directory)
      const exists = await lstat(paths.launcherCurrent).then(
        () => true,
        (error: unknown) => {
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
          throw error
        },
      )
      if (exists) {
        const versions = await realpath(paths.versions)
        const executable = await realpath(process.execPath)
        const within = relative(versions, executable)
        if (
          within === '..' ||
          within.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
          within === '' ||
          isAbsolute(within)
        ) {
          process.exitCode = await dispatchInstallation(directory, argv)
          return
        }
      }
    }
  }
  if (action === 'env') {
    const { runEnvironmentCLI } = await import('./environment-cli.ts')
    await runEnvironmentCLI(args)
    return
  }
  if ((action === 'run' || action === 'up') && process.env.BATON_ENV_REEXEC !== '1') {
    const index = argv.findIndex((arg) => arg === '--data-dir' || arg.startsWith('--data-dir='))
    const directory =
      index < 0
        ? join(homedir(), '.baton-ts')
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
    (['worker', 'execution-worker', 'agent-host', 'watchdog', 'project-runtime'].includes(action) &&
      args.length === 1 &&
      args[0] === '--version')
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
  if (action === 'desktop-directory') {
    console.log(JSON.stringify(await desktopDirectory(args)))
    return
  }
  if (action === 'up' || action === 'register' || action === 'reauth' || action === 'run' || action === 'identity') {
    const { runDaemonCLI } = await import('./daemon/cli.ts')
    await runDaemonCLI(action, args)
    return
  }
  if (action === 'service') {
    const { positionals, values } = parseArgs({
      args,
      allowPositionals: true,
      options: { 'data-dir': { type: 'string', default: join(homedir(), '.baton-ts') } },
    })
    const command = positionals[0]
    if (positionals.length !== 1 || (command !== 'install' && command !== 'uninstall' && command !== 'status'))
      throw new Error('用法：service install|uninstall|status [--data-dir <私有目录>]')
    const { manageService } = await import('./daemon/service.ts')
    console.log(JSON.stringify(await manageService(command, values['data-dir']!)))
    return
  }
  if (action === 'dispatch' || action === 'versioned-dispatch') {
    const separator = args.indexOf('--')
    if (separator < 0 || separator === args.length - 1) throw new Error('dispatch requires a command after --')
    const { values } = parseArgs({ args: args.slice(0, separator), options: { 'data-dir': { type: 'string' } } })
    if (!values['data-dir']) throw new Error('dispatch requires --data-dir')
    const { dispatchInstallation, launchInstallation } = await import('./daemon/update-install.ts')
    process.exitCode = await (action === 'dispatch' ? dispatchInstallation : launchInstallation)(
      values['data-dir'],
      args.slice(separator + 1),
    )
    return
  }
  if (action === 'update' && args[0] === 'bootstrap') {
    const { values } = parseArgs({
      args: args.slice(1),
      options: { 'data-dir': { type: 'string', default: join(homedir(), '.baton-ts') } },
    })
    const { bootstrapInstallation } = await import('./daemon/update-install.ts')
    console.log(JSON.stringify(await bootstrapInstallation(values['data-dir']!)))
    return
  }
  if (action === 'update' && args[0] === 'status') {
    const { values } = parseArgs({
      args: args.slice(1),
      options: { 'data-dir': { type: 'string', default: join(homedir(), '.baton-ts') } },
    })
    const { readUpdateState } = await import('./daemon/update-state.ts')
    console.log(JSON.stringify({ state: (await readUpdateState(values['data-dir']!)) ?? null }))
    return
  }
  if (action === 'update' && args[0] === 'manifest') {
    const { values } = parseArgs({
      args: args.slice(1),
      options: { 'data-dir': { type: 'string', default: join(homedir(), '.baton-ts') } },
    })
    const { fetchUpdateManifest } = await import('./daemon/update-network.ts')
    console.log(JSON.stringify({ manifest: await fetchUpdateManifest(values['data-dir']!) }))
    return
  }
  if (action === 'update' && args[0] === 'desktop-feed') {
    const { values } = parseArgs({
      args: args.slice(1),
      options: {
        'data-dir': { type: 'string', default: join(homedir(), '.baton-ts') },
        'operation-id': { type: 'string' },
        attempt: { type: 'string' },
      },
    })
    if (!values['operation-id'] || !values.attempt || !/^[1-9]\d*$/.test(values.attempt))
      throw new Error('update desktop-feed requires --operation-id and --attempt')
    const { downloadDesktopFeed } = await import('./daemon/update-network.ts')
    console.log(
      JSON.stringify(await downloadDesktopFeed(values['data-dir']!, values['operation-id'], Number(values.attempt))),
    )
    return
  }
  if (action === 'update' && args[0] === 'policy') {
    const { values, positionals } = parseArgs({
      args: args.slice(1),
      allowPositionals: true,
      options: { 'data-dir': { type: 'string', default: join(homedir(), '.baton-ts') } },
    })
    if (positionals.length > 1 || (positionals[0] !== undefined && !['manual', 'idle'].includes(positionals[0])))
      throw new Error('update policy [manual|idle]')
    const { readUpdatePolicy, saveUpdatePolicy } = await import('./daemon/update-background.ts')
    const policy = positionals[0]
      ? await saveUpdatePolicy(values['data-dir']!, positionals[0] as 'manual' | 'idle')
      : await readUpdatePolicy(values['data-dir']!)
    console.log(JSON.stringify({ policy }))
    return
  }
  if (action === 'update' && args[0] === 'startup-failed') {
    const { values } = parseArgs({
      args: args.slice(1),
      options: {
        'data-dir': { type: 'string', default: join(homedir(), '.baton-ts') },
        'operation-id': { type: 'string' },
        attempt: { type: 'string' },
      },
    })
    if (!values['operation-id'] || !values.attempt || !/^[1-9]\d*$/.test(values.attempt))
      throw new Error('update startup-failed requires --operation-id and --attempt')
    const { reportLocalStartupFailure } = await import('./daemon/update-orchestrator.ts')
    console.log(
      JSON.stringify(
        await reportLocalStartupFailure(values['data-dir']!, values['operation-id'], Number(values.attempt)),
      ),
    )
    return
  }
  if (action === 'update') {
    const subcommand = args[0] === 'cancel' || args[0] === 'start' ? args[0] : 'start'
    const { values } = parseArgs({
      args: subcommand === args[0] ? args.slice(1) : args,
      options: { 'data-dir': { type: 'string', default: join(homedir(), '.baton-ts') } },
    })
    const update = await import('./daemon/update-orchestrator.ts')
    console.log(
      JSON.stringify(
        await (subcommand === 'cancel'
          ? update.cancelUpdate(values['data-dir']!)
          : update.beginLocalUpdate(values['data-dir']!)),
      ),
    )
    return
  }
  if (action === 'update-worker') {
    const { values } = parseArgs({ args, options: { 'data-dir': { type: 'string' } } })
    if (!values['data-dir']) throw new Error('update-worker requires --data-dir')
    const { runUpdateWorker } = await import('./daemon/update-orchestrator.ts')
    await runUpdateWorker(values['data-dir'])
    return
  }
  if (action === 'update-preflight') {
    const { values } = parseArgs({ args, options: { 'data-dir': { type: 'string' } } })
    if (!values['data-dir']) throw new Error('update-preflight requires --data-dir')
    const { localUpgradePreflight } = await import('./daemon/upgrade-check.ts')
    console.log(JSON.stringify(await localUpgradePreflight(values['data-dir'])))
    return
  }
  if (action === 'update-recover') {
    const { values } = parseArgs({ args, options: { 'data-dir': { type: 'string' } } })
    if (!values['data-dir']) throw new Error('update-recover requires --data-dir')
    const { recoverUpdateRollback } = await import('./daemon/update-orchestrator.ts')
    await recoverUpdateRollback(values['data-dir'])
    return
  }
  if (action === 'files' || action === 'project-exec') {
    const { runDeviceCLI } = await import('./devices/cli.ts')
    await runDeviceCLI(action, args, join(homedir(), '.baton-ts'))
    return
  }
  if (action === 'login' || action === 'subscriptions') {
    const { positionals } = parseArgs({ args, allowPositionals: true, options: {} })
    if ((action === 'login' && positionals.length !== 1) || (action === 'subscriptions' && positionals.length !== 0))
      throw new Error('用法：login <openai-codex|xai> 或 subscriptions')
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
  if (action === 'worker' || action === 'agent-host' || action === 'execution-worker') {
    const controller = new AbortController()
    const stop = () => controller.abort()
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
    try {
      if (action === 'execution-worker') {
        const { values } = parseArgs({
          args,
          options: { 'data-dir': { type: 'string' }, 'execution-id': { type: 'string' } },
        })
        if (!values['data-dir'] || !values['execution-id'])
          throw new Error('Execution Worker needs --data-dir and --execution-id')
        const { runExecutionWorker } = await import('./execution/runner.ts')
        await Effect.runPromise(Effect.scoped(runExecutionWorker(values['data-dir'], values['execution-id'])), {
          signal: controller.signal,
        })
      } else if (action === 'worker') {
        const { values } = parseArgs({
          args,
          options: { 'data-dir': { type: 'string' }, 'thread-id': { type: 'string' } },
        })
        if (!values['data-dir'] || !values['thread-id']) throw new Error('Worker needs --data-dir and --thread-id')
        const { runWorker } = await import('./daemon/worker-runner.ts')
        await Effect.runPromise(
          Effect.scoped(runWorker({ dataDirectory: values['data-dir'], threadId: values['thread-id'] })).pipe(
            Effect.provide(telemetryLayer('baton-worker')),
          ),
          { signal: controller.signal },
        )
      } else {
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
      }
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
    error instanceof Error && 'code' in error && ['needs_reauth', 'deployment_invalid'].includes(String(error.code))
      ? String(error.code)
      : undefined
  const code = incompatible
    ? 'node_version_incompatible'
    : daemonRunning
      ? 'daemon_running'
      : (knownCode ??
        (error instanceof IPCError ||
        error instanceof ServiceError ||
        error instanceof StorageFormatError ||
        error instanceof DesktopDirectoryError
          ? error.code
          : 'batond_failed'))
  // SDK 诊断留在隔离宿主内，公开错误不包含原始 SDK 输出。
  console.error(
    JSON.stringify({
      ok: false,
      code,
      ...(detail ? { version_incompatibility: detail } : {}),
      message:
        action === 'worker' || action === 'agent-host' || action === 'watchdog'
          ? `${action} failed`
          : action === 'desktop-directory' && !(error instanceof DesktopDirectoryError)
            ? '无法查询 Thread 工作目录'
            : daemonRunning
              ? '服务或桌面客户端正在运行，请先停止已有 batond 再重试'
              : error instanceof Error
                ? error.message
                : 'Baton 本地命令失败',
    }),
  )
  process.exitCode = ['needs_reauth', 'node_version_incompatible'].includes(code) ? 78 : 1
}

export async function runLocalCLI(
  args: string[],
  dependencies: {
    host?: Pick<LocalWorkerHost, 'request'>
    probeAgent?: (agent: 'cursor' | 'pi' | 'codex' | 'kiro' | 'antigravity') => Promise<RuntimeAgent>
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
      'data-dir': { type: 'string', default: join(homedir(), '.baton-ts') },
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
  if (
    ['open', 'message', 'resume', 'stop', 'withdraw', 'ack', 'probe'].includes(action) &&
    upgradeOffline(await readUpgradeState(dataDirectory))
  )
    throw new IPCError('node_upgrading', '设备已准备升级，请稍后重试原命令')
  const requireValue = (key: keyof typeof values) => {
    const value = values[key]
    if (!value) throw new Error(`缺少 --${key}`)
    return value
  }
  if (action === 'probe') {
    const { probeAgents } = await import('./agents/probe.ts')
    const agent = Schema.decodeUnknownSync(Schema.Literals(['cursor', 'pi', 'codex', 'kiro', 'antigravity']))(values.agent ?? 'cursor')
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
  const host = dependencies.host ?? new LocalWorkerHost(dataDirectory)
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
    const agent = Schema.decodeUnknownSync(Schema.Literals(['cursor', 'pi', 'codex', 'kiro', 'antigravity']))(
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
      if (agent !== 'cursor' && agent !== 'pi' && agent !== 'codex' && agent !== 'kiro' && agent !== 'antigravity')
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
