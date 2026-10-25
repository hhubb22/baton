import { Agent, type StreamFn } from '@earendil-works/pi-agent-core'
import {
  createAssistantMessageEventStream,
  isContextOverflow,
  type AssistantMessage,
  type Message,
  type Models,
  type ToolCall,
  type ToolResultMessage,
} from '@earendil-works/pi-ai'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { eventMessage, RuntimeError, type Bootstrap, type Event, type RPC } from './protocol.js'
import { toolDefinitions } from './tools.js'
import { batonMessage, modelContext } from './tool-names.js'
import { modelMessages, promptFor } from './context.js'
import {
  clearedToolResults,
  compactionSettings,
  COMPACTION_INSTRUCTION,
  contextTokens,
  estimateMessages,
  selectThroughSeq,
  summaryText,
  type CompactionPayload,
  type CompactionSettings,
} from './compaction.js'

export { modelMessages } from './context.js'

export const IDLE_MS = 180_000
export const RUN_MS = 900_000
export const RETRIES = [5_000, 15_000, 45_000]
const EVENT_BYTES = 160 * 1024
export interface ModelBudget {
  maxOutputTokens: number
  maxModelCalls: number
}
export const DEFAULT_MODEL_BUDGET: Readonly<ModelBudget> = Object.freeze({
  maxOutputTokens: 32000,
  maxModelCalls: 64,
})
const modelFailureCodes = new Set([
  'model_request_failed',
  'model_output_too_large',
  'model_output_truncated_tools',
  'model_call_budget_exhausted',
  'context_overflow_no_progress',
  'context_overflow_budget_exhausted',
])
export interface Clock {
  now(): number
  sleep(ms: number): Promise<void>
}
const clock: Clock = { now: () => performance.now(), sleep: (ms) => delay(ms) }
export class ProjectRuntime {
  private boot!: Bootstrap
  private events: Event[] = []
  private seq = 0
  private results = new Map<string, ToolResultMessage>()
  private started = 0
  private stopAfterWait = false
  private compaction: CompactionSettings
  private budget: ModelBudget
  private modelCalls = 0
  constructor(
    private rpc: RPC,
    private models: Models,
    private timer: Clock = clock,
    compaction: Partial<CompactionSettings> = {},
    budget: Partial<ModelBudget> = {},
  ) {
    this.compaction = compactionSettings(compaction)
    this.budget = { ...DEFAULT_MODEL_BUDGET, ...budget }
    for (const [name, value] of Object.entries(this.budget))
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`invalid_model_budget_${name}`)
  }
  private takeModelCall() {
    if (this.modelCalls >= this.budget.maxModelCalls) throw new RuntimeError('model_call_budget_exhausted')
    this.modelCalls++
  }
  private canRecover() {
    return this.modelCalls < this.budget.maxModelCalls && this.timer.now() - this.started < RUN_MS
  }
  private model() {
    const model = this.models.getModel(this.boot.project.agent.provider, this.boot.project.agent.model)
    if (!model || !Number.isFinite(model.contextWindow) || model.contextWindow <= 0)
      throw new RuntimeError('model_not_found')
    return model
  }
  private async saveCompaction(payload: CompactionPayload): Promise<void> {
    const candidate: Event = { seq: this.seq + 1, kind: 'compaction', payload }
    payload.tokens_before = estimateMessages(modelMessages(this.boot, this.events))
    payload.tokens_after = estimateMessages(modelMessages({ ...this.boot, compaction: candidate }, this.events))
    if (
      payload.tokens_after >= payload.tokens_before ||
      Buffer.byteLength(JSON.stringify(payload, null, 1)) > 160 * 1024
    )
      throw new RuntimeError('invalid_compaction_summary')
    const request = {
      operation: 'commit_compaction',
      last_seq: this.seq,
      client_event_id: randomUUID(),
      payload,
    }
    let saved: Event
    for (let attempt = 0; ; attempt++) {
      try {
        saved = await this.rpc.call(request)
        break
      } catch (error) {
        if (error instanceof RuntimeError && error.code !== 'unavailable') throw error
        if (attempt === RETRIES.length) throw error
        await this.timer.sleep(RETRIES[attempt])
      }
    }
    if (saved.kind !== 'compaction' || saved.seq !== candidate.seq) throw new RuntimeError('invalid_compaction_event')
    this.seq = saved.seq
    this.boot.compaction = saved
    this.boot.compaction_seq = saved.seq
    this.events = this.events.filter((e) => e.seq > payload.through_seq)
    this.events.push(saved)
    this.results.clear()
    for (const event of this.events)
      if (event.kind === 'tool_result') {
        const message = eventMessage(event) as ToolResultMessage
        this.results.set(message.toolCallId, message)
      }
  }
  private async compact(ratio: number, signal?: AbortSignal, force = false, retentionScale = 1): Promise<boolean> {
    // 序号冲突会丢弃旧摘要，从中心的新快照重新选取范围。
    let changed = false,
      conflicts = 0
    while (true) {
      try {
        const before = estimateMessages(modelMessages(this.boot, this.events))
        if (!(await this.compactOnce(ratio, signal, force && !changed, retentionScale))) return changed
        changed = true
        if (estimateMessages(modelMessages(this.boot, this.events)) >= before) return changed
      } catch (error) {
        if (!(error instanceof RuntimeError) || error.code !== 'conflict' || conflicts++ === 1) throw error
        await this.reload()
      }
    }
  }
  private async compactOnce(ratio: number, signal?: AbortSignal, force = false, retentionScale = 1): Promise<boolean> {
    const model = this.model(),
      window = model.contextWindow
    const outputReserve = Math.min(this.budget.maxOutputTokens, model.maxTokens)
    const threshold = Math.min(window * ratio, window - outputReserve)
    if (!force && contextTokens(this.boot, this.events) <= threshold) return false
    signal?.throwIfAborted()
    let changed = false
    const previous = this.boot.compaction?.payload
    const cleared = clearedToolResults(this.boot, this.events, this.compaction)
    if (cleared.length > (previous?.cleared_tool_result_seqs?.length ?? 0)) {
      await this.saveCompaction({
        through_seq: previous?.through_seq ?? 0,
        summary: previous?.summary ?? '',
        cleared_tool_result_seqs: cleared,
        memory_index: previous?.memory_index ?? '',
        prompt: promptFor(this.boot, this.events),
        tokens_before: 0,
        tokens_after: 0,
        provider: model.provider,
        model: model.id,
      })
      changed = true
      if (contextTokens(this.boot, this.events) <= Math.min(window * this.compaction.targetRatio, threshold))
        return true
    }
    const instructionTokens = estimateMessages([{ role: 'user', content: COMPACTION_INSTRUCTION, timestamp: 0 }])
    const through = selectThroughSeq(
      this.boot,
      this.events,
      window,
      { ...this.compaction, retainRatio: this.compaction.retainRatio * retentionScale },
      window - outputReserve - instructionTokens,
    )
    if (through === undefined) return changed
    const metadata: Bootstrap = await this.rpc.call({ operation: 'bootstrap' })
    if (metadata.last_seq !== this.seq) throw new RuntimeError('conflict')
    if (metadata.goal_utf8_base64)
      metadata.project.goal = Buffer.from(metadata.goal_utf8_base64, 'base64').toString('utf8')
    // 只追加指令，摘要前缀保留原提示词、工具声明和消息（含 provider 签名）。
    const prefix = modelMessages(
      this.boot,
      this.events.filter((e) => e.seq <= through),
    )
    const messages: Message[] = [...prefix, { role: 'user', content: COMPACTION_INSTRUCTION, timestamp: 0 }]
    const available = window - estimateMessages(messages)
    if (available <= 0) {
      if (changed) return true
      throw new RuntimeError('model_request_failed')
    }
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted()
      if (!this.canRecover()) throw new RuntimeError('model_call_budget_exhausted')
      this.takeModelCall()
      let payload: CompactionPayload
      try {
        const stream = this.models.streamSimple(model, modelContext({ messages }), {
          maxTokens: Math.min(this.budget.maxOutputTokens, model.maxTokens, available),
          maxRetries: 0,
          sessionId: this.boot.project.conversation.id,
          toolChoice: 'none',
          signal,
        })
        for await (const _ of stream) {
          /* 等待完整摘要，部分输出不能替换历史。 */
        }
        const response = batonMessage(await stream.result())
        payload = {
          through_seq: through,
          summary: summaryText(response),
          cleared_tool_result_seqs: (this.boot.compaction?.payload.cleared_tool_result_seqs ?? []).filter(
            (seq: number) => seq > through,
          ),
          memory_index: metadata.memory_index ?? '',
          prompt: {
            version: metadata.prompt_version,
            title: metadata.project.title,
            goal: metadata.project.goal,
          },
          tokens_before: 0,
          tokens_after: 0,
          provider: model.provider,
          model: model.id,
          usage: response.usage,
        }
        const candidate: Event = {
          seq: this.seq + 1,
          kind: 'compaction',
          payload,
        }
        if (
          estimateMessages(modelMessages({ ...this.boot, compaction: candidate }, this.events)) >=
            estimateMessages(modelMessages(this.boot, this.events)) ||
          Buffer.byteLength(JSON.stringify(payload, null, 1)) > 160 * 1024
        )
          throw new RuntimeError('invalid_compaction_summary')
      } catch {
        if (signal?.aborted) throw new RuntimeError('aborted')
        if (attempt === RETRIES.length) throw new RuntimeError('model_request_failed')
        await this.timer.sleep(RETRIES[attempt])
        continue
      }
      signal?.throwIfAborted()
      await this.saveCompaction(payload)
      return true
    }
  }
  private async reload() {
    this.boot = await this.rpc.call({ operation: 'bootstrap' })
    if (this.boot.goal_utf8_base64)
      this.boot.project.goal = Buffer.from(this.boot.goal_utf8_base64, 'base64').toString('utf8')
    this.events = []
    let after = this.boot.after_seq
    while (true) {
      const page = await this.rpc.call({
        operation: 'read_events',
        after_seq: after,
        max_bytes: 128 * 1024,
      })
      for (const event of page.events ?? []) {
        if (event.seq <= after) throw new RuntimeError('invalid_event_order')
        this.events.push(event)
        after = event.seq
      }
      if (!page.has_more) break
      if (page.next_after_seq !== after || !page.events?.length) throw new RuntimeError('invalid_event_page')
    }
    this.seq = Math.max(this.boot.last_seq, after)
    if (!this.boot.compaction && this.boot.compaction_seq)
      this.boot.compaction = this.events.find((e) => e.seq === this.boot.compaction_seq)
    this.results.clear()
    for (const event of this.events)
      if (event.kind === 'tool_result') {
        const message = eventMessage(event) as ToolResultMessage
        this.results.set(message.toolCallId, message)
      }
  }
  private async execute(call: ToolCall): Promise<ToolResultMessage> {
    const saved = this.results.get(call.id)
    if (saved) return saved
    // Coordinator 持久化工具调用；恢复时使用原调用 ID 获取已保存的 Thread 或结果。
    let requestStarted = this.timer.now()
    let response = await this.rpc.call({
      operation: 'call_tool',
      last_seq: this.seq,
      tool_call_id: call.id,
      tool_name: call.name,
      arguments: call.arguments,
    })
    let waitUntil = Infinity
    let initialCheck = true
    while (response?.pending === true) {
      if (call.name !== 'nodes.exec' || typeof response.thread_id !== 'string' || response.thread_id.length === 0)
        throw new RuntimeError('invalid_tool_result')
      const versioned = response.wait_protocol === 1
      if (versioned) {
        if (
          !Number.isSafeInteger(response.version) ||
          response.version < 0 ||
          !Number.isSafeInteger(response.wait_remaining_ms) ||
          response.wait_remaining_ms < 0
        )
          throw new RuntimeError('invalid_tool_result')
        // 中心期限保持不变；每次响应重新估计，扣除该次请求的往返耗时。
        waitUntil = requestStarted + response.wait_remaining_ms
      }
      const runRemaining = RUN_MS - (this.timer.now() - this.started)
      if (!initialCheck && runRemaining > 0) {
        const waitMs = Math.min(25_000, waitUntil - this.timer.now(), runRemaining)
        if (versioned && this.boot.local_wait_protocol === 1 && waitMs > 0) {
          await this.rpc.call({
            operation: 'poll_wake',
            payload: {
              thread_id: response.thread_id,
              after_version: response.version,
              wait_ms: Math.max(1, Math.floor(waitMs)),
            },
          })
        } else {
          // 旧协议或本地预算耗尽时，短暂退避后再查询中心。
          await this.timer.sleep(Math.min(250, runRemaining))
        }
      }
      initialCheck = false
      const finishWait = this.timer.now() - this.started >= RUN_MS
      if (finishWait) this.stopAfterWait = true
      requestStarted = this.timer.now()
      response = await this.rpc.call({
        operation: 'wait_tool',
        tool_call_id: call.id,
        last_seq: this.seq,
        ...(finishWait ? { payload: { finish_wait: true } } : {}),
      })
      if (this.timer.now() - this.started >= RUN_MS) this.stopAfterWait = true
      if (response?.pending === true && finishWait) throw new RuntimeError('invalid_tool_result')
    }
    const event = response as Event
    if (!event || event.kind !== 'tool_result' || event.seq <= this.seq) throw new RuntimeError('invalid_tool_result')
    this.events.push(event)
    this.seq = event.seq
    const message = eventMessage(event) as ToolResultMessage
    if (message.toolCallId !== call.id) throw new RuntimeError('invalid_tool_result')
    this.results.set(call.id, message)
    return message
  }
  private pendingCalls(): ToolCall[] {
    const assistant = this.events.findLast((e) => e.kind === 'assistant')
    if (!assistant) return []
    return (eventMessage(assistant) as AssistantMessage).content.filter(
      (c): c is ToolCall => c.type === 'toolCall' && !this.results.has(c.id),
    )
  }
  private needsResponse(): boolean {
    const last = this.events.findLast((e) => e.kind !== 'compaction')
    if (!last) return false
    return (
      last.kind === 'input' ||
      last.kind === 'tool_result' ||
      (last.kind === 'assistant' && (eventMessage(last) as AssistantMessage).content.some((c) => c.type === 'toolCall'))
    )
  }
  private async respond() {
    for (const call of this.pendingCalls()) {
      await this.execute(call)
      if (this.stopAfterWait) return
    }
    if (this.stopAfterWait) return
    const model = this.model()
    let fatal: unknown
    const streamFn: StreamFn = async (requestModel, context, options) => {
      const output = createAssistantMessageEventStream()
      // 缓冲一条完成的回复后再交给 Agent，失败和超限输出不能进入持久化或工具执行。
      let outputTokens = Math.min(this.budget.maxOutputTokens, requestModel.maxTokens)
      let outputRecoveries = 0
      let overflowRecoveries = 0
      let outputFeedback = ''
      let attempt = 0
      while (true) {
        let message: AssistantMessage | undefined
        try {
          this.takeModelCall()
          const requestContext = outputFeedback
            ? {
                ...context,
                messages: [
                  ...context.messages,
                  { role: 'user', content: outputFeedback, timestamp: 0 } satisfies Message,
                ],
              }
            : context
          const stream = this.models.streamSimple(requestModel, modelContext(requestContext), {
            ...options,
            maxTokens: outputTokens,
            maxRetries: 0,
          })
          let preview = ''
          let lastPreview = -Infinity
          const publishPreview = async (text: string) => {
            // 预览通过现有 RPC 发送完整快照，正式保存与工具执行仍等待完整回复。
            const bytes = Buffer.from(text)
            const truncated = bytes.length > 32 * 1024
            let end = Math.min(bytes.length, 32 * 1024)
            while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--
            await this.rpc
              .call({
                operation: 'preview',
                last_seq: this.seq,
                payload: {
                  text: bytes.subarray(0, end).toString('utf8'),
                  truncated,
                },
              })
              .catch(() => {})
          }
          for await (const event of stream) {
            if (event.type === 'text_delta') {
              if (Buffer.byteLength(preview) < 32 * 1024 + 4) preview = (preview + event.delta).slice(0, 32 * 1024 + 4)
              if (this.timer.now() - lastPreview >= 1000) {
                lastPreview = this.timer.now()
                await publishPreview(preview)
              }
            }
          }
          message = batonMessage(await stream.result())
          if (message.stopReason === 'error' && isContextOverflow(message, requestModel.contextWindow)) {
            if (!this.canRecover()) throw new RuntimeError('context_overflow_budget_exhausted')
            const before = estimateMessages(modelMessages(this.boot, this.events))
            let compacted: boolean
            try {
              compacted = await this.compact(
                this.compaction.requestRatio,
                options?.signal,
                true,
                0.5 ** overflowRecoveries++,
              )
            } catch (error) {
              fatal =
                error instanceof RuntimeError && error.code === 'model_call_budget_exhausted'
                  ? new RuntimeError('context_overflow_budget_exhausted')
                  : error
              throw fatal
            }
            if (!compacted || estimateMessages(modelMessages(this.boot, this.events)) >= before)
              throw new RuntimeError('context_overflow_no_progress')
            if (!this.canRecover()) throw new RuntimeError('context_overflow_budget_exhausted')
            context = {
              ...context,
              messages: modelMessages(this.boot, this.events),
            }
            continue
          }
          if (message.stopReason === 'error' || message.stopReason === 'aborted')
            throw new Error('model_request_failed')
          const payload = {
            format: 'pi-ai/1',
            message,
            prompt: promptFor(this.boot, this.events),
          }
          // 带缩进表示为 PostgreSQL jsonb 的空格预留容量。
          const payloadBytes = Buffer.byteLength(JSON.stringify(payload, null, 1))
          const truncatedTools =
            message.stopReason === 'length' && message.content.some((block) => block.type === 'toolCall')
          if (payloadBytes > EVENT_BYTES || truncatedTools) {
            const code = truncatedTools ? 'model_output_truncated_tools' : 'model_output_too_large'
            if (outputRecoveries++ >= RETRIES.length || outputTokens <= 1 || !this.canRecover())
              throw new RuntimeError(code)
            if (payloadBytes > EVENT_BYTES)
              outputTokens = Math.max(1, Math.floor(outputTokens * Math.min(0.5, (EVENT_BYTES / payloadBytes) * 0.8)))
            outputFeedback = truncatedTools
              ? '上一条回复因输出 token 上限截断了工具参数，未保存且工具未执行。请缩短或减少本次工具调用，保证每个调用参数完整。'
              : '上一条回复的完整 JSON 超过 160 KiB 保存容量，未保存且工具未执行。请精简回复和工具参数，减少重复内容；每个工具调用必须完整。'
            console.warn(`${code}: ${payloadBytes} bytes; retry_max_output_tokens=${outputTokens}`)
            await this.rpc
              .call({ operation: 'preview', last_seq: this.seq, payload: { text: '', truncated: false } })
              .catch(() => {})
            continue
          }
          if (message.stopReason !== 'stop' && message.stopReason !== 'length' && message.stopReason !== 'toolUse')
            throw new RuntimeError('model_request_failed')
          output.push({
            type: 'done',
            reason: message.stopReason,
            message,
          })
          output.end(message)
          return output
        } catch (error) {
          await this.rpc
            .call({
              operation: 'preview',
              last_seq: this.seq,
              payload: { text: '', truncated: false },
            })
            .catch(() => {})
          if (options?.signal?.aborted) throw new RuntimeError('aborted')
          if (fatal !== undefined && fatal === error) throw error
          if (
            error instanceof RuntimeError &&
            !['model_request_failed', 'invalid_compaction_summary'].includes(error.code)
          ) {
            fatal = error
            throw error
          }
          if (attempt === RETRIES.length) throw new RuntimeError('model_request_failed')
          await this.timer.sleep(RETRIES[attempt++])
        }
      }
    }
    const agent = new Agent({
      initialState: {
        model,
        messages: modelMessages(this.boot, this.events),
        tools: toolDefinitions.map((def) => ({
          ...def,
          label: def.name,
          execute: async (id: string) => {
            const result = this.results.get(id)
            if (!result) throw new RuntimeError('tool_not_persisted')
            return {
              content: result.content,
              details: result.details,
              isError: result.isError,
            }
          },
        })),
      },
      streamFn,
      sessionId: this.boot.project.conversation.id,
      toolExecution: 'sequential',
      prepareRequest: async ({ context }, signal) => {
        try {
          await this.compact(this.compaction.requestRatio, signal)
          return {
            context: {
              ...context,
              messages: modelMessages(this.boot, this.events),
            },
          }
        } catch (error) {
          fatal = error
          throw error
        }
      },
    })
    agent.subscribe(async (event) => {
      if (event.type !== 'message_end' || event.message.role !== 'assistant') return
      if (event.message.stopReason === 'error' || event.message.stopReason === 'aborted') return
      try {
        const saved: Event = await this.rpc.call({
          operation: 'append_event',
          last_seq: this.seq,
          client_event_id: randomUUID(),
          payload: {
            format: 'pi-ai/1',
            message: event.message,
            prompt: promptFor(this.boot, this.events),
          },
        })
        this.seq = saved.seq
        this.events.push(saved)
        for (const call of event.message.content) {
          if (call.type === 'toolCall') await this.execute(call)
          if (this.stopAfterWait) break
        }
        if (this.stopAfterWait) agent.abort()
      } catch (error) {
        fatal = error
        agent.abort()
        throw error
      }
    })
    await agent.continue()
    if (fatal) throw fatal
    if (this.stopAfterWait) return
    if (agent.state.errorMessage) throw new RuntimeError('model_request_failed')
  }
  async run(): Promise<void> {
    this.started = this.timer.now()
    this.modelCalls = 0
    const started = this.started
    this.stopAfterWait = false
    let idleSince = this.timer.now()
    await this.reload()
    if (this.needsResponse()) {
      await this.respond()
      idleSince = this.timer.now()
    }
    while (this.timer.now() - started < RUN_MS) {
      try {
        const claim = await this.rpc.call({
          operation: 'claim_inputs',
          last_seq: this.seq,
        })
        if (claim.event) {
          this.events.push(claim.event)
          this.seq = claim.event.seq
          await this.respond()
          idleSince = this.timer.now()
          continue
        }
      } catch (error) {
        if (error instanceof RuntimeError && error.code === 'conflict') {
          await this.reload()
          if (this.needsResponse()) await this.respond()
          idleSince = this.timer.now()
          continue
        }
        throw error
      }
      if (this.timer.now() - idleSince >= IDLE_MS) break
      await this.rpc.call({
        operation: 'poll_wake',
        payload: {
          wait_ms: Math.max(
            1,
            Math.min(25_000, IDLE_MS - (this.timer.now() - idleSince), RUN_MS - (this.timer.now() - started)),
          ),
        },
      })
    }
    try {
      await this.compact(this.compaction.finishRatio)
    } catch (error) {
      if (!(error instanceof RuntimeError) || !modelFailureCodes.has(error.code)) throw error
      console.warn(`finish_compaction_failed: ${error.code}; original history retained`)
    }
    await this.rpc.call({
      operation: 'finish',
      last_seq: this.seq,
      reason: this.timer.now() - started >= RUN_MS ? 'run_limit' : 'idle',
    })
  }
  async start(): Promise<void> {
    try {
      await this.run()
    } catch (error) {
      if (error instanceof RuntimeError && modelFailureCodes.has(error.code)) {
        await this.rpc.call({
          operation: 'report_failure',
          reason: error.code,
        })
        return
      }
      throw error
    }
  }
}
