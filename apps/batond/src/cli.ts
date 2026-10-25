import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { Schema } from 'effect'
import { WorkerOpen, type WorkerRequest } from '@baton/protocol'
import { LocalWorkerHost, initializeWorkerDirectory } from './daemon/host.ts'
import { readPrivateFile, writePrivateFileAtomic } from './platform/private.ts'

const usage = `Baton 节点（TypeScript 开发入口）

  up --coordinator <https://中心> [--workspace <绝对目录>]
  register --coordinator <https://中心> [--enrollment-file <私有文件>]
  run [--relay <wss://中心/v1/node>]

注册凭据来自 BATON_ENROLLMENT_TOKEN 或 --enrollment-file。
up 复用已有身份，首次运行登记主目录；--workspace 可额外登记目录。

设备管理：

  files add --id <标识> --path <绝对目录>
  files remove --id <标识>
  files list
  project-exec --enabled=true|false [--shell <程序>]
  login <openai-codex|xai>
  subscriptions

本地 Thread：

  open --cwd <目录> [--thread-id <UUID>] [--model <模型>]
  message --thread-id <UUID> --text <正文> [--message-id <ID>]
  status | stop | resume | reports --thread-id <UUID>
  command --thread-id <UUID> --command-id <UUID>
  withdraw --thread-id <UUID> --message-id <ID>
  ack --thread-id <UUID> --event-id <UUID> --worker-seq <序号>
  probe

设备与 Thread 命令支持 --data-dir <私有目录>，默认 ~/.baton-ts。
订阅凭据目录使用 BATON_PROJECT_RUNTIME_DATA_DIR，默认 ~/.baton/project-runtime。
执行命令支持 --command-id <UUID>；重试时使用同一个 ID。
open 返回持久接收回执，实际结果通过 command 或 reports 查询。`

export async function runLocalCLI(args: string[]): Promise<void> {
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
    const { probeLocalCursor } = await import('./agents/registry.ts')
    console.log(JSON.stringify(await probeLocalCursor(), null, 2))
    return
  }
  if (action === 'message' && values.model) throw new Error('Cursor 当前在新建 Thread 时选择模型')
  const threadId = values['thread-id'] ?? (action === 'open' ? randomUUID() : requireValue('thread-id'))
  const host = new LocalWorkerHost(dataDirectory)
  let request: typeof WorkerRequest.Type
  if (action === 'open') {
    const { probeLocalCursor } = await import('./agents/registry.ts')
    const capability = await probeLocalCursor()
    if (capability.status !== 'available' || !capability.capabilities.create)
      throw new Error(capability.reason ?? 'Cursor 尚不可用')
    const paths = await initializeWorkerDirectory(dataDirectory, threadId)
    const savedPath = join(paths.threadDirectory, 'local-open.json')
    let saved: typeof WorkerOpen.Type | undefined
    try {
      saved = Schema.decodeUnknownSync(WorkerOpen)(JSON.parse((await readPrivateFile(savedPath)).toString('utf8')))
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
    const cwd = values.cwd ? await realpath(values.cwd) : saved?.open_config.working_directory
    if (!cwd) throw new Error('新建 Thread 需要 --cwd')
    if (
      saved &&
      (saved.open_config.working_directory !== cwd || (values.model && saved.open_config.model !== values.model))
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
        agent_type: 'cursor',
        working_directory: cwd,
        execution_timeout_seconds: 7200,
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
        mode: 'queue',
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
