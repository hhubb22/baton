import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vite-plus/test'
import { ClientProvider } from '../data/queries'
import { createMockClient } from '../data/mock/client'
import type { BatonClient } from '../data/client'
import type { Device, FullOutputReference, Message, TraceStep } from '../data/types'
import { readFullOutput } from '../data/http/full-output'
import { ActivityTrace, LiveOutput, TurnActivityTrace } from './ReplyParts'

vi.mock('../data/http/full-output', () => ({ readFullOutput: vi.fn() }))

const reference: FullOutputReference = {
  id: '25689309-82b9-4cf7-8cba-7e84d7d30236',
  storage_generation: 'local-generation',
  total_bytes: 98304,
  expires_at: '2099-01-01T00:00:00.000Z',
}
const message: Message = {
  id: 'reply',
  threadId: 'thread',
  role: 'agent',
  sender: 'agent',
  body: 'Reply',
  createdAt: 0,
  delivery: 'delivered',
  activity: { commands: 1, tools: 1, files: 1 },
  attachments: [],
}
const step = (type: string, data: TraceStep['data'], extra: Partial<TraceStep> = {}): TraceStep => ({
  item_id: type,
  type,
  status: 'completed',
  ordinal: 0,
  data,
  truncated: false,
  original_bytes: 100,
  ...extra,
})

it('renders live reply Markdown and hides it when the same reply is saved', async () => {
  const client = createMockClient('normal', { latency: { read: 0, save: 0, device: 0, run: 8000 } })
  const thread = (await client.listThreads()).find((item) => item.id === 'thr-gateway')!
  const device = (await client.listDevices()).find((item) => item.id === thread.deviceId)
  const output = {
    threadId: thread.id,
    replyId: 'native-reply',
    workerTurnSeq: 3,
    chunks: [{ kind: 'text' as const, text: '**Streaming**' }],
  }
  const view = (messages: Message[]) => (
    <ClientProvider client={client}>
      <LiveOutput
        thread={thread}
        device={device}
        live
        now={Date.now()}
        messages={messages}
        output={output}
        onOpenPath={() => {}}
      />
    </ClientProvider>
  )
  const { container, rerender } = render(view([]))
  await vi.waitFor(() => expect(container.querySelector('strong')).toHaveTextContent('Streaming'))
  rerender(view([{ ...message, replyId: 'native-reply', workerTurnSeq: 2 }]))
  expect(container.querySelector('strong')).toHaveTextContent('Streaming')
  rerender(view([{ ...message, replyId: 'native-reply', workerTurnSeq: 3 }]))
  expect(container.querySelector('strong')).toBeNull()
})

function setup(readTrace: BatonClient['readTrace'], device?: Device, reply: Message = message) {
  const client = createMockClient('normal', { latency: { read: 0, save: 0, device: 0, run: 8000 } })
  client.readTrace = readTrace
  const result = render(
    <ClientProvider client={client}>
      <ActivityTrace device={device} message={reply} />
    </ClientProvider>,
  )
  return { ...result, client }
}

it('shows running steps after saved steps and gives saved trace precedence over a late snapshot', async () => {
  const client = createMockClient('normal', { latency: { read: 0, save: 0, device: 0, run: 8000 } })
  const saved = step('dynamic_tool', { output: 'saved result' }, { item_id: 'same', title: 'Saved step' })
  client.readTurnTrace = async () => ({ state: 'ready', messageId: message.id, steps: [saved] })
  const running = [
    step('dynamic_tool', { input: 'stale' }, { item_id: 'same', title: 'Stale step', status: 'running' }),
    step(
      'dynamic_tool',
      { input: 'current' },
      { item_id: 'next', title: 'Running step', status: 'running', ordinal: 1 },
    ),
  ]
  render(
    <ClientProvider client={client}>
      <TurnActivityTrace threadId="thread" turnSeq={1} device={undefined} runningSteps={running} />
    </ClientProvider>,
  )
  expect(await screen.findByText('Saved step')).toBeInTheDocument()
  expect(screen.queryByText('Stale step')).not.toBeInTheDocument()
  expect(screen.getByText('Running step')).toBeInTheDocument()
  expect(
    screen.getByText('Saved step').compareDocumentPosition(screen.getByText('Running step')) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy()
})

it('renders typed steps, gap sizes and full output actions while the device is offline', async () => {
  const user = userEvent.setup()
  const client = createMockClient('normal', { latency: { read: 0, save: 0, device: 0, run: 8000 } })
  const device = (await client.listDevices())[0]
  const read = vi
    .mocked(readFullOutput)
    .mockRejectedValueOnce(new Error('设备已离线 Connect it to read the full output.'))
  const steps = [
    step(
      'command_execution',
      { input: 'printf', output: 'Saved fragment', exitCode: 0 },
      { truncated: true, original_bytes: 98304, full_output: reference },
    ),
    step(
      'dynamic_tool',
      {
        toolName: 'Read',
        nativeToolId: 'read_file',
        input: { path: '/work/source.ts' },
        output: [{ type: 'text', text: 'Saved detail' }],
      },
      { truncated: true, original_bytes: 2048 },
    ),
    step('file_change', { fileName: '/work/source.ts', diffStr: '+ saved change', additions: 1, deletions: 0 }),
    step('reasoning', { text: 'Check the reconnect sequence.' }),
    step('proposed_plan', { markdown: '1. Inspect the handler' }),
    step('todo_list', { steps: [{ text: 'Run the tests', status: 'completed' }] }),
    step('file_search', {
      pattern: 'reconnect',
      results: [{ fileName: 'source.ts', line: 10, preview: 'reconnect()' }],
    }),
    step('web_search', {
      patterns: ['documentation'],
      results: [{ url: 'https://example.test', snippet: 'Saved search result' }],
    }),
    step('approval_request', { prompt: 'Run this command?' }),
    step('token_usage', { inputTokens: 100, outputTokens: 20 }),
    step('subagent', { prompt: 'Inspect the handler', progress: 'Reading source', result: 'Found the race' }),
    step('error', { failure: { message: 'Command interrupted', code: 'interrupted' } }),
  ]
  const { container } = setup(async () => ({ state: 'ready', messageId: message.id, steps }), {
    ...device,
    name: 'Windows Desktop',
    connection: 'offline',
  })
  await user.click(screen.getByRole('button'))
  expect(await screen.findByText('Saved fragment')).toBeInTheDocument()
  expect(screen.getByText('退出码 0')).toBeInTheDocument()
  expect(screen.getByLabelText('工具输入')).toHaveTextContent('/work/source.ts')
  expect(screen.getByText('read_file')).toBeInTheDocument()
  expect(screen.getByText('输入')).toBeInTheDocument()
  expect(screen.getByText('结果')).toBeInTheDocument()
  expect(screen.getByText('Saved detail')).toBeInTheDocument()
  expect(screen.getByText('已更改 source.ts')).toBeInTheDocument()
  expect(screen.getByLabelText('文件改动')).toHaveTextContent('+ saved change')
  expect(screen.getByLabelText('思考过程')).toHaveTextContent('Check the reconnect sequence.')
  expect(screen.getByLabelText('计划')).toHaveTextContent('1. Inspect the handler')
  expect(screen.getByRole('listitem')).toHaveTextContent('Run the tests · 已完成')
  expect(screen.getAllByLabelText('搜索内容')[0]).toHaveTextContent('reconnect')
  expect(screen.getAllByLabelText('搜索结果')).toHaveLength(2)
  expect(screen.getByLabelText('问题')).toHaveTextContent('Run this command?')
  expect(screen.getByLabelText('Token 用量')).toHaveTextContent('100')
  expect(screen.getByLabelText('任务内容')).toHaveTextContent('Inspect the handler')
  expect(screen.getByLabelText('任务进度')).toHaveTextContent('Reading source')
  expect(screen.getByLabelText('任务结果')).toHaveTextContent('Found the race')
  expect(screen.getByLabelText('错误详情')).toHaveTextContent('Command interrupted')
  expect(screen.getByText('原始大小 96 KB，内容已截断 · 完整输出保存在 Windows Desktop')).toHaveAttribute(
    'title',
    '98304 字节',
  )
  expect(screen.getByText('原始大小 2 KB，内容已截断')).toBeInTheDocument()
  expect(screen.getByText('此步骤的其余内容不可用。')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '读取完整输出' }))
  expect(await screen.findByRole('status')).toHaveTextContent('设备已离线')
  expect(read).toHaveBeenCalledWith('thread', reference, '0', expect.any(AbortSignal))
  expect(screen.getByText('Saved fragment')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '读取完整输出' })).toBeInTheDocument()
  expect(container.querySelectorAll('a')).toHaveLength(0)
})

it('offers activity for replies without summary metadata', async () => {
  const user = userEvent.setup()
  setup(
    async () => ({ state: 'ready', messageId: message.id, steps: [step('reasoning', { text: 'Saved reasoning' })] }),
    undefined,
    { ...message, activity: null, traceItemCount: 1 },
  )
  await user.click(screen.getByRole('button', { name: '执行过程 · 1 个步骤' }))
  expect(await screen.findByText('Saved reasoning')).toBeInTheDocument()
})

it('retains all 120 steps across pages and retries a later page without losing earlier steps', async () => {
  const user = userEvent.setup()
  const steps = Array.from({ length: 120 }, (_, ordinal) =>
    step(
      'command_execution',
      { input: `command-${ordinal}`, output: `output-${ordinal}` },
      { item_id: `item-${ordinal}`, ordinal },
    ),
  )
  let fail = true
  const readTrace = vi.fn<BatonClient['readTrace']>(async (_messageId, cursor) => {
    const start = Number(cursor ?? 0)
    if (start === 50 && fail) {
      fail = false
      throw new Error('Connection interrupted')
    }
    return {
      state: 'ready',
      messageId: message.id,
      steps: steps.slice(start, start + 50),
      nextCursor: start + 50 < steps.length ? String(start + 50) : undefined,
    }
  })
  setup(readTrace)
  expect(readTrace).not.toHaveBeenCalled()
  const toggle = screen.getByRole('button')
  await user.click(toggle)
  await screen.findByText('output-49')
  await user.click(screen.getByRole('button', { name: '加载更多执行记录' }))
  expect(await screen.findByRole('status')).toHaveTextContent('无法加载更多执行记录。')
  expect(screen.getByText('output-0')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '重试加载' }))
  await screen.findByText('output-99')
  await user.click(screen.getByRole('button', { name: '加载更多执行记录' }))
  await screen.findByText('output-119')
  expect(screen.getAllByLabelText('命令输出').map((node) => node.textContent)).toEqual(
    steps.map((_, i) => `output-${i}`),
  )
  expect(screen.queryByRole('button', { name: '加载更多执行记录' })).not.toBeInTheDocument()
  expect(readTrace.mock.calls.map((call) => call[1])).toEqual([undefined, '50', '50', '100'])
  await user.click(toggle)
  await user.click(toggle)
  expect(screen.getByText('output-119')).toBeInTheDocument()
  expect(readTrace).toHaveBeenCalledTimes(4)
})

it('labels shell Base64 output without presenting it as decoded text', async () => {
  const user = userEvent.setup()
  setup(async () => ({
    state: 'ready',
    messageId: message.id,
    steps: [step('command_execution', { input: 'printf binary', output: 'AP+A', encoding: 'base64', exitCode: 0 })],
  }))
  await user.click(screen.getByRole('button'))
  expect(await screen.findByText('输出编码： Base64')).toBeInTheDocument()
  expect(screen.getByLabelText('Base64 编码的命令输出')).toHaveTextContent('AP+A')
  expect(screen.queryByLabelText('命令输出')).not.toBeInTheDocument()
})

it('shows unknown and non-object data as text, preserving NUL and lone surrogates without HTML or links', async () => {
  const user = userEvent.setup()
  const raw = '<img src=x onerror=alert(1)>\u0000\ud800 https://example.test'
  const steps = [
    step('future_type', { text: raw }, { title: '<b>Saved title</b>' }),
    step('future_scalar', raw),
    step('future_array', [raw, null, 0]),
    step('reasoning', { text: raw }),
  ]
  const { container } = setup(async () => ({ state: 'ready', messageId: message.id, steps }))
  await user.click(screen.getByRole('button'))
  await screen.findByText('<b>Saved title</b>')
  const outputs = screen.getAllByLabelText('执行详情')
  expect(outputs[0].textContent).toBe(JSON.stringify({ text: raw }, null, 2))
  expect(outputs[1].textContent).toBe(raw)
  expect(screen.getByLabelText('思考过程').textContent).toBe(raw)
  expect(outputs[2].textContent).toBe(JSON.stringify([raw, null, 0], null, 2))
  expect(container.querySelectorAll('a, img, b, script')).toHaveLength(0)
})

it('reads saved mock activity with an offline device and after local history is lost', async () => {
  const client = createMockClient('error', { latency: { read: 0, save: 0, device: 0, run: 8000 } })
  client.controls.setDeviceConnection('dev-mac', 'offline')
  const trace = await client.readTrace('msg-guide-2')
  expect(trace).toMatchObject({
    state: 'ready',
    steps: [expect.objectContaining({ type: 'dynamic_tool' }), expect.objectContaining({ type: 'file_change' })],
  })
})

it('shows a missing record and retries an initial read error', async () => {
  const user = userEvent.setup()
  const readTrace = vi
    .fn<BatonClient['readTrace']>()
    .mockRejectedValueOnce(new Error('Read failed'))
    .mockResolvedValue({ state: 'unavailable', messageId: message.id, reason: 'missing' })
  setup(readTrace)
  await user.click(screen.getByRole('button'))
  expect(await screen.findByRole('status')).toHaveTextContent('无法加载执行过程')
  await user.click(screen.getByRole('button', { name: '重试' }))
  expect(await screen.findByText('这条回复没有保存执行过程。')).toBeInTheDocument()
  expect(within(document.body).queryByRole('button', { name: '读取完整输出' })).not.toBeInTheDocument()
})
