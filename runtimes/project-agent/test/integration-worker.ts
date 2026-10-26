import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai'
import { StdioClient } from '../src/stdio.js'
import { checkedRPC } from '../src/protocol.js'
import { ProjectRuntime } from '../src/runtime.js'

const client = new StdioClient(process.stdin, process.stdout)
let now = 0
const rpc = checkedRPC(async (request) => {
  if (request.operation === 'poll_wake') {
    now += (request.payload as { wait_ms: number }).wait_ms
    return { type: 'project_runtime.result', ok: true, data: { wake: false } }
  }
  return client.call(request)
})
const models = createModels()
const faux = fauxProvider({
  provider: 'openai-codex',
  models: [{ id: 'fake-model', contextWindow: 80000, maxTokens: 32000 }],
})
models.setProvider(faux.provider)
faux.setResponses([
  fauxAssistantMessage(
    fauxToolCall(
      'memory.remember',
      {
        title: '运行记录',
        content: '真实 Node Runtime 经 batond 和 Gateway 提交' + 'x'.repeat(50000),
        evidence: [
          { source_id: '00000000-0000-4000-8000-000000000001', source_hash: 'fixture', start_byte: 0, end_byte: 1 },
        ],
      },
      { id: 'memory-1' },
    ),
    { timestamp: 1 },
  ),
  fauxAssistantMessage('已保存记忆。' + 'y'.repeat(120000), { timestamp: 2 }),
  fauxAssistantMessage('用户要求处理消息。已保存名为运行记录的记忆，下一步等待用户指令。', { timestamp: 3 }),
])
try {
  await new ProjectRuntime(rpc, models, {
    now: () => now,
    sleep: async (ms) => {
      now += ms
    },
  }).start()
} finally {
  process.stdin.destroy()
}
