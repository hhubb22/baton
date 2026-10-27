import { BUNDLED, releaseMetadata } from '@baton/protocol/release'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { isSea } from 'node:sea'
import { Effect, Schema } from 'effect'
import { telemetryLayer } from '@baton/telemetry'
import { ExecutionTimeoutSeconds, WorkerOpen, type RuntimeAgent, type WorkerRequest } from '@baton/protocol'
import { LocalWorkerHost, initializeWorkerDirectory } from './daemon/host.ts'
import { IPCError } from './daemon/ipc.ts'
import { readUpgradeState } from './daemon/upgrade.ts'
import { readPrivateFile, writePrivateFileAtomic } from './platform/private.ts'

const usage = `Baton 节点

  --version
  up --coordinator <https://中心> [--workspace <绝对目录>]
  register --coordinator <https://中心> [--enrollment-file <私有文件>]
  reauth [--enrollment-file <私有文件>] [--ca-file <CA证书>]
  run [--relay <wss://中心/v1/node>]

注册与重新认证凭据来自 BATON_ENROLLMENT_TOKEN 或 --enrollment-file。
reauth 使用已有身份和保存的中心地址；中断后再次运行沿用原操作，成功后用 up/run 连接。
up 复用已有身份，首次运行登记主目录；--workspace 可额外登记目录。
up/run 支持 --control-timeout-seconds <秒>，认证与同步各默认等待 370 秒，范围 1～3600。

设备管理：

  upgrade prepare --package <目录>
  upgrade status
  upgrade cancel
  files add --id <标识> --path <绝对目录>
  files remove --id <标识>
  files list
  project-exec --enabled=true|false [--shell <程序>]
  login <openai-codex|xai>
  subscriptions

本地 Thread：

  open --cwd <目录> [--thread-id <UUID>] [--agent <cursor|pi|codex|kiro>] [--model <模型>] [--execution-timeout-seconds <秒>]
  message --thread-id <UUID> --text <正文> [--message-id <ID>] [--mode <queue|steer>] [--model <模型>]
  status | stop | resume | reports --thread-id <UUID>
  command --thread-id <UUID> --command-id <UUID>
  withdraw --thread-id <UUID> --message-id <ID>
  ack --thread-id <UUID> --event-id <UUID> --worker-seq <序号>
  probe

设备与 Thread 命令支持 --data-dir <私有目录>，默认 ~/.baton-ts。
订阅凭据目录使用 BATON_PROJECT_RUNTIME_DATA_DIR，默认 ~/.baton/project-runtime。
执行命令支持 --command-id <UUID>；重试时使用同一个 ID。
open 返回持久接收回执，实际结果通过 command 或 reports 查询。`

export async function runBatondCLI(argv: string[] = process.argv.slice(2)): Promise<void> {
  const [action, ...args] = argv
  if (
    action === '--version' ||
    (['worker', 'agent-host', 'watchdog', 'project-runtime'].includes(action) &&
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
  if (action === 'up' || action === 'register' || action === 'reauth' || action === 'run') {
    const { runDaemonCLI } = await import('./daemon/cli.ts')
    await runDaemonCLI(action, args)
    return
  }
  if (action === 'upgrade') {
    const { positionals, values } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        'data-dir': { type: 'string', default: join(homedir(), '.baton-ts') },
        package: { type: 'string' },
      },
    })
    const command = positionals[0]
    if (
      positionals.length !== 1 ||
      !['prepare', 'status', 'cancel'].includes(command ?? '') ||
      (command === 'prepare' ? !values.package : values.package !== undefined)
    )
      throw new Error('用法：upgrade prepare --package <目录> | status | cancel')
    const { requestUpgrade } = await import('./daemon/upgrade.ts')
    console.log(
      JSON.stringify(
        await requestUpgrade(
          values['data-dir']!,
          command === 'prepare' ? 'upgrade_prepare' : command === 'cancel' ? 'upgrade_cancel' : 'upgrade_status',
          values.package ? resolve(values.package) : undefined,
        ),
      ),
    )
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
  if (action === 'worker' || action === 'agent-host') {
    const controller = new AbortController()
    const stop = () => controller.abort()
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
    try {
      if (action === 'worker') {
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
        await Effect.runPromise(
          Effect.scoped(
            runAgentHostCommand(agentType, { workingDirectory: values.cwd, privateDirectory: values.state }),
          ),
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
  // SDK diagnostics remain in the isolated host; public errors contain no raw SDK output.
  console.error(
    JSON.stringify({
      ok: false,
      code: error instanceof IPCError ? error.code : 'batond_failed',
      message:
        action === 'worker' || action === 'agent-host' || action === 'watchdog'
          ? `${action} failed`
          : error instanceof Error
            ? error.message
            : 'Baton 本地命令失败',
    }),
  )
  process.exitCode = 1
}

export async function runLocalCLI(
  args: string[],
  dependencies: {
    host?: Pick<LocalWorkerHost, 'request'>
    probeAgent?: (agent: 'cursor' | 'pi' | 'codex' | 'kiro') => Promise<RuntimeAgent>
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
      agent: { type: 'string' },
      mode: { type: 'string' },
      'execution-timeout-seconds': { type: 'string' },
      text: { type: 'string' },
    },
  })
  const dataDirectory = values['data-dir']!
  if (
    ['open', 'message', 'resume', 'stop', 'withdraw', 'ack', 'probe'].includes(action) &&
    (await readUpgradeState(dataDirectory))?.phase === 'ready'
  )
    throw new IPCError('node_upgrading', '设备已准备升级，请稍后重试原命令')
  const requireValue = (key: keyof typeof values) => {
    const value = values[key]
    if (!value) throw new Error(`缺少 --${key}`)
    return value
  }
  if (action === 'probe') {
    const { probeAgents } = await import('./agents/probe.ts')
    const [cursor] = await probeAgents({ dataDirectory, agentTypes: ['cursor'] })
    console.log(JSON.stringify(cursor, null, 2))
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
    const agent = Schema.decodeUnknownSync(Schema.Literals(['cursor', 'pi', 'codex', 'kiro']))(
      values.agent ?? saved?.open_config.agent_type ?? 'cursor',
    )
    const capability = await (dependencies.probeAgent
      ? dependencies.probeAgent(agent)
      : import('./agents/probe.ts').then(
          async ({ probeAgents }) => (await probeAgents({ dataDirectory, agentTypes: [agent] }))[0]!,
        ))
    if (capability.status !== 'available' || !capability.capabilities.create)
      throw new Error(capability.reason ?? `${agent} 尚不可用`)
    const cwd = values.cwd ? await realpath(values.cwd) : saved?.open_config.working_directory
    if (!cwd) throw new Error('新建 Thread 需要 --cwd')
    if (
      saved &&
      (saved.open_config.working_directory !== cwd ||
        saved.open_config.agent_type !== agent ||
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
