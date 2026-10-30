import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { TranscriptContext } from '@earendil-works/pi-ai'
import { StdioClient } from '../src/stdio.js'
import { checkedRPC } from '../src/protocol.js'
import { memoryFixture } from './memory-fixture.js'

// 本地集成夹具：认证、模型和时间均为替身；Runtime 与工具 RPC 使用实际实现。
const directory = process.env.T3_FIXTURE_RUNTIME_DIRECTORY!
const marker = join(directory, 'local-subscription')
const [command, provider] = process.argv.slice(2)
if (command === 'probe') {
  let available = false
  try {
    available = (await readFile(marker, 'utf8')) === 'local-login-complete'
  } catch {
    /* 尚未完成本地登录。 */
  }
  console.log(
    JSON.stringify({
      version: '0.1.0',
      providers: [
        {
          provider: 'openai-codex',
          status: available ? 'available' : 'login_required',
          models: [{ id: 't3-faux', name: 'Local faux model' }],
        },
      ],
    }),
  )
} else if (command === 'login-device') {
  if (provider !== 'openai-codex') throw new Error('unsupported_local_provider')
  console.log(
    JSON.stringify({
      type: 'device_code',
      provider,
      verification_uri: 'https://login.invalid/local-device',
      user_code: 'T3-LOCAL-CODE',
      expires_in_seconds: 600,
    }),
  )
  process.stdin.resume()
  await delay(100)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await writeFile(marker, 'local-login-complete', { mode: 0o600 })
  process.stdin.destroy()
} else if (command === 'run') {
  // probe 和设备登录有独立的短时限，模型与 Runtime 仅在运行任务时加载。
  const [{ createModels, fauxProvider, fauxAssistantMessage, fauxToolCall }, { ProjectRuntime }] = await Promise.all([
    import('@earendil-works/pi-ai'),
    import('../src/runtime.js'),
  ])
  await appendFile(
    join(directory, 'runtime-starts.jsonl'),
    JSON.stringify({ pid: process.pid, run_id: process.env.BATON_PROJECT_RUN_ID }) + '\n',
    { mode: 0o600 },
  )
  const client = new StdioClient(process.stdin, process.stdout)
  let offset = 0,
    observedAllInputs = false
  const memory = memoryFixture()
  const rpc = checkedRPC(async (request) => {
    if (
      request.operation === 'poll_wake' &&
      !(request.payload as { execution_id?: string } | undefined)?.execution_id
    ) {
      const result = await client.call({ ...request, payload: { wait_ms: 50 } })
      if (observedAllInputs) offset += 180000
      return result
    }
    const result = await client.call(request)
    memory.observe(request, result)
    return result
  })
  const models = createModels()
  const faux = fauxProvider({
    provider: 'openai-codex',
    models: [{ id: 't3-faux', contextWindow: 1000000, maxTokens: 32000 }],
  })
  models.setProvider(faux.provider)
  const respond = (context: TranscriptContext) => {
    const text = JSON.stringify(context.messages)
    if (!memory.evidence)
      return fauxAssistantMessage(fauxToolCall('memory.read', memory.input!, { id: 't3-memory-source' }))
    if (!text.includes('t3-memory-write'))
      return fauxAssistantMessage(
        fauxToolCall(
          'memory.remember',
          { title: 'T3 运行记录', content: '通过真实 Runtime 保存的项目记忆', evidence: memory.evidence },
          { id: 't3-memory-write' },
        ),
      )
    if (!text.includes('t3-thread-create'))
      return fauxAssistantMessage(
        [
          fauxToolCall(
            'threads.create',
            {
              node_id: process.env.T3_FIXTURE_NODE_ID!,
              agent_type: 'cursor',
              model: 'default',
              working_directory: process.env.T3_FIXTURE_WORKSPACE!,
              message: 't3 replay task `artifact.log`',
            },
            { id: 't3-thread-create' },
          ),
          fauxToolCall(
            'nodes.exec',
            {
              node_id: process.env.T3_FIXTURE_NODE_ID!,
              working_directory: process.env.T3_FIXTURE_WORKSPACE!,
              command: process.env.T3_FIXTURE_SHELL_COMMAND!,
              wait_seconds: 30,
              timeout_seconds: 60,
            },
            { id: 't3-node-exec' },
          ),
        ],
        { timestamp: 1 },
      )
    const seen = ['thread_reply', 'turn_ended', 'memory_updated'].filter((type) => text.includes(type))
    observedAllInputs = ['thread_reply', 'turn_ended', 'memory_updated'].every((type) => seen.includes(type))
    return fauxAssistantMessage(
      `T3 收到输入：${seen.join('、')}。${text.includes('reply:t3 replay task') ? '已读取 Cursor 回复。' : ''}${text.includes('由用户补充的验证说明') ? '已读取用户回答。' : ''}`,
      { timestamp: 2 + context.messages.length },
    )
  }
  faux.setResponses(Array.from({ length: 32 }, () => respond))
  try {
    await new ProjectRuntime(rpc, models, {
      now: () => performance.now() + offset,
      sleep: async (ms) => {
        await delay(Math.min(ms, 20))
        offset += ms
      },
    }).start()
  } finally {
    process.stdin.destroy()
  }
} else throw new Error('usage: t3-worker probe|login-device <provider>|run')
