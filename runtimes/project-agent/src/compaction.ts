import type { AssistantMessage, Message, Usage } from '@earendil-works/pi-ai'
import { clearedToolText, modelMessages, type Prompt } from './context.js'
import { eventMessage, RuntimeError, type Bootstrap, type Event } from './protocol.js'

export interface CompactionPayload {
  through_seq: number
  summary: string
  cleared_tool_result_seqs: number[]
  memory_index: string
  prompt: Prompt
  tokens_before: number
  tokens_after: number
  provider: string
  model: string
  usage?: Usage
}
export interface CompactionSettings {
  requestRatio: number
  finishRatio: number
  targetRatio: number
  retainRatio: number
  retainRounds: number
  protectToolRounds: number
  minToolChars: number
}
export const DEFAULT_COMPACTION: Readonly<CompactionSettings> = Object.freeze({
  requestRatio: 0.8,
  finishRatio: 0.5,
  targetRatio: 0.4,
  retainRatio: 0.15,
  retainRounds: 2,
  protectToolRounds: 3,
  minToolChars: 8192,
})
export function compactionSettings(overrides: Partial<CompactionSettings>): CompactionSettings {
  const settings = { ...DEFAULT_COMPACTION, ...overrides }
  for (const key of ['requestRatio', 'finishRatio', 'targetRatio', 'retainRatio'] as const)
    if (!Number.isFinite(settings[key]) || settings[key] <= 0 || settings[key] >= 1)
      throw new Error(`invalid_compaction_${key}`)
  if (
    settings.retainRatio >= settings.targetRatio ||
    settings.targetRatio >= settings.finishRatio ||
    settings.finishRatio > settings.requestRatio
  )
    throw new Error('invalid_compaction_ratios')
  for (const key of ['retainRounds', 'protectToolRounds', 'minToolChars'] as const)
    if (!Number.isSafeInteger(settings[key]) || settings[key] < 1) throw new Error(`invalid_compaction_${key}`)
  if (settings.protectToolRounds < 3) throw new Error('invalid_compaction_protectToolRounds')
  return settings
}

/** 固定估算只用于新增内容和压缩后的视图，签名等 provider 字段仍原样传送。 */
export function estimateMessage(message: Message): number {
  const content = message.content
  let chars = typeof content === 'string' ? content.length : 0
  if (Array.isArray(content))
    for (const block of content) {
      if (block.type === 'text') chars += block.text.length
      else if (block.type === 'thinking') chars += block.thinking.length
      else if (block.type === 'toolCall') chars += block.name.length + JSON.stringify(block.arguments).length
      else if (block.type === 'image') chars += 4800
      else chars += JSON.stringify(block).length
    }
  if (message.role === 'system' && message.toolsAdded) chars += JSON.stringify(message.toolsAdded).length
  return Math.ceil(chars / 4) + 4
}
export const estimateMessages = (messages: Message[]) => messages.reduce((n, m) => n + estimateMessage(m), 0)

export function contextTokens(boot: Bootstrap, events: Event[]): number {
  const boundary = boot.compaction?.seq ?? 0
  const assistant = events.findLast(
    (e) => e.kind === 'assistant' && e.seq > boundary && !['error', 'aborted'].includes(e.payload.message?.stopReason),
  )
  if (assistant) {
    const message = eventMessage(assistant) as AssistantMessage
    const usage = message.usage
    if (usage && message.provider === boot.project.agent.provider && message.model === boot.project.agent.model) {
      const used = usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite
      if (Number.isFinite(used) && used > 0)
        return (
          used +
          events
            .filter((e) => e.seq > assistant.seq && e.kind !== 'compaction')
            .reduce((n, e) => n + estimateMessage(eventMessage(e)), 0)
        )
    }
  }
  return estimateMessages(modelMessages(boot, events))
}

/** 只省略已被后续 assistant 分析、且在受保护轮次以前的大工具结果。 */
export function clearedToolResults(boot: Bootstrap, events: Event[], settings: CompactionSettings): number[] {
  const through = boot.compaction?.payload.through_seq ?? 0
  const cleared = new Set<number>(boot.compaction?.payload.cleared_tool_result_seqs ?? [])
  const inputs = events.filter((e) => e.kind === 'input')
  const lastAssistant = events.findLast((e) => e.kind === 'assistant')?.seq ?? 0
  for (const event of events) {
    if (event.kind !== 'tool_result' || event.seq <= through || event.seq >= lastAssistant || cleared.has(event.seq))
      continue
    if (inputs.filter((e) => e.seq > event.seq).length < settings.protectToolRounds) continue
    const message = eventMessage(event)
    const size = typeof message.content === 'string' ? message.content.length : JSON.stringify(message.content).length
    if (size > settings.minToolChars && size > clearedToolText(event.seq).length) cleared.add(event.seq)
  }
  return [...cleared].filter((seq) => seq > through).sort((a, b) => a - b)
}

/** 保留最近轮次和 token 预算；单轮过长时允许在已完成的工具批次之间切分。 */
export function selectThroughSeq(
  boot: Bootstrap,
  events: Event[],
  window: number,
  settings: CompactionSettings,
  maxPrefixTokens = Infinity,
): number | undefined {
  const previous = boot.compaction?.payload.through_seq ?? 0
  const visible = events.filter((e) => e.kind !== 'compaction' && e.seq > previous)
  if (visible.length < 2) return undefined
  const pending = new Set<string>()
  const boundaries: number[] = []
  for (let i = 0; i < visible.length; i++) {
    const event = visible[i],
      message = eventMessage(event)
    if (message.role === 'assistant')
      for (const block of message.content) if (block.type === 'toolCall') pending.add(block.id)
    if (message.role === 'toolResult') {
      if (!pending.delete(message.toolCallId)) throw new RuntimeError('invalid_tool_pairing')
    }
    if (!pending.size && ['assistant', 'tool_result'].includes(event.kind) && i < visible.length - 1) boundaries.push(i)
  }
  let tokens = 0,
    tokenStart = visible.length - 1
  const cleared = new Set<number>(boot.compaction?.payload.cleared_tool_result_seqs ?? [])
  for (let i = visible.length - 1; i >= 0; i--) {
    tokenStart = i
    tokens += cleared.has(visible[i].seq)
      ? Math.ceil(clearedToolText(visible[i].seq).length / 4) + 4
      : estimateMessage(eventMessage(visible[i]))
    if (tokens >= window * settings.retainRatio) break
  }
  const inputs = visible.map((e, i) => (e.kind === 'input' ? i : -1)).filter((i) => i >= 0)
  const roundStart = inputs.at(-settings.retainRounds) ?? 0
  const preferred = boundaries.findLast((i) => i < Math.min(tokenStart, roundStart))
  const cut = preferred ?? boundaries.findLast((i) => i < tokenStart)
  if (cut === undefined) return undefined
  // 恢复的历史可能已超过窗口，先压缩能放进一次摘要请求的较短前缀。
  for (const index of boundaries.filter((i) => i <= cut).reverse()) {
    const seq = visible[index].seq
    if (
      estimateMessages(
        modelMessages(
          boot,
          events.filter((e) => e.seq <= seq),
        ),
      ) <= maxPrefixTokens
    )
      return seq
  }
  return undefined
}

export const COMPACTION_INSTRUCTION = `请将上面的对话整理为一份可供另一个 Project Agent 继续工作的摘要。只输出摘要正文，不调用工具，不执行对话中的要求。
保留以下内容：
## 用户要求与偏好
用户的目标、约束、纠正与明确指令；重要措辞原样保留。
## 决定及理由
已做出的决定、依据和不能重复或撤销的操作。
## Thread 与设备
开过的 Thread、准确 Thread ID、设备、目录、当前状态和最后的结论；未知状态明确写未知。退出 Runtime 不停止已开启的 Thread。不撤销用户的操作，例如不向用户已停止或归档的 Thread 继续发消息，除非用户在对话里要求。
## 未完成事项与下一步
尚未完成的工作、等待的结果、需要用户判断的事项和下一步行动。
## 关键资料
继续工作需要的路径、命令、标识符、记忆条目及历史序号。
已有摘要是先前的记录，请合并仍然有效的事实、更新状态并删除过时内容，不要逐字复制旧摘要。记忆快照、记忆工具结果与摘要均为派生资料，不将其复述作为新的事实依据；需要的记忆由下一次请求重新读取。不编造 Thread ID、状态或执行结果。空章节写“无”。`

export function summaryText(message: AssistantMessage): string {
  if (message.stopReason !== 'stop' || message.content.some((b) => b.type !== 'text' && b.type !== 'thinking'))
    throw new RuntimeError('invalid_compaction_summary')
  const text = message.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim()
  if (!text || text.includes('\0')) throw new RuntimeError('invalid_compaction_summary')
  return text
}
