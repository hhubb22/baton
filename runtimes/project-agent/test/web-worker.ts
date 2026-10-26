// Web E2E 使用真实 Runtime，模型替身的故障和流速由测试控制。
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai'
import { existsSync } from 'node:fs'
import { StdioClient } from '../src/stdio.js'
import { checkedRPC } from '../src/protocol.js'
import { ProjectRuntime } from '../src/runtime.js'
import { memoryFixture } from './memory-fixture.js'

const client = new StdioClient(process.stdin, process.stdout)
const models = createModels()
const faux = fauxProvider({
  provider: 'openai-codex',
  models: [{ id: 'fake-model' }],
  tokensPerSecond: 8,
  tokenSize: { min: 8, max: 8 },
})
models.setProvider(faux.provider)
const response = () => {
  if (!existsSync(process.env.BATON_TEST_WEB_RECOVER!))
    return fauxAssistantMessage('', { stopReason: 'error', errorMessage: '测试模型故障' })
  // 工具结果已保存后恢复时直接回复，避免重复新建 Thread。
  return fauxAssistantMessage('已读取项目记录，继续处理工作。'.repeat(12))
}
const memory = memoryFixture()
const respond = (context: any) =>
  !memory.evidence && existsSync(process.env.BATON_TEST_WEB_RECOVER!)
    ? fauxAssistantMessage(fauxToolCall('memory.read', memory.input!, { id: 'web-memory-source' }))
    : context.messages.some(
          (m: any) =>
            m.role === 'assistant' &&
            Array.isArray(m.content) &&
            m.content.some((b: any) => b.type === 'toolCall' && b.id !== 'web-memory-source'),
        )
      ? response()
      : !existsSync(process.env.BATON_TEST_WEB_RECOVER!)
        ? response()
        : fauxAssistantMessage([
            fauxToolCall(
              'threads.create',
              {
                node_id: process.env.BATON_TEST_WEB_TARGET!,
                agent_type: 'pi',
                working_directory: process.env.BATON_TEST_WEB_WORKSPACE!,
                message: 'Project Agent 的验证工作：检查输出与证据',
              },
              { id: 'web-create' },
            ),
            fauxToolCall(
              'memory.remember',
              { title: '设备约定', content: '保留跨设备工作记录', evidence: memory.evidence! },
              { id: 'web-memory' },
            ),
          ])
faux.setResponses(Array.from({ length: 9 }, () => respond))
try {
  await new ProjectRuntime(
    checkedRPC(async (request) => {
      const result = await client.call(request)
      memory.observe(request, result)
      return result
    }),
    models,
    {
      now: () => performance.now(),
      sleep: async () => {},
    },
  ).start()
} finally {
  process.stdin.destroy()
}
