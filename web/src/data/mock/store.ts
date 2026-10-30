import { ClientError, type ChangeEvent, type Topic } from '../client'
import { subscriptionName } from '../http/client'
import { insideFileFolder, fileParent } from '../file-paths'
import {
  agentNames,
  assistantBlock,
  assistantModels,
  blockReason,
  folderName,
  sentenceList,
  usableAgents,
} from '../derive'
import { DEFAULT_RUNTIME_MODE } from '@baton/protocol'
import type {
  AgentKind,
  Device,
  ModelConnection,
  DeviceAgent,
  DeviceConnection,
  DeviceOS,
  EntryThreads,
  FolderListing,
  ID,
  SessionEnd,
  Message,
  Operation,
  OperationKind,
  OperationPhase,
  MemoryNote,
  ProcessStep,
  FilePreview,
  FileReadOptions,
  LiveOutput,
  Project,
  ProjectEntry,
  ProjectPatch,
  SaveMemoryInput,
  MemorySave,
  MemoryVersion,
  Reference,
  SendMode,
  Thread,
  ThreadAnswerInput,
  SubscriptionLoginChallenge,
  Trace,
} from '../types'
import { previewLimit } from '../types'
import { createWorld, type ScenarioId } from './scenarios'
import type { Scheduler } from './scheduler'
import { fileKey, type AssistantContext, type EnrollmentRecord, type PassiveInput, type World } from './world'

export interface Latency {
  // 读取一次数据。
  read: number
  // 中心保存一次写入。
  save: number
  // 设备确认一个动作，例如停止。
  device: number
  // Agent 完成一轮。
  run: number
}

export const browserLatency: Latency = { read: 150, save: 400, device: 900, run: 8000 }

// Agent 收到停止请求一分钟后还没停下，设备结束它的进程。
export const stopTimeout = 60_000

// 设置码 10 分钟内有效，只能用一次。
export const enrollmentTtl = 10 * 60_000

const codeAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'

// 模拟设置码按序号生成，同一场景每次相同，不是可用的凭据。
function sampleCode(seed: number) {
  let state = seed * 7919 + 17
  const group = (length: number) => {
    let out = ''
    for (let index = 0; index < length; index += 1) {
      state = (state * 1103515245 + 12345) % 2147483648
      out += codeAlphabet[state % codeAlphabet.length]
    }
    return out
  }
  return [group(8), group(4), group(4), group(4)].join('-')
}

function separator(path: string) {
  return path.includes('\\') ? '\\' : '/'
}

export function insideFolder(path: string, root: string) {
  return path === root || path.startsWith(root.endsWith(separator(root)) ? root : root + separator(root))
}

// 新对话的标题取第一条消息的第一行。
function titleFrom(body: string) {
  const line = body.trim().split('\n')[0]
  return line.length > 60 ? `${line.slice(0, 59).trimEnd()}…` : line
}

type UserEntry = Extract<ProjectEntry, { kind: 'user' }>

// Project 助手发起的一轮结束后交给助手的结果。
interface Reply {
  threadId: ID
  outcome: 'replied' | 'stopped'
}

const projectHues: Project['hue'][] = ['blue', 'rose', 'green', 'violet', 'amber', 'slate']

// 模拟助手按关键词判断消息是不是要在设备上做的事。
const workPattern =
  /\b(run|test|tests|fix|build|check|verify|reproduce|investigate|update|upgrade|install|audit|review)\b/i

// 比较名字时忽略大小写和连字符，`compat-suite` 与 `Compat suite` 视为相同。
function loose(text: string) {
  return text.toLowerCase().replace(/[-_]+/g, ' ')
}

const newDeviceDefaults: Record<DeviceOS, Pick<Device, 'system' | 'folders' | 'repos'> & { shell: string }> = {
  macOS: { system: 'macOS 15.0.1', folders: ['~/src'], repos: ['~/src/baton'], shell: 'zsh' },
  Linux: { system: 'Ubuntu 24.04', folders: ['~/work'], repos: ['~/work/baton'], shell: 'bash' },
  Windows: { system: 'Windows 11 24H2', folders: ['C:\\src'], repos: ['C:\\src\\baton'], shell: 'pwsh' },
}

// 模拟后端的状态变化规则集中在这里：设备上下线、消息投递和停止。
// 页面和 MockClient 都不直接改 World。
export class MockStore {
  private world: World
  private scenarioId: ScenarioId
  private listeners = new Set<(event: ChangeEvent) => void>()
  private timers = new Set<() => void>()
  private runs = new Map<ID, () => void>()
  // 已发给设备、等待确认的停止，键为操作 ID。
  private stopTimers = new Map<ID, { operation: Operation; cancel: () => void }>()
  private clientIds = new Map<string, { opId: ID; body: string }>()
  private projectClientIds = new Map<string, { id: ID; body: string }>()
  private memoryClientIds = new Map<string, { fingerprint: string; result: MemorySave }>()
  private assistantStops = new Map<ID, () => void>()
  // Project 助手正在进行的一次运行，以及它读走的消息和 Thread 结果；运行被打断时放回。
  private assistantRuns = new Map<
    ID,
    { cancel: () => void; inputs: UserEntry[]; replies: Reply[]; context: AssistantContext }
  >()
  // 等 Project 助手读取的 Thread 结果，键为 Project ID。
  private replies = new Map<ID, Reply[]>()
  // 设备断开打断了运行、要在设备回来后接着运行的 Project。
  private interrupted = new Set<ID>()
  // Thread 当前一轮由谁的消息开始。只有助手开始的一轮，结束后才通知助手。
  private turnOwners = new Map<ID, Message['sender']>()
  private sequence = 0
  readonly scheduler: Scheduler
  readonly latency: Latency

  constructor(scenarioId: ScenarioId, scheduler: Scheduler, latency: Latency) {
    this.scheduler = scheduler
    this.latency = latency
    this.scenarioId = scenarioId
    this.world = createWorld(scenarioId, scheduler.now())
    this.startExistingRuns()
    this.startStreamingDemo()
    this.startProjectStreamingDemo()
  }

  get scenario() {
    return this.scenarioId
  }

  snapshot(): World {
    return structuredClone(this.world)
  }

  subscribe(listener: (event: ChangeEvent) => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emit(...topics: Topic[]) {
    const event = { topics }
    for (const listener of this.listeners) listener(event)
  }

  private schedule(ms: number, task: () => void) {
    const cancel = this.scheduler.after(ms, () => {
      this.timers.delete(cancel)
      task()
    })
    this.timers.add(cancel)
    return () => {
      this.timers.delete(cancel)
      cancel()
    }
  }

  private nextId(prefix: string) {
    this.sequence += 1
    return `${prefix}-${this.sequence}`
  }

  // 重新生成场景。未完成的模拟任务全部取消，同一场景每次得到相同的状态。
  reset(scenarioId: ScenarioId = this.scenarioId) {
    // 取消回调可能修改定时器集合；只遍历本次重置开始时的任务。
    // oxlint-disable-next-line unicorn/no-useless-spread
    for (const cancel of [...this.timers]) cancel()
    this.timers.clear()
    this.runs.clear()
    this.stopTimers.clear()
    this.clientIds.clear()
    this.projectClientIds.clear()
    this.memoryClientIds.clear()
    this.assistantStops.clear()
    this.assistantRuns.clear()
    this.replies.clear()
    this.interrupted.clear()
    this.turnOwners.clear()
    this.sequence = 0
    this.scenarioId = scenarioId
    this.world = createWorld(scenarioId, this.scheduler.now())
    this.startExistingRuns()
    this.startStreamingDemo()
    this.startProjectStreamingDemo()
    this.emit('session', 'devices', 'projects', 'threads', 'messages', 'files', 'operations')
  }

  private startStreamingDemo() {
    if (this.scenarioId !== 'streamingMarkdown') return
    const reply = this.world.messages.find((item) => item.id === 'msg-stream-demo')!
    const content =
      '## 检查结果\n\n已经完成 **网关重连** 的检查，下面是测试结果。\n\n' +
      '| 项目 | 结果 |\n| --- | --- |\n| 重连 | 通过 |\n| 消息恢复 | 通过 |\n\n' +
      '运行以下命令可以再次验证：\n\n```sh\npnpm --filter @baton/server test:unit\n```\n\n' +
      '相关文件：`~/src/baton/README.md`。已验证**自动恢复**，结果如下。\n\n' +
      '$$\n\\text{pass rate} = \\frac{47}{48}\n$$\n\n' +
      '```mermaid\ngraph LR\n  A[Disconnected] --> B[Reconnect]\n```\n\n' +
      '- 保留原有连接状态\n- 断线后重新订阅\n- 记录无法补齐的输出缺口\n\n更多信息见 [React 文档](https://react.dev/)。'
    const characters = Array.from(content)
    const step = 3
    for (let end = step; end < characters.length + step; end += step) {
      this.schedule((end / step) * 160, () => {
        reply.body = characters.slice(0, end).join('')
        reply.streaming = end < characters.length
        this.emit('messages')
      })
    }
  }

  private startProjectStreamingDemo() {
    if (this.scenarioId !== 'streamingProject') return
    const project = this.world.projects.find((item) => item.id === 'prj-compat')!
    const first = this.world.projectEntries.find((item) => item.id === 'ent-compat-2')!
    const second = this.world.projectEntries.find((item) => item.id === 'ent-compat-3')!
    if (first.kind !== 'assistant' || second.kind !== 'assistant') return
    const thread = this.world.threads.find((item) => item.id === 'thr-compat')!
    this.world.projectEntries = this.world.projectEntries.filter(
      (item) => item.id !== first.id && item.id !== second.id,
    )
    this.world.threads = this.world.threads.filter((item) => item.id !== thread.id)
    project.agent.state = 'running'
    project.agent.activity = null
    project.agent.lastSeq = 0
    project.agent.runId = 'demo-project-run-1'
    project.latestReplySeq = 0
    project.readReplySeq = 0
    this.schedule(1500, () => {
      this.world.projectEntries.push({
        id: 'ent-project-stream-tool',
        runId: 'demo-project-run-1',
        projectId: project.id,
        kind: 'assistant',
        body: '',
        threads: null,
        process: [
          {
            kind: 'tool',
            name: 'nodes.exec',
            input: '{"command":"git -C ~/src/compat-suite log -1 --oneline"}',
            output: null,
            status: 'pending',
          },
        ],
        createdAt: this.scheduler.now(),
        sourceSeq: 1,
      })
      project.agent.lastSeq = 1
      this.emit('projects')
    })
    this.schedule(3000, () => {
      const entry = this.world.projectEntries.find((item) => item.id === 'ent-project-stream-tool')
      if (entry?.kind !== 'assistant') return
      const tool = entry.process[0]
      if (tool?.kind !== 'tool') return
      tool.status = 'completed'
      tool.output = '{"output":"4f2c9e1 Add drive letter cases to path tests","exit_code":0}'
      entry.process.push(first.process[1]!)
      project.agent.lastSeq = 2
      this.emit('projects')
    })
    this.schedule(4500, () => {
      thread.status = 'running'
      this.world.threads.push(thread)
      this.world.projectEntries.push({
        ...first,
        id: 'ent-project-stream-opened',
        runId: 'demo-project-run-1',
        body: '',
        process: [],
        createdAt: this.scheduler.now(),
        sourceSeq: 3,
      })
      project.agent.lastSeq = 3
      this.emit('projects', 'threads')
    })
    const stream = (message: string, start: number, afterSeq: number, id: string, runId: string) => {
      for (let end = 8; end < message.length + 8; end += 8) {
        this.schedule(start + (end / 8) * 200, () => {
          project.agent.preview = { afterSeq, text: message.slice(0, end), truncated: false }
          this.emit('projects')
        })
      }
      const savedAt = start + Math.ceil(message.length / 8) * 200 + 350
      this.schedule(savedAt, () => {
        project.agent.preview = null
        project.agent.lastSeq = afterSeq + 1
        project.latestReplySeq = afterSeq + 1
        this.world.projectEntries.push({
          id,
          projectId: project.id,
          kind: 'assistant',
          body: message,
          process: [],
          threads: null,
          createdAt: this.scheduler.now(),
          sourceSeq: afterSeq + 1,
          streamAnchor: afterSeq,
          runId,
        })
        this.emit('projects')
      })
      return savedAt
    }
    const firstSaved = stream(first.body, 5500, 3, 'ent-project-stream-text', 'demo-project-run-1')
    this.schedule(firstSaved + 2000, () => {
      thread.status = 'idle'
      project.agent.runId = 'demo-project-run-2'
      this.world.projectEntries.push({
        ...second,
        id: 'ent-project-stream-replies',
        runId: 'demo-project-run-2',
        body: '',
        createdAt: this.scheduler.now(),
        sourceSeq: 5,
      })
      project.agent.lastSeq = 5
      this.emit('projects', 'threads')
    })
    const secondSaved = stream(second.body, firstSaved + 2500, 5, 'ent-project-stream-final', 'demo-project-run-2')
    this.schedule(secondSaved + 500, () => {
      project.agent.state = 'idle'
      this.emit('projects')
    })
  }

  // ---- 查询辅助 ----

  device(id: ID): Device {
    const device = this.world.devices.find((item) => item.id === id)
    if (!device) throw new ClientError('notFound', `找不到设备 ${id}`)
    return device
  }

  thread(id: ID): Thread {
    const thread = this.world.threads.find((item) => item.id === id)
    if (!thread) throw new ClientError('notFound', `找不到对话 ${id}`)
    return thread
  }

  operation(id: ID): Operation {
    const operation = this.world.operations.find((item) => item.id === id)
    if (!operation) throw new ClientError('notFound', `找不到操作 ${id}`)
    return operation
  }

  project(id: ID): Project {
    const project = this.world.projects.find((item) => item.id === id)
    if (!project) throw new ClientError('notFound', `找不到项目 ${id}`)
    return project
  }

  private online(deviceId: ID) {
    return this.world.devices.find((item) => item.id === deviceId)?.connection === 'online'
  }

  // ---- 会话 ----

  signIn(username: string, password: string) {
    // 模拟登录接受任意非空用户名和密码，密码 `wrong` 用来演示登录失败。
    if (username.trim() === '' || password === '' || password === 'wrong') {
      throw new ClientError('unauthorized', '用户名或密码错误')
    }
    this.world.session.account = { id: 'emp-kaken', name: 'Kaken He', username: username.trim() }
    this.world.session.ended = null
    if (!this.world.session.defaultDeviceId && this.world.devices.length > 0) {
      this.world.session.defaultDeviceId = [...this.world.devices].sort((a, b) => a.registeredAt - b.registeredAt)[0].id
    }
    this.emit('session')
  }

  signOut() {
    this.world.session.account = null
    this.world.session.ended = null
    this.emit('session')
  }

  // 中心让当前会话失效：登录过期，或管理员重置了口令。
  endSession(reason: SessionEnd) {
    if (!this.world.session.account) return
    this.world.session.account = null
    this.world.session.ended = reason
    this.emit('session')
  }

  // ---- 操作 ----

  private createOperation(kind: OperationKind, targetId: ID, detail: string | null = null): Operation {
    const operation: Operation = {
      id: this.nextId('op'),
      kind,
      targetId,
      phase: 'submitted',
      detail,
      updatedAt: this.scheduler.now(),
    }
    this.world.operations.push(operation)
    return operation
  }

  private setPhase(operation: Operation, phase: OperationPhase, detail: string | null = null) {
    operation.phase = phase
    operation.detail = detail
    operation.updatedAt = this.scheduler.now()
  }

  private agentOf(thread: Pick<Thread, 'deviceId' | 'agent'>): DeviceAgent | undefined {
    return this.world.devices
      .find((item) => item.id === thread.deviceId)
      ?.agents.find((item) => item.kind === thread.agent)
  }

  // 同一个 clientId 重试时返回第一次的操作，内容不同则拒绝。
  private repeated(clientId: string, body: string) {
    const existing = this.clientIds.get(clientId)
    if (!existing) return null
    if (existing.body !== body) throw new ClientError('conflict', '此消息已使用不同内容发送')
    return this.operation(existing.opId)
  }

  private userMessage(threadId: ID, body: string): Message {
    const message: Message = {
      id: this.nextId('msg'),
      threadId,
      role: 'user',
      sender: 'you',
      body,
      createdAt: this.scheduler.now(),
      delivery: 'submitted',
      activity: null,
      attachments: [],
    }
    this.world.messages.push(message)
    return message
  }

  createThread(
    input: {
      deviceId: ID
      folder: string
      agent: AgentKind
      model: string
      runtimeMode?: import('@baton/protocol').RuntimeMode
      thinking?: import('@baton/protocol').ThinkingSelection
      executionTimeoutSeconds?: number
      body: string
    },
    clientId: string,
  ) {
    const { deviceId, folder, agent: kind, model, body } = input
    const repeated = this.repeated(clientId, body)
    if (repeated) return repeated
    const device = this.device(deviceId)
    const agent = device.agents.find((item) => item.kind === kind)
    if (body.trim() === '') throw new ClientError('invalid', '消息不能为空')
    if (!device.folders.some((root) => insideFolder(folder, root))) {
      throw new ClientError('invalid', `${folder} 不在 ${device.name} 允许访问的文件夹内`)
    }
    if (!agent || agent.problem) throw new ClientError('invalid', `${device.name} 上的 ${agentNames[kind]} 不可用`)
    if (!agent.models.includes(model)) throw new ClientError('invalid', `${agentNames[kind]} 无法使用 ${model}`)

    const now = this.scheduler.now()
    const thread: Thread = {
      id: this.nextId('thr'),
      title: titleFrom(body),
      deviceId,
      folder,
      agent: kind,
      model,
      runtimeMode: input.runtimeMode ?? DEFAULT_RUNTIME_MODE,
      thinking: input.thinking ?? null,
      executionTimeoutSeconds: input.executionTimeoutSeconds ?? 7200,
      projectId: null,
      status: 'idle',
      stop: null,
      pending: null,
      stopCanceled: 0,
      createdAt: now,
      updatedAt: now,
      runStartedAt: null,
      unread: false,
    }
    this.world.threads.push(thread)
    const message = this.userMessage(thread.id, body)
    const operation = this.createOperation('createThread', thread.id, message.id)
    this.clientIds.set(clientId, { opId: operation.id, body })
    this.emit('threads', 'messages', 'operations')

    this.schedule(this.latency.save, () => {
      message.delivery = 'saved'
      this.setPhase(operation, 'saved', message.id)
      this.route(thread, message, operation)
      this.emit('threads', 'messages', 'operations')
    })
    return operation
  }

  // 停止、归档或无法继续的 Thread 不再接收消息，返回给页面的原因和恢复办法一致。
  private ensureWritable(thread: Thread) {
    if (thread.status === 'archived') throw new ClientError('invalid', '已归档的对话无法接收消息')
    if (thread.pending === 'archive') throw new ClientError('invalid', '对话正在归档')
    if (thread.status !== 'stopped' || !thread.stop) return
    const ended =
      thread.stop.kind === 'historyLost' || thread.stop.kind === 'folderMissing' || thread.stop.kind === 'startFailed'
    if (ended || (thread.stop.kind === 'interrupted' && !this.agentOf(thread)?.abilities.resume)) {
      throw new ClientError('invalid', '此对话无法继续，请新建对话。')
    }
  }

  sendMessage(
    threadId: ID,
    body: string,
    clientId: string,
    mode: SendMode = 'next',
    thinking?: import('@baton/protocol').ThinkingSelection,
  ): Operation {
    const repeated = this.repeated(clientId, body)
    if (repeated) return repeated
    const thread = this.thread(threadId)
    this.ensureWritable(thread)
    if (body.trim() === '') throw new ClientError('invalid', '消息不能为空')
    if (mode === 'now' && !this.agentOf(thread)?.abilities.steer) {
      throw new ClientError(
        'invalid',
        `${thread.agent ? agentNames[thread.agent] : '命令'} 回复时无法读取消息，请选择下一条发送。`,
      )
    }

    const message = this.userMessage(threadId, body)
    if (mode !== 'now') thread.thinking = thinking ?? null
    const operation = this.createOperation('sendMessage', threadId, message.id)
    this.clientIds.set(clientId, { opId: operation.id, body })
    this.emit('messages', 'operations')

    this.schedule(this.latency.save, () => {
      message.delivery = 'saved'
      this.setPhase(operation, 'saved', message.id)
      thread.updatedAt = this.scheduler.now()
      if (mode === 'now' && thread.status === 'running' && !thread.pending && this.online(thread.deviceId)) {
        // Agent 在当前回复中读到这条消息，这一轮重新计时。
        message.delivery = 'delivered'
        this.setPhase(operation, 'running', message.id)
        this.scheduleRunEnd(thread.id)
      } else {
        this.route(thread, message, operation)
      }
      this.emit('threads', 'messages', 'operations')
    })
    return operation
  }

  // 已保存的消息：设备离线时等待设备，执行中或正在停止时排到下一轮，否则开始新的一轮。
  private route(thread: Thread, message: Message, operation: Operation) {
    if (!this.online(thread.deviceId)) {
      message.delivery = 'waitingDevice'
      this.setPhase(operation, 'waitingDevice', message.id)
      if (thread.status !== 'running') thread.status = 'waiting'
      return
    }
    if (thread.status === 'running' || thread.status === 'waiting' || thread.pending) {
      message.delivery = 'queued'
      this.setPhase(operation, 'queued', message.id)
      return
    }
    this.startRun(thread, message, operation)
  }

  private startRun(thread: Thread, message: Message, operation: Operation | null) {
    const now = this.scheduler.now()
    thread.updatedAt = now
    this.turnOwners.set(thread.id, message.sender)
    if (!this.world.directories[thread.deviceId]?.includes(thread.folder)) {
      // 目录在设备上不存在，Agent 不会启动，消息也没有发出。
      message.delivery = 'withdrawn'
      if (operation) this.setPhase(operation, 'failed', `Folder not found: ${thread.folder}`)
      this.withdrawPending(thread)
      thread.status = 'stopped'
      thread.stop = { kind: 'folderMissing', detail: thread.folder }
      thread.runStartedAt = null
      this.notifyProject(thread, 'stopped')
      return
    }
    message.delivery = 'delivered'
    thread.status = 'running'
    thread.stop = null
    thread.stopCanceled = 0
    thread.runStartedAt = now
    this.world.outputs[thread.id] = [{ kind: 'text', text: `$ cd ${thread.folder}\n` }]
    if (operation) this.setPhase(operation, 'running', message.id)
    this.scheduleRunEnd(thread.id)
  }

  // 一轮执行到一半时设备报告一段输出，结束时整理成回复。
  private scheduleRunEnd(threadId: ID) {
    this.runs.get(threadId)?.()
    const cancelOutput = this.schedule(this.latency.run / 2, () => {
      this.appendOutput(threadId, '$ pnpm test\nPASS src/gateway.test.ts (48 tests)\nDuration  2.314s\n')
    })
    const cancelEnd = this.schedule(this.latency.run, () => {
      this.runs.delete(threadId)
      this.finishRun(threadId)
    })
    this.runs.set(threadId, () => {
      cancelOutput()
      cancelEnd()
    })
  }

  private appendOutput(threadId: ID, text: string) {
    const chunks = this.world.outputs[threadId] ?? []
    this.world.outputs[threadId] = [...chunks, { kind: 'text', text }]
    this.emit('messages')
  }

  private cancelRun(threadId: ID) {
    this.runs.get(threadId)?.()
    this.runs.delete(threadId)
  }

  private operationFor(messageId: ID) {
    return this.world.operations.find(
      (item) => (item.kind === 'sendMessage' || item.kind === 'createThread') && item.detail === messageId,
    )
  }

  private finishRun(threadId: ID) {
    const thread = this.thread(threadId)
    if (thread.status !== 'running' || thread.pending) return
    const now = this.scheduler.now()
    const reply: Message = {
      id: this.nextId('msg'),
      threadId,
      role: 'agent',
      sender: 'agent',
      body: 'Done. The change is ready for review.',
      createdAt: now,
      delivery: 'delivered',
      activity: { commands: 1, tools: 0, files: 0 },
      attachments: [],
    }
    this.world.messages.push(reply)
    // 一轮结束后，命令和输出作为过程步骤保存在中心。
    const output = (this.world.outputs[threadId] ?? []).flatMap((chunk) => (chunk.kind === 'text' ? [chunk.text] : []))
    const data = { input: 'pnpm test', output: output.join('').trimEnd(), exitCode: 0 }
    this.world.traces[reply.id] = [
      {
        item_id: `${reply.id}:command`,
        type: 'command_execution',
        status: 'completed',
        ordinal: 0,
        data,
        truncated: false,
        original_bytes: new TextEncoder().encode(JSON.stringify(data)).length,
      },
    ]
    delete this.world.outputs[threadId]
    this.endRunningSends(thread, 'done')
    thread.status = 'idle'
    thread.runStartedAt = null
    thread.updatedAt = now
    thread.unread = true
    this.notifyProject(thread, 'replied')
    this.startNext(thread)
    this.emit('threads', 'messages', 'operations')
  }

  markThreadRead(threadId: ID) {
    const thread = this.thread(threadId)
    if (!thread.unread) return
    thread.unread = false
    this.emit('threads')
  }

  private endRunningSends(thread: Thread, phase: 'done' | 'stopped') {
    for (const operation of this.world.operations) {
      if (operation.targetId !== thread.id || operation.phase !== 'running') continue
      if (operation.kind === 'sendMessage' || operation.kind === 'createThread') {
        this.setPhase(operation, phase, operation.detail)
      }
    }
  }

  // 一轮结束或设备上线后，发出最早一条排队或等待设备的消息。
  private startNext(thread: Thread) {
    const next = this.world.messages.find(
      (item) =>
        item.threadId === thread.id &&
        item.role === 'user' &&
        (item.delivery === 'queued' || item.delivery === 'waitingDevice'),
    )
    if (!next) {
      if (thread.status === 'waiting') thread.status = 'idle'
      return
    }
    this.startRun(thread, next, this.operationFor(next.id) ?? null)
  }

  // 撤回还没发给 Agent 的消息，返回撤回的条数。
  private withdrawPending(thread: Thread) {
    let count = 0
    for (const message of this.world.messages) {
      if (message.threadId !== thread.id || message.role !== 'user') continue
      if (message.delivery === 'queued' || message.delivery === 'waitingDevice') {
        message.delivery = 'withdrawn'
        count += 1
        const pending = this.operationFor(message.id)
        if (pending) this.setPhase(pending, 'stopped', message.id)
      }
    }
    return count
  }

  cancelMessage(messageId: ID): Message {
    const message = this.world.messages.find((item) => item.id === messageId)
    if (!message || message.role !== 'user') throw new ClientError('notFound', `找不到消息 ${messageId}`)
    if (message.delivery === 'withdrawn') return message
    if (message.delivery !== 'queued' && message.delivery !== 'waitingDevice') {
      throw new ClientError('conflict', '此消息已发送')
    }
    const thread = this.thread(message.threadId)
    message.delivery = 'withdrawn'
    const operation = this.operationFor(message.id)
    if (operation) this.setPhase(operation, 'stopped', message.id)
    if (thread.status === 'waiting') this.startNext(thread)
    this.emit('threads', 'messages', 'operations')
    return message
  }

  answerThreadQuestion(threadId: ID, answer: ThreadAnswerInput): Thread {
    const thread = this.thread(threadId)
    if (
      thread.status !== 'running' ||
      thread.pending ||
      !thread.pendingQuestions?.some((item) => item.request_id === answer.request_id)
    )
      throw new ClientError('conflict', '问题已关闭。')
    thread.pendingQuestions = thread.pendingQuestions.filter((item) => item.request_id !== answer.request_id)
    this.emit('threads')
    return thread
  }

  setThreadExecutionLimit(threadId: ID, executionTimeoutSeconds: number): Thread {
    const thread = this.thread(threadId)
    this.ensureWritable(thread)
    if (
      !Number.isInteger(executionTimeoutSeconds) ||
      executionTimeoutSeconds <= 0 ||
      executionTimeoutSeconds > 2147483647
    )
      throw new ClientError('invalid', '请输入 1 至 2147483647 之间的整数。')
    thread.executionTimeoutSeconds = executionTimeoutSeconds
    thread.updatedAt = this.scheduler.now()
    this.emit('threads')
    return thread
  }

  setThreadModel(threadId: ID, model: string): Thread {
    const thread = this.thread(threadId)
    this.ensureWritable(thread)
    const agent = this.agentOf(thread)
    const name = thread.agent ? agentNames[thread.agent] : 'Command'
    if (thread.model === model) return thread
    if (!agent?.abilities.switchModel) {
      throw new ClientError('invalid', `${name} 无法在此对话中切换模型，请新建对话。`)
    }
    if (!agent.models.includes(model)) throw new ClientError('invalid', `${name} 无法使用 ${model}`)
    thread.model = model
    thread.thinking = null
    thread.updatedAt = this.scheduler.now()
    this.emit('threads')
    return thread
  }

  stopThread(threadId: ID): Operation {
    const thread = this.thread(threadId)
    if (thread.status === 'archived') throw new ClientError('invalid', '对话已归档')
    if (thread.status === 'running' && !this.agentOf(thread)?.abilities.stop) {
      throw new ClientError('invalid', `无法从 Baton 停止 ${thread.agent ? agentNames[thread.agent] : '命令'}`)
    }
    const existing = this.pendingEnd(thread)
    if (existing) return existing
    const operation = this.createOperation('stopThread', threadId)
    this.emit('operations')

    this.schedule(this.latency.save, () => {
      const canceled = this.withdrawPending(thread)
      if (thread.status !== 'running') {
        if (thread.status === 'waiting') thread.status = 'idle'
        this.setPhase(operation, 'stopped')
      } else {
        thread.pending = 'stop'
        thread.stopFailed = false
        thread.stopCanceled = canceled
        this.sendStop(thread, operation)
      }
      thread.updatedAt = this.scheduler.now()
      this.emit('threads', 'messages', 'operations')
    })
    return operation
  }

  archiveThread(threadId: ID): Operation {
    const thread = this.thread(threadId)
    if (thread.status === 'archived') throw new ClientError('invalid', '对话已归档')
    if (thread.status === 'running' && !this.agentOf(thread)?.abilities.stop) {
      throw new ClientError('invalid', `请等待 ${thread.agent ? agentNames[thread.agent] : '命令'} 完成后归档对话`)
    }
    const operation = this.createOperation('archiveThread', threadId)
    this.emit('operations')

    this.schedule(this.latency.save, () => {
      const canceled = this.withdrawPending(thread)
      // 已经在停止时沿用那次停止，设备确认后归档。
      const stop = thread.pending ? this.pendingEnd(thread) : undefined
      if (thread.status === 'running') {
        thread.pending = 'archive'
        thread.stopCanceled += canceled
        if (stop) {
          this.setPhase(operation, stop.phase === 'waitingDevice' ? 'waitingDevice' : 'stopping')
          this.setPhase(stop, 'stopped')
          this.retarget(stop, operation)
        } else {
          this.sendStop(thread, operation)
        }
      } else {
        this.archive(thread, operation)
      }
      thread.updatedAt = this.scheduler.now()
      this.emit('threads', 'messages', 'operations')
    })
    return operation
  }

  private pendingEnd(thread: Thread) {
    return this.world.operations.find(
      (item) =>
        item.targetId === thread.id &&
        (item.kind === 'stopThread' || item.kind === 'archiveThread') &&
        (item.phase === 'submitted' || item.phase === 'stopping' || item.phase === 'waitingDevice'),
    )
  }

  // 停止请求已发给设备时，设备确认后完成的是归档操作。
  private retarget(previous: Operation | undefined, next: Operation) {
    const timer = previous && this.stopTimers.get(previous.id)
    if (!timer) return
    this.stopTimers.delete(previous.id)
    this.stopTimers.set(next.id, timer)
    timer.operation = next
  }

  private archive(thread: Thread, operation: Operation) {
    thread.status = 'archived'
    thread.pending = null
    thread.runStartedAt = null
    this.setPhase(operation, 'done')
  }

  // 设备在线时发出停止请求；离线时请求已保存，等设备连上再发。
  private sendStop(thread: Thread, operation: Operation) {
    if (!this.online(thread.deviceId)) {
      this.setPhase(operation, 'waitingDevice')
      return
    }
    this.setPhase(operation, 'stopping')
    const stubborn = this.world.stubbornStops.includes(thread.id)
    const timer = { operation, cancel: () => {} }
    timer.cancel = this.schedule(stubborn ? stopTimeout : this.latency.device, () => {
      this.stopTimers.delete(timer.operation.id)
      this.confirmStop(thread, timer.operation, stubborn ? 'forced' : 'byYou')
    })
    this.stopTimers.set(operation.id, timer)
  }

  // 只有设备确认停止后，Thread 才变为已停止或已归档。停止后发的消息接着发出。
  private confirmStop(thread: Thread, operation: Operation, kind: 'byYou' | 'forced') {
    this.cancelRun(thread.id)
    this.endRunningSends(thread, 'stopped')
    thread.runStartedAt = null
    thread.updatedAt = this.scheduler.now()
    this.notifyProject(thread, 'stopped')
    if (operation.kind === 'archiveThread') {
      this.archive(thread, operation)
    } else {
      thread.status = 'stopped'
      thread.pending = null
      thread.stop = { kind, detail: null }
      this.setPhase(operation, 'stopped')
      this.startNext(thread)
    }
    this.emit('threads', 'messages', 'operations')
  }

  resumeThread(threadId: ID): Operation {
    const thread = this.thread(threadId)
    const device = this.device(thread.deviceId)
    if (thread.status !== 'stopped' || thread.stop?.kind !== 'interrupted') {
      throw new ClientError('invalid', '此对话无需恢复')
    }
    if (!this.agentOf(thread)?.abilities.resume) {
      throw new ClientError(
        'invalid',
        `${device.name} 上的 ${thread.agent ? agentNames[thread.agent] : '命令'} 不支持恢复`,
      )
    }
    if (!this.online(device.id)) throw new ClientError('invalid', `请重新连接 ${device.name} 后恢复对话`)
    const operation = this.createOperation('resumeThread', threadId)
    this.emit('operations')

    this.schedule(this.latency.save + this.latency.device, () => {
      if (this.world.lostHistory.includes(thread.id)) {
        thread.stop = { kind: 'historyLost', detail: null }
        this.setPhase(operation, 'failed', 'Thread history not found')
      } else {
        thread.status = 'idle'
        thread.stop = null
        this.setPhase(operation, 'done')
      }
      thread.updatedAt = this.scheduler.now()
      this.emit('threads', 'operations')
    })
    return operation
  }

  retryProject(projectId: ID) {
    const project = this.project(projectId)
    if (project.status !== 'active') throw new ClientError('invalid', '请先恢复项目，再重试。')
    if (project.attention === 'failing') {
      project.attention = null
      project.attentionReason = null
      this.wake(project)
      this.emit('projects')
      return project
    }
    if (project.agent.state !== 'blocked') return project
    if (!this.pickDevice(project)) {
      throw new ClientError('invalid', '没有可用设备。请在在线设备上登录后重试，消息已保存。')
    }
    project.agent = { ...project.agent, state: 'idle', reason: null }
    this.interrupted.add(projectId)
    this.wake(project)
    this.emit('projects')
    return project
  }

  // ---- 设备事件 ----

  setDeviceConnection(deviceId: ID, connection: DeviceConnection) {
    const device = this.device(deviceId)
    if (device.connection === connection) return
    device.connection = connection
    device.lastSeenAt = this.scheduler.now()

    if (connection === 'online') this.deviceOnline(device)
    else this.deviceUnavailable(device)
    this.emit('devices', 'threads', 'messages', 'projects', 'files', 'operations')
  }

  private deviceOnline(device: Device) {
    for (const operation of this.world.operations) {
      if (operation.kind !== 'stopThread' && operation.kind !== 'archiveThread') continue
      if (operation.phase !== 'waitingDevice') continue
      const thread = this.thread(operation.targetId)
      if (thread.deviceId === device.id) this.sendStop(thread, operation)
    }
    for (const thread of this.world.threads) {
      if (thread.deviceId !== device.id) continue
      if (this.world.outputLoss.includes(thread.id) && this.world.outputs[thread.id]) {
        this.world.outputs[thread.id].push({ kind: 'gap' })
        this.world.outputLoss = this.world.outputLoss.filter((id) => id !== thread.id)
      }
      if (thread.status === 'running' && !thread.pending) this.scheduleRunEnd(thread.id)
      else if (thread.status === 'waiting' || thread.status === 'idle') this.startNext(thread)
    }
    for (const project of this.world.projects) {
      if (project.status === 'active' && project.agent.state === 'waitingDevice') this.wake(project)
    }
  }

  // 设备离线或重新同步时，执行中的一轮继续由设备负责，网页上不把它当成已结束。
  // 已发出但没确认的停止回到等待设备，重新连上后再发一次。
  private deviceUnavailable(device: Device) {
    for (const thread of this.world.threads) {
      if (thread.deviceId === device.id && thread.status === 'running') this.cancelRun(thread.id)
    }
    // 取消和状态通知可能修改停止任务集合，保留当前任务快照。
    // oxlint-disable-next-line unicorn/no-useless-spread
    for (const [id, timer] of [...this.stopTimers]) {
      if (this.thread(timer.operation.targetId).deviceId !== device.id) continue
      timer.cancel()
      this.stopTimers.delete(id)
      this.setPhase(timer.operation, 'waitingDevice')
    }
    // 助手所在设备不可用时换到另一台符合条件的设备接着运行；没有时把读到的消息和结果放回，等设备。
    for (const project of this.world.projects) {
      if (project.agent.deviceId !== device.id || project.agent.state !== 'running') continue
      const configuration = this.assistantRuns.get(project.id)?.context ?? project
      const runningProject = { ...project, subscription: configuration.subscription, model: configuration.model }
      const fallback = this.pickDevice(runningProject)
      if (fallback) {
        this.switchNote(runningProject, fallback, device)
        project.agent.deviceId = fallback.id
        continue
      }
      this.cancelAssistant(project, true)
      for (const entry of this.unread(project)) entry.delivery = 'waitingDevice'
      this.interrupted.add(project.id)
      project.agent = {
        state: 'waitingDevice',
        deviceId: device.id,
        reason: this.waitReason(project),
        activity: null,
      }
    }
  }

  // ---- 设备管理 ----

  setDefaultDevice(deviceId: ID) {
    this.device(deviceId)
    this.world.session.defaultDeviceId = deviceId
    this.emit('session', 'devices')
  }

  private onlineDevice(deviceId: ID) {
    const device = this.device(deviceId)
    if (device.connection !== 'online') throw new ClientError('unavailable', '请重新连接此设备后继续。')
    return device
  }

  addDeviceFolder(deviceId: ID, path: string): Device {
    const device = this.onlineDevice(deviceId)
    path = path.trim()
    const absolutePath = path.split(separator(path)).join('/')
    if (!absolutePath.startsWith('/') && !(/^[a-z]:/i.test(absolutePath) && absolutePath[2] === '/')) {
      throw new ClientError('invalid', '请输入文件夹的绝对路径。')
    }
    if (!device.folders.includes(path)) device.folders.push(path)
    const directories = (this.world.directories[deviceId] ??= [])
    if (!directories.includes(path)) directories.push(path)
    this.emit('devices', 'files')
    return device
  }

  removeDeviceFolder(deviceId: ID, path: string): Device {
    const device = this.onlineDevice(deviceId)
    path = path.trim()
    if (!device.folders.includes(path)) throw new ClientError('notFound', '此文件夹已不再共享。')
    device.folders = device.folders.filter((folder) => folder !== path)
    device.repos = device.repos.filter((repo) => device.folders.some((root) => insideFolder(repo, root)))
    this.emit('devices', 'files')
    return device
  }

  startSubscriptionLogin(deviceId: ID, provider: string): SubscriptionLoginChallenge {
    const device = this.onlineDevice(deviceId)
    if (!device.hasRuntime) throw new ClientError('unavailable', '请先在此设备上安装项目助手。')
    return {
      provider: subscriptionName(provider),
      verificationUri: provider.toLowerCase().includes('xai')
        ? 'https://auth.x.ai/activate'
        : 'https://auth.openai.com/codex/device',
      userCode: 'BATON-1234',
      expiresInSeconds: 900,
    }
  }

  configureModelConnection(deviceId: ID, action: 'save' | 'delete' | 'get', connection: ModelConnection) {
    const device = this.onlineDevice(deviceId)
    const connections = (device.modelConnections ??= [])
    const index = connections.findIndex((item) => item.id === connection.id)
    if (action === 'get') return connections[index]
    if (action === 'delete') {
      if (index >= 0) connections.splice(index, 1)
    } else if (index >= 0) connections[index] = { ...connection, keyNeeded: connections[index].keyNeeded }
    else connections.push({ ...connection, keyNeeded: true })
    this.emit('devices', 'projects')
    return undefined
  }

  logoutSubscription(deviceId: ID, provider: string) {
    const device = this.onlineDevice(deviceId)
    const subscription = device.subscriptions.find((item) => item.provider === subscriptionName(provider))
    if (subscription) Object.assign(subscription, { signedIn: false, status: 'login_required' })
    this.emit('devices', 'projects')
  }

  completeSubscriptionLogin(deviceNameOrId: string, provider: string) {
    const device = this.world.devices.find((item) => item.id === deviceNameOrId || item.name === deviceNameOrId)
    if (!device) throw new ClientError('notFound', '找不到设备')
    provider = subscriptionName(provider)
    const subscription = device.subscriptions.find((item) => item.provider === provider)
    if (subscription) Object.assign(subscription, { signedIn: true, status: 'available' })
    else device.subscriptions.push({ provider, signedIn: true, status: 'available' })
    this.emit('devices', 'projects')
  }

  setCommandAccess(deviceId: ID, enabled: boolean): Device {
    const device = this.device(deviceId)
    device.commandAccess.enabled = enabled
    this.emit('devices')
    return device
  }

  // 断开后这台设备不能再用原来的凭据连回来。历史 Thread 和消息保留，设备上已经在运行的 Agent 不受影响。
  removeDevice(deviceId: ID) {
    const device = this.device(deviceId)
    this.world.devices = this.world.devices.filter((item) => item !== device)
    if (this.world.session.defaultDeviceId === deviceId) this.world.session.defaultDeviceId = null
    this.deviceUnavailable(device)
    this.emit('session', 'devices', 'threads', 'messages', 'projects', 'files', 'operations')
  }

  createEnrollment(nodeId?: ID): EnrollmentRecord {
    if (nodeId !== undefined && this.device(nodeId).credentialState === 'revoked')
      throw new ClientError('conflict', '设备已断开')
    this.sequence += 1
    const record: EnrollmentRecord = {
      id: `enr-${this.sequence}`,
      code: sampleCode(this.sequence),
      targetNodeId: nodeId,
      state: 'pending',
      expiresAt: this.scheduler.now() + enrollmentTtl,
      deviceId: null,
    }
    this.world.enrollments.push(record)
    this.schedule(enrollmentTtl, () => this.closeEnrollment(record, 'expired'))
    this.emit('devices')
    return record
  }

  enrollment(id: ID): EnrollmentRecord {
    const record = this.world.enrollments.find((item) => item.id === id)
    if (!record) throw new ClientError('notFound', `找不到设置码 ${id}`)
    return record
  }

  pendingEnrollment() {
    return this.world.enrollments.findLast((item) => item.state === 'pending') ?? null
  }

  closeEnrollment(record: EnrollmentRecord, state: 'expired' | 'used') {
    if (record.state !== 'pending') return
    record.state = state
    this.emit('devices')
  }

  // 设备用最近一个有效的设置码完成注册：先同步设备信息，再上线。还没有默认设备时，它成为默认设备。
  connectEnrollment(name: string, os: DeviceOS) {
    const record = this.pendingEnrollment()
    if (!record) return
    if (record.targetNodeId !== undefined) {
      const device = this.device(record.targetNodeId)
      if (device.credentialState === 'revoked') throw new ClientError('conflict', '设备已断开')
      device.credentialState = 'active'
      record.state = 'connected'
      record.deviceId = device.id
      this.setDeviceConnection(device.id, 'syncing')
      this.schedule(this.latency.device, () => this.setDeviceConnection(device.id, 'online'))
      return
    }
    const defaults = newDeviceDefaults[os]
    const world = this.world
    const device: Device = {
      id: this.nextId('dev'),
      name,
      os,
      system: defaults.system,
      batondVersion: '0.9.2',
      connection: 'syncing',
      lastSeenAt: this.scheduler.now(),
      registeredAt: this.scheduler.now(),
      agents: [],
      subscriptions: [{ provider: 'ChatGPT', signedIn: true }],
      hasRuntime: true,
      folders: [...defaults.folders],
      repos: [...defaults.repos],
      commandAccess: { enabled: false, user: world.session.account?.username ?? 'kaken', shell: defaults.shell },
    }
    world.devices.push(device)
    record.state = 'connected'
    record.deviceId = device.id
    if (!world.session.defaultDeviceId) world.session.defaultDeviceId = device.id
    this.emit('session', 'devices')

    this.schedule(this.latency.device, () => {
      if (!world.devices.includes(device)) return
      const abilities = { create: true, queue: true, steer: true, stop: true, resume: true, switchModel: true }
      device.agents = [
        {
          kind: 'codex',
          status: 'available',
          reason: null,
          version: '0.98.0',
          models: ['gpt-6.1-sol', 'gpt-6.1-mini'],
          defaultModel: 'gpt-6.1-sol',
          abilities,
          account: 'ChatGPT',
          problem: null,
        },
        {
          kind: 'pi',
          status: 'available',
          reason: null,
          version: '0.31.0',
          models: ['gpt-6.1-sol'],
          defaultModel: 'gpt-6.1-sol',
          abilities: { ...abilities, switchModel: false },
          account: null,
          problem: null,
        },
      ]
      this.setDeviceConnection(device.id, 'online')
    })
  }

  // 场景里已经在执行或正在停止的 Thread 和 Project 助手接着往下走。
  private startExistingRuns() {
    for (const thread of this.world.threads) {
      if (thread.status !== 'running') continue
      const started = this.world.messages.findLast(
        (item) => item.threadId === thread.id && item.role === 'user' && item.delivery === 'delivered',
      )
      if (started) this.turnOwners.set(thread.id, started.sender)
      if (!thread.pending && this.online(thread.deviceId)) this.scheduleRunEnd(thread.id)
    }
    for (const project of this.world.projects) {
      if (project.status !== 'active' || project.agent.state !== 'running') continue
      if (!project.agent.deviceId || !this.online(project.agent.deviceId)) continue
      this.startAssistantRun(project, [], [])
    }
    for (const operation of this.world.operations) {
      if (operation.phase === 'stopping') this.sendStop(this.thread(operation.targetId), operation)
    }
  }

  // ---- Project ----

  createProject(
    input: {
      name: string
      emoji?: string
      goal: string
      subscription: string
      sourceNodeId?: string | null
      model: string
    },
    clientId: string,
  ) {
    const existing = this.projectClientIds.get(clientId)
    if (existing) return this.project(existing.id)
    const name = input.name.trim()
    if (name === '') throw new ClientError('invalid', '请输入项目名称。')
    if (
      input.sourceNodeId
        ? !this.world.devices.some((device) => device.id === input.sourceNodeId) ||
          !input.subscription.startsWith('api-') ||
          !input.model.trim()
        : !Object.hasOwn(assistantModels, input.subscription) ||
          !assistantModels[input.subscription].includes(input.model)
    ) {
      throw new ClientError('invalid', `${input.subscription} 无法使用 ${input.model}`)
    }
    if (this.world.failProjectSaves > 0) {
      this.world.failProjectSaves -= 1
      throw new ClientError('unavailable', 'Baton 无法保存此项目')
    }
    const used = new Set(this.world.projects.map((item) => item.hue))
    const project: Project = {
      id: this.nextId('prj'),
      name,
      emoji: input.emoji ?? '📁',
      hue: projectHues.find((hue) => !used.has(hue)) ?? projectHues[this.world.projects.length % projectHues.length],
      status: 'active',
      attention: null,
      attentionReason: null,
      latestReplySeq: 0,
      readReplySeq: 0,
      archivedAt: null,
      goal: input.goal.trim(),
      subscription: input.subscription,
      sourceNodeId: input.sourceNodeId ?? null,
      model: input.model,
      memoryEmbedding: null,
      agent: { state: 'notStarted', deviceId: null, reason: null, activity: null },
      createdAt: this.scheduler.now(),
    }
    this.world.projects.push(project)
    this.projectClientIds.set(clientId, { id: project.id, body: name })
    this.emit('projects')
    return project
  }

  private ensureProjectWritable(project: Project) {
    if (project.status === 'archived') throw new ClientError('invalid', '项目已归档')
  }

  updateProject(projectId: ID, patch: ProjectPatch): Project {
    const project = this.project(projectId)
    this.ensureProjectWritable(project)
    const fields = ['name', 'emoji', 'goal', 'subscription', 'model', 'memoryEmbedding', 'sourceNodeId']
    if (
      Object.entries(patch).some(
        ([key, value]) =>
          !fields.includes(key) || (key !== 'memoryEmbedding' && key !== 'sourceNodeId' && typeof value !== 'string'),
      )
    ) {
      throw new ClientError('invalid', '项目设置无效。')
    }
    const embedding = patch.memoryEmbedding
    const config = embedding
      ? {
          base_url: embedding.base_url.trim(),
          model: embedding.model.trim(),
          ...(embedding.credential_profile?.trim() ? { credential_profile: embedding.credential_profile.trim() } : {}),
        }
      : null
    if (config && (!config.base_url || !config.model)) {
      throw new ClientError('invalid', '请输入嵌入模型的基础 URL 和模型名称。')
    }
    const previous = project.memoryEmbedding
    const memoryEmbedding =
      embedding === undefined
        ? previous
        : config
          ? {
              ...config,
              config_id:
                previous &&
                previous.base_url === config.base_url &&
                previous.model === config.model &&
                previous.credential_profile === config.credential_profile
                  ? previous.config_id
                  : crypto.randomUUID(),
            }
          : null
    const next = { ...project, ...patch }
    next.name = next.name.trim()
    next.goal = next.goal.trim()
    if (!next.name) throw new ClientError('invalid', '请输入项目名称。')
    if (
      next.sourceNodeId
        ? !this.world.devices.some((device) => device.id === next.sourceNodeId) ||
          !next.subscription.startsWith('api-') ||
          !next.model.trim()
        : !Object.hasOwn(assistantModels, next.subscription) || !assistantModels[next.subscription].includes(next.model)
    ) {
      throw new ClientError('invalid', `${next.subscription} 无法使用 ${next.model}`)
    }
    if (this.world.failSettingsSaves > 0) {
      this.world.failSettingsSaves -= 1
      throw new ClientError('unavailable', 'Baton 无法保存设置，请重试。')
    }
    const passive: Pick<ProjectPatch, 'name' | 'goal'> = {}
    if (next.name !== project.name) passive.name = next.name
    if (next.goal !== project.goal) passive.goal = next.goal
    const modelChanged =
      next.subscription !== project.subscription ||
      next.sourceNodeId !== project.sourceNodeId ||
      next.model !== project.model
    Object.assign(project, {
      name: next.name,
      emoji: next.emoji,
      goal: next.goal,
      subscription: next.subscription,
      sourceNodeId: next.sourceNodeId ?? null,
      model: next.model,
      memoryEmbedding,
    })
    if (Object.keys(passive).length > 0) {
      this.queuePassive({ projectId, kind: 'settings', patch: passive, updatedAt: this.scheduler.now() })
    }
    if (modelChanged && project.agent.state === 'waitingDevice') this.wake(project)
    this.emit('projects')
    return project
  }

  setProjectStatus(projectId: ID, status: Project['status']): Project {
    const project = this.project(projectId)
    if (!['active', 'paused', 'archived'].includes(status)) throw new ClientError('invalid', '项目状态未知。')
    if (project.status === status) return project
    this.ensureProjectWritable(project)
    if (this.world.failStatusSaves > 0) {
      this.world.failStatusSaves -= 1
      throw new ClientError('unavailable', 'Baton 无法保存项目状态，请重试。')
    }
    project.status = status
    if (status !== 'active') {
      project.attention = null
      project.attentionReason = null
    }
    if (status === 'active') {
      this.wake(project)
    } else {
      const hadRun = this.cancelAssistant(project, true)
      this.assistantStops.get(projectId)?.()
      this.assistantStops.delete(projectId)
      if (hadRun) this.interrupted.add(projectId)
      // 系统阻塞保留到用户明确 Retry。
      if (project.agent.state !== 'blocked') {
        project.agent = { ...project.agent, state: 'idle', reason: null, activity: null }
      }
      if (status === 'archived') {
        project.archivedAt = this.scheduler.now()
        project.agent = { ...project.agent, state: 'stopped', reason: null, activity: null }
        this.replies.delete(projectId)
        this.interrupted.delete(projectId)
        this.world.passiveInputs = this.world.passiveInputs.filter((input) => input.projectId !== projectId)
        this.stopProjectThreads(projectId)
        project.attention = null
        project.attentionReason = null
      }
    }
    this.emit('projects', 'threads', 'messages', 'operations')
    return project
  }

  // 归档 Project 时停止仍在工作的 Thread；运行中的等设备确认，离线时停止请求等设备连上再发。
  private stopProjectThreads(projectId: ID) {
    for (const thread of this.world.threads) {
      if (thread.projectId !== projectId || thread.pending) continue
      if (thread.status !== 'running' && thread.status !== 'waiting') continue
      const operation = this.createOperation('stopThread', thread.id)
      const canceled = this.withdrawPending(thread)
      if (thread.status === 'waiting') {
        thread.status = 'idle'
        this.setPhase(operation, 'stopped')
      } else {
        thread.pending = 'stop'
        thread.stopFailed = false
        thread.stopCanceled = canceled
        this.sendStop(thread, operation)
      }
      thread.updatedAt = this.scheduler.now()
    }
  }

  saveMemory(input: SaveMemoryInput): MemorySave {
    const { projectId, noteId, body, version, clientId } = input
    this.ensureProjectWritable(this.project(projectId))
    const fingerprint = JSON.stringify([projectId, noteId, body, version])
    const existing = this.memoryClientIds.get(clientId)
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new ClientError('conflict', '此记忆请求已使用不同内容保存。')
      return structuredClone(existing.result)
    }
    if (typeof body !== 'string' || !body.trim()) throw new ClientError('invalid', '请输入记忆内容。')
    if (!clientId || (noteId === null ? version !== null : !Number.isInteger(version) || (version ?? 0) < 1)) {
      throw new ClientError('invalid', '编辑时需要记忆 ID 和当前版本。')
    }
    let note =
      noteId === null ? undefined : this.world.memory.find((item) => item.id === noteId && item.projectId === projectId)
    if (noteId !== null && !note) throw new ClientError('notFound', '此记忆已不可用。')
    if (this.world.failMemorySaves > 0) {
      this.world.failMemorySaves -= 1
      throw new ClientError('unavailable', 'Baton 无法保存记忆，请重试。')
    }
    if (note) {
      const elsewhere = this.world.memoryElsewhere[note.id]
      if (elsewhere !== undefined) {
        delete this.world.memoryElsewhere[note.id]
        this.appendMemoryVersion(note, elsewhere, 'assistant')
        this.emit('projects')
      }
      if (note.version !== version) return { state: 'conflict', note }
      this.appendMemoryVersion(note, body.trim(), 'you')
    } else {
      const first: MemoryVersion = { version: 1, body: body.trim(), source: 'you', updatedAt: this.scheduler.now() }
      note = {
        id: this.nextId('mem'),
        projectId,
        ...first,
        versions: [first],
        status: 'active',
        effective: true,
        topic: '',
        suppressionId: null,
        evidence: [],
      }
      this.world.memory.push(note)
    }
    const result: MemorySave = { state: 'saved', note }
    this.memoryClientIds.set(clientId, { fingerprint, result: structuredClone(result) })
    this.queuePassive({
      projectId,
      kind: 'memory',
      noteId: note.id,
      version: note.version,
      body: note.body,
      updatedAt: note.updatedAt,
    })
    this.emit('projects')
    return result
  }

  changeMemory(input: import('../types').ChangeMemoryInput): MemorySave {
    this.ensureProjectWritable(this.project(input.projectId))
    const note = this.world.memory.find((n) => n.projectId === input.projectId && n.id === input.noteId)
    if (!note) throw new ClientError('notFound', '找不到记忆。')
    const fingerprint = JSON.stringify(input)
    const saved = this.memoryClientIds.get(input.clientId)
    if (saved) {
      if (saved.fingerprint !== fingerprint) throw new ClientError('conflict', '请求已更改。')
      return structuredClone(saved.result)
    }
    if (note.version !== input.version) return { state: 'conflict', note }
    if (input.action === 'restore' && (!note.suppressionId || note.suppressionId !== input.suppressionId))
      throw new ClientError('conflict', '记忆已更改。')
    note.status = input.action === 'retire' ? 'retired' : 'active'
    note.effective = input.action === 'restore'
    note.suppressionId = input.action === 'retire' ? this.nextId('suppression') : null
    this.appendMemoryVersion(note, note.body, 'you')
    const result: MemorySave = { state: 'saved', note }
    this.memoryClientIds.set(input.clientId, { fingerprint, result: structuredClone(result) })
    this.emit('projects')
    return result
  }

  private appendMemoryVersion(note: MemoryNote, body: string, source: MemoryVersion['source']) {
    const latest: MemoryVersion = { version: note.version + 1, body, source, updatedAt: this.scheduler.now() }
    note.versions.push(latest)
    Object.assign(note, latest)
  }

  private queuePassive(input: PassiveInput) {
    const index = this.world.passiveInputs.findIndex(
      (pending) =>
        pending.projectId === input.projectId &&
        pending.kind === input.kind &&
        (pending.kind !== 'memory' || (input.kind === 'memory' && pending.noteId === input.noteId)),
    )
    if (index < 0) {
      this.world.passiveInputs.push(input)
      return
    }
    const previous = this.world.passiveInputs[index]
    if (previous.kind === 'settings' && input.kind === 'settings') {
      input = { ...input, patch: { ...previous.patch, ...input.patch } }
    }
    this.world.passiveInputs.splice(index, 1)
    this.world.passiveInputs.push(input)
  }

  private cancelAssistant(project: Project, restoreInputs: boolean) {
    const run = this.assistantRuns.get(project.id)
    if (!run) return false
    run.cancel()
    this.assistantRuns.delete(project.id)
    if (restoreInputs) for (const entry of run.inputs) entry.delivery = 'saved'
    this.replies.set(project.id, [...run.replies, ...(this.replies.get(project.id) ?? [])])
    const pending = this.world.passiveInputs
    this.world.passiveInputs = []
    for (const input of [...run.context.passiveInputs, ...pending]) this.queuePassive(input)
    return true
  }

  projectEntries(projectId: ID) {
    this.project(projectId)
    return this.world.projectEntries.filter((item) => item.projectId === projectId)
  }

  markProjectRead(projectId: ID, seq: number) {
    const project = this.project(projectId)
    project.readReplySeq = Math.max(project.readReplySeq, Math.min(seq, project.latestReplySeq))
    this.emit('projects')
  }

  listProjects() {
    this.failOnce('projects')
    return this.world.projects
  }

  projectMemory(projectId: ID) {
    this.project(projectId)
    this.failOnce(`memory:${projectId}`)
    return this.world.memory.filter((item) => item.projectId === projectId)
  }

  // 消息先保存，再交给助手；助手正在运行时，这条消息在这次运行结束后一起读。
  sendProjectMessage(projectId: ID, body: string, clientId: string, reference: Reference | null = null): ProjectEntry {
    const project = this.project(projectId)
    this.ensureProjectWritable(project)
    const existing = this.projectClientIds.get(clientId)
    if (existing) {
      if (existing.body !== body) throw new ClientError('conflict', '此消息已使用不同内容发送')
      const entry = this.world.projectEntries.find((item) => item.id === existing.id && item.projectId === projectId)
      if (entry) return entry
    }
    if (body.trim() === '') throw new ClientError('invalid', '消息不能为空')
    const entry: UserEntry = {
      id: this.nextId('ent'),
      projectId,
      kind: 'user',
      body: body.trim(),
      delivery: 'submitted',
      reference,
      createdAt: this.scheduler.now(),
    }
    this.world.projectEntries.push(entry)
    project.attention = null
    project.attentionReason = null
    this.projectClientIds.set(clientId, { id: entry.id, body })
    this.emit('projects')

    this.schedule(this.latency.save, () => {
      entry.delivery = 'saved'
      this.wake(project)
      this.emit('projects', 'threads', 'messages', 'operations')
    })
    return entry
  }

  // 停止只影响助手这一次运行，它开的 Thread 继续执行。
  stopProjectRun(projectId: ID): Project {
    const project = this.project(projectId)
    this.ensureProjectWritable(project)
    if (project.agent.state === 'stopping') return project
    if (project.agent.state !== 'running') throw new ClientError('invalid', '项目助手未运行')
    this.cancelAssistant(project, false)
    // 停止前发出、还没被读到的消息一起撤回；停止请求之后发的消息在停下后读取。
    for (const entry of this.unread(project)) entry.delivery = 'withdrawn'
    const device = this.world.devices.find((item) => item.id === project.agent.deviceId)
    project.agent.state = 'stopping'
    project.agent.activity = `Waiting for ${device?.name ?? 'the device'} to confirm the assistant has stopped…`
    this.emit('projects')

    const cancel = this.schedule(this.latency.device, () => {
      if (this.assistantStops.get(projectId) !== cancel || project.status !== 'active') return
      this.assistantStops.delete(projectId)
      project.agent = { state: 'stopped', deviceId: project.agent.deviceId, reason: null, activity: null }
      this.pushNote(project, 'You stopped the project assistant')
      this.wake(project)
      this.emit('projects', 'threads', 'messages', 'operations')
    })
    this.assistantStops.set(projectId, cancel)
    return project
  }

  // 设备能运行 Project 助手：在线、装了 Runtime、助手用的订阅已登录。
  private eligible(device: Device, project: Project) {
    if (project.sourceNodeId)
      return (
        device.id === project.sourceNodeId &&
        device.connection === 'online' &&
        !!device.modelConnections?.some((item) => `api-${item.id}` === project.subscription && !item.keyNeeded)
      )
    return assistantBlock(device, project.subscription) === null
  }

  // 优先默认设备，其次上次运行的设备，再其次任一符合条件的设备。默认设备不因此改变。
  private pickDevice(project: Project) {
    const ready = this.world.devices.filter((item) => this.eligible(item, project))
    for (const id of [this.world.session.defaultDeviceId, project.agent.deviceId]) {
      const device = ready.find((item) => item.id === id)
      if (device) return device
    }
    return ready[0] ?? null
  }

  private waitReason(project: Project) {
    if (project.sourceNodeId) {
      const device = this.world.devices.find((item) => item.id === project.sourceNodeId)
      const connection = device?.modelConnections?.find((item) => `api-${item.id}` === project.subscription)
      return connection ? `等待 ${device!.name} 上的 ${connection.name}` : '请选择其他模型来源'
    }
    return `等待已登录 ${project.subscription} 的在线设备`
  }

  private unread(project: Project) {
    return this.world.projectEntries.filter(
      (item): item is UserEntry =>
        item.projectId === project.id &&
        item.kind === 'user' &&
        (item.delivery === 'saved' || item.delivery === 'waitingDevice'),
    )
  }

  private pushNote(project: Project, body: string) {
    this.world.projectEntries.push({
      id: this.nextId('ent'),
      projectId: project.id,
      kind: 'note',
      body,
      createdAt: this.scheduler.now(),
    })
  }

  private pushAssistant(project: Project, process: ProcessStep[], threads: EntryThreads | null, body: string) {
    const sourceSeq = ++project.latestReplySeq
    this.world.projectEntries.push({
      id: this.nextId('ent'),
      projectId: project.id,
      kind: 'assistant',
      sourceSeq,
      process,
      threads,
      body,
      createdAt: this.scheduler.now(),
    })
  }

  // 助手没在默认设备（或上次的设备）上运行时，在主对话里说明换到了哪台、为什么。
  private switchNote(project: Project, chosen: Device, skipped?: Device) {
    if (project.sourceNodeId) return
    const previous = project.agent.deviceId
    const from =
      skipped ??
      this.world.devices.find((item) => item.id === this.world.session.defaultDeviceId) ??
      this.world.devices.find((item) => item.id === previous)
    if (!from || from.id === chosen.id || chosen.id === previous) return
    const block = assistantBlock(from, project.subscription)
    const reason = block ? blockReason(from, block, project.subscription) : `${from.name} 已断开连接`
    this.pushNote(project, `已切换到 ${chosen.name} · ${reason}`)
  }

  // 有没读的消息或 Thread 结果时开始一次运行。你停止后，Thread 结果等你下一条消息再一起读。
  private wake(project: Project) {
    if (project.status !== 'active') return
    if (project.agent.state === 'running' || project.agent.state === 'stopping' || project.agent.state === 'blocked')
      return
    const inputs = this.unread(project)
    const replies = this.replies.get(project.id) ?? []
    const resume = this.interrupted.has(project.id)
    if (!resume && inputs.length === 0 && (replies.length === 0 || project.agent.state === 'stopped')) {
      if (project.agent.state === 'waitingDevice') project.agent = { ...project.agent, state: 'idle', reason: null }
      return
    }
    const device = this.pickDevice(project)
    if (!device) {
      for (const entry of inputs) entry.delivery = 'waitingDevice'
      project.agent = {
        state: 'waitingDevice',
        deviceId: project.agent.deviceId,
        reason: this.waitReason(project),
        activity: null,
      }
      return
    }
    this.switchNote(project, device)
    for (const entry of inputs) entry.delivery = 'delivered'
    this.replies.delete(project.id)
    this.interrupted.delete(project.id)
    project.agent = { state: 'running', deviceId: device.id, reason: null, activity: this.readingText(inputs, replies) }
    this.startAssistantRun(project, inputs, replies)
  }

  private startAssistantRun(project: Project, inputs: UserEntry[], replies: Reply[]) {
    const context: AssistantContext = {
      subscription: project.subscription,
      model: project.model,
      passiveInputs: this.world.passiveInputs.filter((input) => input.projectId === project.id),
    }
    this.world.passiveInputs = this.world.passiveInputs.filter((input) => input.projectId !== project.id)
    this.world.assistantContexts[project.id] = structuredClone(context)
    const run = { inputs, replies, context, cancel: () => {} }
    run.cancel = this.schedule(this.latency.run / 2, () => {
      if (this.assistantRuns.get(project.id) !== run || project.status !== 'active') return
      this.assistantRuns.delete(project.id)
      this.respond(project, inputs, replies)
    })
    this.assistantRuns.set(project.id, run)
  }

  private readingText(inputs: UserEntry[], replies: Reply[]) {
    if (inputs.length > 0) return inputs.length === 1 ? '正在读取你的消息…' : `正在读取 ${inputs.length} 条消息…`
    if (replies.length === 0) return '正在继续处理…'
    if (replies.length > 1) return `正在读取 ${replies.length} 条回复…`
    const thread = this.world.threads.find((item) => item.id === replies[0]?.threadId)
    const device = this.world.devices.find((item) => item.id === thread?.deviceId)
    if (!thread || !device) return '正在读取回复…'
    return `正在读取 ${thread.agent ? agentNames[thread.agent] : '命令'} 的回复…`
  }

  private respond(project: Project, inputs: UserEntry[], replies: Reply[]) {
    if (replies.length > 0) this.reportReplies(project, replies)
    if (inputs.length > 0) this.answer(project, inputs)
    project.agent = { ...project.agent, state: 'idle', reason: null, activity: null }
    this.wake(project)
    this.emit('projects', 'threads', 'messages', 'operations')
  }

  // 同一次开出的几个 Thread 全部结束后合成一条汇报，其中还有在执行的就先不报。
  private reportReplies(project: Project, replies: Reply[]) {
    const entries = this.world.projectEntries.filter((item) => item.projectId === project.id)
    const reported = new Set<string>()
    for (const reply of replies) {
      const originIndex = entries.findLastIndex(
        (item) =>
          item.kind === 'assistant' &&
          item.threads?.action !== 'replies' &&
          !!item.threads?.threadIds.includes(reply.threadId),
      )
      const origin = entries[originIndex]
      const batch = origin?.kind === 'assistant' && origin.threads ? origin.threads.threadIds : [reply.threadId]
      const key = batch.join(',')
      if (reported.has(key)) continue
      const covered = entries
        .slice(originIndex + 1)
        .some(
          (item) =>
            item.kind === 'assistant' && item.threads?.action === 'replies' && item.threads.threadIds.join(',') === key,
        )
      const threads = batch.flatMap((id) => this.world.threads.filter((item) => item.id === id))
      if (covered || threads.some((item) => item.status === 'running' || item.status === 'waiting' || item.pending))
        continue
      reported.add(key)
      this.pushAssistant(project, [], { action: 'replies', threadIds: batch }, this.replyBody(threads))
    }
  }

  private replyBody(threads: Thread[]) {
    const lines = threads.map((thread) => {
      const device = this.world.devices.find((item) => item.id === thread.deviceId)?.name ?? 'a removed device'
      const last = this.world.messages.findLast((item) => item.threadId === thread.id && item.role === 'agent')
      const name = thread.agent ? agentNames[thread.agent] : 'Command'
      if (thread.status === 'stopped' || !last)
        return { device, text: `${name} on ${device} stopped before replying.`, short: 'stopped before replying.' }
      return { device, text: `${name} on ${device} replied: ${last.body}`, short: last.body }
    })
    if (lines.length === 1) return lines[0].text
    const head = lines.length === 2 ? 'Both threads finished.' : `All ${lines.length} threads finished.`
    return [head, ...lines.map((line) => `${line.device}: ${line.short}`)].join('\n')
  }

  private answer(project: Project, inputs: UserEntry[]) {
    const text = inputs.map((item) => item.body).join('\n')
    if (workPattern.test(text)) {
      this.startWork(project, text)
      return
    }
    const running = this.world.threads.filter((item) => item.projectId === project.id && item.status === 'running')
    const body =
      running.length > 0
        ? `${running.length === 1 ? 'One thread is' : `${running.length} threads are`} still running: ${sentenceList(running.map((item) => item.title))}. I'll report back when ${running.length === 1 ? 'it finishes' : 'they finish'}.`
        : 'Got it. Ask me to run tests, fix bugs, or check logs on your connected computers, and name the computer if it matters.'
    this.pushAssistant(project, [], null, body)
  }

  // 按消息里提到的设备开 Thread；没提到时用默认设备，消息要求两台时再加一台。
  private startWork(project: Project, text: string) {
    const lower = loose(text)
    const defaultId = this.world.session.defaultDeviceId
    const ordered = [...this.world.devices].sort((a, b) => Number(b.id === defaultId) - Number(a.id === defaultId))
    const named = ordered.filter((device) => {
      const name = loose(device.name)
      return lower.includes(name) || new RegExp(`\\b${name.split(' ')[0]}\\b`).test(lower)
    })
    const ready = (device: Device) =>
      device.connection === 'online' && usableAgents(device).length > 0 && device.repos.length > 0
    const count = /\b(both|two|each|all)\b/i.test(text) ? 2 : 1
    const targets = (named.length > 0 ? named : ordered).filter(ready).slice(0, named.length > 0 ? 2 : count)
    const missing = named.filter((device) => !ready(device))
    const notes = missing.map((device) =>
      device.connection === 'online'
        ? `${device.name} has no agent ready for new threads.`
        : `${device.name} is ${device.connection}.`,
    )
    if (targets.length === 0) {
      this.pushAssistant(
        project,
        [],
        null,
        [...notes, 'No connected computer can run this right now. Ask again when one is online.'].join(' '),
      )
      return
    }

    const task = this.taskText(text)
    const now = this.scheduler.now()
    const opened: Thread[] = []
    for (const device of targets) {
      const agent = usableAgents(device)[0]
      const folder = this.repoFor(device, project, text)
      const thread: Thread = {
        id: this.nextId('thr'),
        title: titleFrom(targets.length > 1 ? `${task} on ${device.name}` : task),
        deviceId: device.id,
        folder,
        agent: agent.kind,
        model: agent.defaultModel ?? agent.models[0],
        projectId: project.id,
        status: 'idle',
        stop: null,
        pending: null,
        stopCanceled: 0,
        createdAt: now,
        updatedAt: now,
        runStartedAt: null,
        unread: false,
      }
      this.world.threads.push(thread)
      const message: Message = {
        id: this.nextId('msg'),
        threadId: thread.id,
        role: 'user',
        sender: 'projectAgent',
        body: `${task} in \`${folder}\`. Report back what changed.`,
        createdAt: now,
        delivery: 'saved',
        activity: null,
        attachments: [],
      }
      this.world.messages.push(message)
      this.startRun(thread, message, null)
      opened.push(thread)
    }

    const process: ProcessStep[] = []
    const shell = [project.agent.deviceId, ...targets.map((item) => item.id)]
      .map((id) => this.world.devices.find((item) => item.id === id))
      .find((device) => device?.connection === 'online' && device.commandAccess.enabled && device.repos.length > 0)
    if (shell) {
      process.push({
        kind: 'command',
        deviceId: shell.id,
        command: `git -C ${this.repoFor(shell, project, text)} status --short --branch`,
        exitCode: 0,
        output: '## main...origin/main',
        durationMs: 300,
      })
    }
    for (const thread of opened) {
      const device = this.device(thread.deviceId)
      const body = `${folderName(thread.folder)} is in \`${thread.folder}\` on ${device.name}.`
      if (this.world.memory.some((item) => item.projectId === project.id && item.body === body)) continue
      const version: MemoryVersion = { version: 1, body, source: 'assistant', updatedAt: now }
      const note: MemoryNote = {
        id: this.nextId('mem'),
        projectId: project.id,
        ...version,
        versions: [version],
        status: 'active',
        effective: true,
        topic: '',
        suppressionId: null,
        evidence: [],
      }
      this.world.memory.push(note)
      process.push({ kind: 'note', body })
    }

    const names = opened.map((thread) => this.device(thread.deviceId).name)
    const summary =
      opened.length === 1
        ? `Opened a thread on ${names[0]}. I'll report back when ${opened[0].agent ? agentNames[opened[0].agent] : 'Command'} finishes.`
        : `Opened ${opened.length} threads on ${sentenceList(names)}. I'll report back once ${opened.length === 2 ? 'both' : 'all of them'} finish.`
    this.pushAssistant(
      project,
      process,
      { action: 'opened', threadIds: opened.map((item) => item.id) },
      [...notes, summary].join(' '),
    )
  }

  // 任务描述取消息第一行，去掉礼貌用语和「在某台设备上」。
  private taskText(text: string) {
    let line = text
      .trim()
      .split('\n')[0]
      .replace(/^(please|can you|could you)\s+/i, '')
    for (const device of this.world.devices) {
      line = line.replace(new RegExp(`\\s+(on|in)\\s+(the\\s+)?${device.name}`, 'ig'), '')
    }
    line = line.replace(/[.!?。]+$/, '')
    return `${line.charAt(0).toUpperCase()}${line.slice(1)}`
  }

  // 优先名字出现在 Project 或消息里的仓库。
  private repoFor(device: Device, project: Project, text: string) {
    const context = loose(`${project.name} ${project.goal} ${text}`)
    return device.repos.find((repo) => context.includes(loose(folderName(repo)))) ?? device.repos[0]
  }

  // 助手发起的一轮结束或被停止后，把结果交给助手；你发起的一轮不通知助手。
  private notifyProject(thread: Thread, outcome: Reply['outcome']) {
    const owner = this.turnOwners.get(thread.id)
    this.turnOwners.delete(thread.id)
    if (owner !== 'projectAgent' || !thread.projectId) return
    const project = this.world.projects.find((item) => item.id === thread.projectId)
    if (!project || project.status === 'archived') return
    this.replies.set(project.id, [...(this.replies.get(project.id) ?? []), { threadId: thread.id, outcome }])
    this.wake(project)
    this.emit('projects')
  }

  // 设备上某个目录的子目录，只在允许的目录里列出。
  listFolders(deviceId: ID, path: string | null): FolderListing {
    const device = this.device(deviceId)
    if (device.connection !== 'online') return { state: 'unavailable', deviceId, path, reason: device.connection }
    if (path === null) return { state: 'ready', deviceId, path, folders: device.folders, files: [], scanLimited: false }
    if (!device.folders.some((root) => insideFileFolder(path, root))) {
      return { state: 'unavailable', deviceId, path, reason: 'outsideFolders' }
    }
    const existing = this.world.directories[deviceId] ?? []
    if (!existing.includes(path)) return { state: 'unavailable', deviceId, path, reason: 'missing' }
    const folders = existing.filter((item) => fileParent(item) === path).sort()
    const prefix = `${deviceId}:`
    const files = Object.entries(this.world.files)
      .filter(([key]) => key.startsWith(prefix) && fileParent(key.slice(prefix.length)) === path)
      .map(([key, file]) => ({ path: key.slice(prefix.length), size: file.size }))
      .sort((a, b) => a.path.localeCompare(b.path))
    return { state: 'ready', deviceId, path, folders, files, scanLimited: false }
  }

  // 场景里标记为读取失败的内容第一次读取时失败，之后正常返回。
  private failOnce(key: string) {
    if (!this.world.failingReads.includes(key)) return
    this.world.failingReads = this.world.failingReads.filter((item) => item !== key)
    throw new ClientError('unavailable', '设备未返回此内容')
  }

  // 文件预览只读允许的目录，每片最多 previewLimit 字节，二进制文件不传内容。
  readFile(deviceId: ID, path: string, continuation?: FileReadOptions): FilePreview {
    const device = this.device(deviceId)
    const unavailable = (
      reason: Extract<FilePreview, { state: 'unavailable' }>['reason'],
      size: number | null = null,
    ): Extract<FilePreview, { state: 'unavailable' }> => ({ state: 'unavailable', deviceId, path, reason, size })
    if (device.connection !== 'online') return unavailable(device.connection)
    if (!device.folders.some((root) => insideFileFolder(path, root))) return unavailable('outsideFolders')
    this.failOnce(`file:${fileKey(deviceId, path)}`)
    const file = this.world.files[fileKey(deviceId, path)]
    if (!file) return unavailable('missing')
    if (file.text === null) return unavailable('binary', file.size)
    const bytes = new TextEncoder().encode(file.text)
    let hash = 0
    for (const byte of bytes) hash = (Math.imul(hash, 31) + byte) | 0
    const version = `${bytes.length}:${hash}`
    if (continuation && continuation.version !== version)
      throw new ClientError('conflict', '文件已更改，请重新加载后继续阅读。')
    const offset = continuation?.offset ?? 0
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > bytes.length ||
      (offset < bytes.length && (bytes[offset] & 0xc0) === 0x80)
    )
      throw new ClientError('invalid', '文件偏移量必须位于完整字符的边界。')
    let end = Math.min(offset + previewLimit, bytes.length)
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1
    const content = new TextDecoder().decode(bytes.slice(offset, end))
    const truncated = end < bytes.length
    return {
      state: 'ready',
      deviceId,
      path,
      size: file.size,
      content,
      truncated,
      offset,
      version,
      nextOffset: truncated ? end : undefined,
    }
  }

  // 中心保存的过程与设备连接和本地历史无关。
  readTrace(messageId: ID, cursor?: string): Trace {
    if (!this.world.messages.some((item) => item.id === messageId))
      throw new ClientError('notFound', `找不到消息 ${messageId}`)
    this.failOnce(`trace:${messageId}`)
    const steps = this.world.traces[messageId] ?? []
    if (steps.length === 0) return { state: 'unavailable', messageId, reason: 'missing' }
    const start = Number(cursor ?? 0)
    const end = start + 50
    return {
      state: 'ready',
      messageId,
      steps: steps.slice(start, end),
      nextCursor: end < steps.length ? String(end) : undefined,
    }
  }

  // 只有执行中的一轮有实时输出。
  readOutput(threadId: ID): LiveOutput {
    const thread = this.thread(threadId)
    const chunks = thread.status === 'running' ? (this.world.outputs[threadId] ?? []) : []
    return { threadId, chunks }
  }
}
