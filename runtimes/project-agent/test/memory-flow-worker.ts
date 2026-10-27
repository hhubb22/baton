import assert from 'node:assert/strict'
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  type SimpleStreamOptions,
  type TranscriptContext,
} from '@earendil-works/pi-ai'
import { StdioClient } from '../src/stdio.js'
import { checkedRPC, type MemoryContext } from '../src/protocol.js'
import { ProjectRuntime } from '../src/runtime.js'
import { runMemory } from '../src/memory.js'

// 本地整体流程使用实际 Runtime 与 RPC，模型按本次提供的来源返回固定提案。
const command = process.argv[2]
if (command === 'probe') {
  console.log(
    JSON.stringify({
      version: '0.1.0',
      memory_protocol: 1,
      providers: [
        { provider: 'openai-codex', status: 'available', models: [{ id: 'memory-flow', name: 'Local memory flow' }] },
      ],
    }),
  )
} else {
  const client = new StdioClient(process.stdin, process.stdout)
  let now = 0
  let snapshot: MemoryContext | undefined
  const rpc = checkedRPC(async (request) => {
    const response = await client.call(
      request.operation === 'poll_wake' ? { ...request, payload: { wait_ms: 1 } } : request,
    )
    if (request.operation === 'prepare_context' && response.ok) snapshot = response.data as MemoryContext
    if (request.operation === 'poll_wake') now += 180001
    return response
  })
  const models = createModels()
  const faux = fauxProvider({
    provider: 'openai-codex',
    models: [{ id: 'memory-flow', contextWindow: 24000, maxTokens: 2000 }],
  })
  models.setProvider(faux.provider)
  faux.setResponses(
    Array.from({ length: 16 }, () => (context: TranscriptContext, options?: SimpleStreamOptions) => {
      if (command === 'memory') {
        const content = context.messages.at(-1)!.content
        assert.ok(typeof content === 'string')
        const data = JSON.parse(content) as {
          source: { id: string; source_hash: string; offset: number; next_offset: number; text: string }
        }
        return fauxAssistantMessage(
          JSON.stringify({
            changes: data.source.text.includes('请记住')
              ? [
                  {
                    action: 'add',
                    expected_revision: 0,
                    content: { title: '测试入口', content: '测试使用 pnpm test:unit。', kind: 'lesson' },
                    evidence: [
                      {
                        source_id: data.source.id,
                        source_hash: data.source.source_hash,
                        start_byte: data.source.offset,
                        end_byte: data.source.next_offset,
                      },
                    ],
                  },
                ]
              : [],
          }),
        )
      }
      if (options?.toolChoice === 'none')
        return fauxAssistantMessage('summary-old-fact：测试使用 pnpm test:unit；继续处理当前用户目标。')
      const text = JSON.stringify(context.messages)
      if (text.includes('检查停用')) {
        // 摘要不读取记忆，停用条目后保留；读到旧版本的召回结果被替换。
        assert.ok(text.includes('summary-old-fact'))
        const results = context.messages.filter(
          (message) => message.role === 'toolResult' && message.toolName === 'memory_recall',
        )
        assert.ok(results.length > 0)
        assert.ok(results.every((message) => JSON.stringify(message.content).includes('记忆工具结果已退出当前上下文')))
        assert.equal(snapshot?.memory_refs.length, 0)
        return fauxAssistantMessage('停用后已刷新记忆工具结果。')
      }
      if (text.includes('后续召回')) {
        if (!context.messages.some((message) => message.role === 'toolResult' && message.toolName === 'memory_recall'))
          return fauxAssistantMessage(fauxToolCall('memory_recall', { query: '测试入口' }, { id: 'flow-recall' }))
        assert.ok(snapshot?.memory_refs.length)
        assert.ok(text.includes('pnpm test:unit'))
        return fauxAssistantMessage('后续前台已召回测试入口。')
      }
      return fauxAssistantMessage('已记录。' + 'original conversation '.repeat(2800))
    }),
  )
  try {
    if (command === 'memory') await runMemory(rpc, 2000, undefined, models)
    else if (command === 'run')
      await new ProjectRuntime(
        rpc,
        models,
        {
          now: () => now,
          sleep: async (ms) => {
            now += ms
          },
        },
        { requestRatio: 0.55 },
        { maxOutputTokens: 2000 },
      ).start()
    else throw new Error(`unknown command: ${command}`)
  } finally {
    process.stdin.destroy()
  }
}
