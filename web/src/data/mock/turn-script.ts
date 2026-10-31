import type { TraceStep } from '../types'

// 模拟一轮 Agent 运行：工具步骤按顺序进行，随后流式输出回复。步骤内容仿照真实 provider 上报的结构。
type ScriptStep = Pick<TraceStep, 'type' | 'title'> & {
  // 运行中已经上报的字段。
  input?: Record<string, unknown>
  // 步骤结束时补上的字段。
  result: Record<string, unknown>
  failed?: boolean
}

const gatewayPatch = `diff --git a/apps/server/src/gateway.ts b/apps/server/src/gateway.ts
--- a/apps/server/src/gateway.ts
+++ b/apps/server/src/gateway.ts
@@ -38,7 +38,9 @@ export function resumeSession(session: Session, socket: Socket) {
   const previous = session.socket
-  session.socket = socket
-  previous?.close()
+  if (previous && previous !== socket) {
+    previous.removeAllListeners('close')
+    previous.close()
+  }
+  session.socket = socket
   session.flushPending()
 }
`

const testPatch = `diff --git a/apps/server/src/gateway.test.ts b/apps/server/src/gateway.test.ts
--- a/apps/server/src/gateway.test.ts
+++ b/apps/server/src/gateway.test.ts
@@ -41,3 +41,8 @@ describe('gateway', () => {
+  it('keeps the new socket when the old one closes late', async () => {
+    const { session, first, second } = await reconnect()
+    first.emitClose()
+    expect(session.socket).toBe(second)
+  })
 })
`

const passingTests = Array.from({ length: 24 }, (_, index) => `  ✓ gateway > case ${index + 1}`).join('\n')

const script: ScriptStep[] = [
  {
    type: 'dynamic_tool',
    title: 'Update Session Information',
    input: { title: '修复网关重连竞争', description: '我正在复现断线重连时的竞争，并确认旧连接关闭的时序。' },
    result: { output: { message: 'Session information updated.' } },
  },
  {
    type: 'reasoning',
    title: '思考过程',
    result: { text: '旧连接的 close 事件可能晚于新连接建立，先读处理逻辑，再写一个能复现时序的测试。' },
  },
  {
    type: 'dynamic_tool',
    title: 'web_search',
    input: {
      query: 'WebSocket close event ordering after reconnect server side race',
      _meta: { _isValid: true, _activePath: ['query'], _completedPaths: [['query']] },
    },
    result: {
      output: {
        results: [
          { title: 'RFC 6455 §7: Closing the Connection', url: 'https://www.rfc-editor.org/rfc/rfc6455#section-7' },
          { title: 'ws: Handling reconnects', url: 'https://github.com/websockets/ws#readme' },
        ],
      },
    },
  },
  {
    type: 'file_search',
    title: '搜索 resumeSession',
    input: { pattern: 'resumeSession' },
    result: {
      results: [
        {
          fileName: 'apps/server/src/gateway.ts',
          line: 38,
          preview: 'export function resumeSession(session, socket) {',
        },
        { fileName: 'apps/server/src/gateway.test.ts', line: 12, preview: "import { resumeSession } from './gateway'" },
      ],
    },
  },
  {
    type: 'dynamic_tool',
    title: 'Read',
    input: { path: 'apps/server/src/gateway.ts', offset: 30, limit: 20 },
    result: {
      output: [{ type: 'text', text: 'export function resumeSession(session: Session, socket: Socket) {\n  // …\n}' }],
    },
  },
  {
    type: 'file_change',
    title: '已更改 gateway.test.ts',
    input: { fileName: 'apps/server/src/gateway.test.ts' },
    result: { diffStr: testPatch, additions: 5, deletions: 0 },
  },
  {
    type: 'command_execution',
    input: { input: 'pnpm --filter @baton/server test:unit src/gateway.test.ts' },
    result: {
      output:
        'FAIL src/gateway.test.ts > keeps the new socket when the old one closes late\nExpected: second\nReceived: null',
      exitCode: 1,
    },
    failed: true,
  },
  {
    type: 'file_change',
    title: '已更改 gateway.ts',
    input: { fileName: 'apps/server/src/gateway.ts' },
    result: { diffStr: gatewayPatch, additions: 5, deletions: 2 },
  },
  {
    type: 'command_execution',
    input: { input: 'pnpm --filter @baton/server test:unit src/gateway.test.ts' },
    result: { output: `PASS src/gateway.test.ts\n${passingTests}\nDuration  2.314s`, exitCode: 0 },
  },
  {
    type: 'subagent',
    title: '检查其他重连入口',
    input: { prompt: '检查其他调用 resumeSession 的入口是否有相同时序问题。' },
    result: { progress: '已检查 3 个调用点', result: '其他入口都经过 resumeSession，不需要额外修改。' },
  },
]

export const turnStepCount = script.length

export const turnReply = `Done. The change is ready for review.

旧连接的 \`close\` 事件可能晚于新连接建立，会把刚换上的连接清空。现在恢复时先摘掉旧连接的监听，再换上新连接。

- 新增回归测试，修复前失败，修复后通过
- 其他调用 \`resumeSession\` 的入口不需要修改`

// 把第 index 步转成上报给页面的步骤。
export function turnStep(id: string, index: number, finished: boolean, at: string, endedAt?: string): TraceStep {
  const item = script[index]!
  const data = { ...item.input, ...(finished ? item.result : {}) } as TraceStep['data']
  return {
    item_id: `${id}:${index}`,
    type: item.type,
    title: item.title,
    status: !finished ? 'running' : item.failed ? 'failed' : 'completed',
    ordinal: index,
    data,
    started_at: at,
    completed_at: finished ? endedAt : undefined,
    truncated: false,
    original_bytes: new TextEncoder().encode(JSON.stringify(data)).length,
  }
}
