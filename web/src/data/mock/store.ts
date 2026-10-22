import { ClientError, type ChangeEvent, type Topic } from '../client'
import { agentNames } from '../derive'
import type {
  AgentKind,
  Device,
  DeviceAgent,
  DeviceConnection,
  DeviceOS,
  FolderListing,
  ID,
  SessionEnd,
  Message,
  Operation,
  OperationKind,
  OperationPhase,
  Project,
  SendMode,
  Thread,
} from '../types'
import { createWorld, type ScenarioId } from './scenarios'
import type { Scheduler } from './scheduler'
import type { EnrollmentRecord, World } from './world'

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

function parentFolder(path: string) {
  return path.slice(0, path.lastIndexOf(separator(path)))
}

// 新对话的标题取第一条消息的第一行。
function titleFrom(body: string) {
  const line = body.trim().split('\n')[0]
  return line.length > 60 ? `${line.slice(0, 59).trimEnd()}…` : line
}

const newDeviceDefaults: Record<DeviceOS, Pick<Device, 'system' | 'folders' | 'repos'> & { shell: string }> = {
  macOS: { system: 'macOS 15.0.1', folders: ['~/src'], repos: ['~/src/baton'], shell: 'zsh' },
  Linux: { system: 'Ubuntu 24.04', folders: ['~/work'], repos: ['~/work/baton'], shell: 'bash' },
  Windows: { system: 'Windows 11 24H2', folders: ['C:\\src'], repos: ['C:\\src\\baton'], shell: 'pwsh' },
}

// 模拟后端的状态变化规则集中在这里：设备上下线、消息投递、停止和事项处理。
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
  private sequence = 0
  readonly scheduler: Scheduler
  readonly latency: Latency

  constructor(scenarioId: ScenarioId, scheduler: Scheduler, latency: Latency) {
    this.scheduler = scheduler
    this.latency = latency
    this.scenarioId = scenarioId
    this.world = createWorld(scenarioId, scheduler.now())
    this.startExistingRuns()
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
    for (const cancel of [...this.timers]) cancel()
    this.timers.clear()
    this.runs.clear()
    this.stopTimers.clear()
    this.clientIds.clear()
    this.sequence = 0
    this.scenarioId = scenarioId
    this.world = createWorld(scenarioId, this.scheduler.now())
    this.startExistingRuns()
    this.emit('session', 'devices', 'projects', 'threads', 'messages', 'inbox', 'files', 'operations')
  }

  // ---- 查询辅助 ----

  device(id: ID): Device {
    const device = this.world.devices.find((item) => item.id === id)
    if (!device) throw new ClientError('notFound', `Device ${id} not found`)
    return device
  }

  thread(id: ID): Thread {
    const thread = this.world.threads.find((item) => item.id === id)
    if (!thread) throw new ClientError('notFound', `Thread ${id} not found`)
    return thread
  }

  operation(id: ID): Operation {
    const operation = this.world.operations.find((item) => item.id === id)
    if (!operation) throw new ClientError('notFound', `Operation ${id} not found`)
    return operation
  }

  private online(deviceId: ID) {
    return this.world.devices.find((item) => item.id === deviceId)?.connection === 'online'
  }

  // ---- 会话 ----

  signIn(username: string, password: string) {
    // 模拟登录接受任意非空用户名和密码，密码 `wrong` 用来演示登录失败。
    if (username.trim() === '' || password === '' || password === 'wrong') {
      throw new ClientError('unauthorized', 'Invalid username or password')
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
    if (existing.body !== body) throw new ClientError('conflict', 'This message was already sent with different text')
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
    }
    this.world.messages.push(message)
    return message
  }

  createThread(
    input: { deviceId: ID; folder: string; agent: AgentKind; model: string; body: string },
    clientId: string,
  ) {
    const { deviceId, folder, agent: kind, model, body } = input
    const repeated = this.repeated(clientId, body)
    if (repeated) return repeated
    const device = this.device(deviceId)
    const agent = device.agents.find((item) => item.kind === kind)
    if (body.trim() === '') throw new ClientError('invalid', 'Message is empty')
    if (!device.folders.some((root) => insideFolder(folder, root))) {
      throw new ClientError('invalid', `${folder} is outside the allowed folders on ${device.name}`)
    }
    if (!agent || agent.problem)
      throw new ClientError('invalid', `${agentNames[kind]} is not available on ${device.name}`)
    if (!agent.models.includes(model))
      throw new ClientError('invalid', `${model} is not available for ${agentNames[kind]}`)

    const now = this.scheduler.now()
    const thread: Thread = {
      id: this.nextId('thr'),
      title: titleFrom(body),
      deviceId,
      folder,
      agent: kind,
      model,
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
    if (thread.status === 'archived') throw new ClientError('invalid', "Archived chats can't receive messages")
    if (thread.pending === 'archive') throw new ClientError('invalid', 'This chat is being archived')
    if (thread.status !== 'stopped' || !thread.stop) return
    const ended =
      thread.stop.kind === 'historyLost' || thread.stop.kind === 'folderMissing' || thread.stop.kind === 'startFailed'
    if (ended || (thread.stop.kind === 'interrupted' && !this.agentOf(thread)?.abilities.resume)) {
      throw new ClientError('invalid', "This chat can't continue. Start a new chat.")
    }
  }

  sendMessage(threadId: ID, body: string, clientId: string, mode: SendMode = 'next'): Operation {
    const repeated = this.repeated(clientId, body)
    if (repeated) return repeated
    const thread = this.thread(threadId)
    this.ensureWritable(thread)
    if (body.trim() === '') throw new ClientError('invalid', 'Message is empty')
    if (mode === 'now' && !this.agentOf(thread)?.abilities.steer) {
      throw new ClientError('invalid', `${agentNames[thread.agent]} can't read messages during a reply. Send it next.`)
    }

    const message = this.userMessage(threadId, body)
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
    if (!this.world.directories[thread.deviceId]?.includes(thread.folder)) {
      // 目录在设备上不存在，Agent 不会启动，消息也没有发出。
      message.delivery = 'withdrawn'
      if (operation) this.setPhase(operation, 'failed', `Folder not found: ${thread.folder}`)
      this.withdrawPending(thread)
      thread.status = 'stopped'
      thread.stop = { kind: 'folderMissing', detail: thread.folder }
      thread.runStartedAt = null
      return
    }
    message.delivery = 'delivered'
    thread.status = 'running'
    thread.stop = null
    thread.stopCanceled = 0
    thread.runStartedAt = now
    if (operation) this.setPhase(operation, 'running', message.id)
    this.scheduleRunEnd(thread.id)
  }

  private scheduleRunEnd(threadId: ID) {
    this.runs.get(threadId)?.()
    const cancel = this.schedule(this.latency.run, () => {
      this.runs.delete(threadId)
      this.finishRun(threadId)
    })
    this.runs.set(threadId, cancel)
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
    this.world.messages.push({
      id: this.nextId('msg'),
      threadId,
      role: 'agent',
      sender: 'agent',
      body: 'Done. The change is ready for review.',
      createdAt: now,
      delivery: 'delivered',
    })
    this.endRunningSends(thread, 'done')
    thread.status = 'idle'
    thread.runStartedAt = null
    thread.updatedAt = now
    thread.unread = true
    this.startNext(thread)
    this.emit('threads', 'messages', 'operations')
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
    if (!message || message.role !== 'user') throw new ClientError('notFound', `Message ${messageId} not found`)
    if (message.delivery === 'withdrawn') return message
    if (message.delivery !== 'queued' && message.delivery !== 'waitingDevice') {
      throw new ClientError('conflict', 'This message was already sent')
    }
    const thread = this.thread(message.threadId)
    message.delivery = 'withdrawn'
    const operation = this.operationFor(message.id)
    if (operation) this.setPhase(operation, 'stopped', message.id)
    if (thread.status === 'waiting') this.startNext(thread)
    this.emit('threads', 'messages', 'operations')
    return message
  }

  setThreadModel(threadId: ID, model: string): Thread {
    const thread = this.thread(threadId)
    this.ensureWritable(thread)
    const agent = this.agentOf(thread)
    const name = agentNames[thread.agent]
    if (thread.model === model) return thread
    if (!agent?.abilities.switchModel) {
      throw new ClientError('invalid', `${name} cannot switch models in this chat. Start a new chat to choose another.`)
    }
    if (!agent.models.includes(model)) throw new ClientError('invalid', `${model} is not available for ${name}`)
    thread.model = model
    thread.updatedAt = this.scheduler.now()
    this.emit('threads')
    return thread
  }

  stopThread(threadId: ID): Operation {
    const thread = this.thread(threadId)
    if (thread.status === 'archived') throw new ClientError('invalid', 'This chat is archived')
    if (thread.status === 'running' && !this.agentOf(thread)?.abilities.stop) {
      throw new ClientError('invalid', `${agentNames[thread.agent]} does not support stopping from Baton`)
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
    if (thread.status === 'archived') throw new ClientError('invalid', 'This chat is already archived')
    if (thread.status === 'running' && !this.agentOf(thread)?.abilities.stop) {
      throw new ClientError('invalid', `Wait for ${agentNames[thread.agent]} to finish, then archive this chat`)
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
      throw new ClientError('invalid', 'This chat does not need resuming')
    }
    if (!this.agentOf(thread)?.abilities.resume) {
      throw new ClientError('invalid', `${agentNames[thread.agent]} on ${device.name} does not support resuming`)
    }
    if (!this.online(device.id)) throw new ClientError('invalid', `Reconnect ${device.name} to resume this chat`)
    const operation = this.createOperation('resumeThread', threadId)
    this.emit('operations')

    this.schedule(this.latency.save + this.latency.device, () => {
      if (this.world.lostHistory.includes(thread.id)) {
        thread.stop = { kind: 'historyLost', detail: null }
        this.setPhase(operation, 'failed', 'Chat history not found')
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

  answerItem(itemId: ID, answer: string, revision: number): Operation {
    const item = this.world.inbox.find((entry) => entry.id === itemId)
    if (!item) throw new ClientError('notFound', `Item ${itemId} not found`)
    const operation = this.createOperation('answerItem', itemId)
    this.emit('operations')

    this.schedule(this.latency.save, () => {
      const elsewhere = this.world.answeredElsewhere[itemId]
      if (elsewhere !== undefined) {
        delete this.world.answeredElsewhere[itemId]
        item.status = 'answered'
        item.answer = elsewhere
        item.revision += 1
      }
      if (item.status !== 'pending' || item.revision !== revision) {
        this.setPhase(operation, 'conflict', item.answer ? `Already answered: ${item.answer}` : 'Already handled')
      } else {
        item.status = 'answered'
        item.answer = answer
        item.revision += 1
        this.setPhase(operation, 'done')
      }
      this.emit('inbox', 'projects', 'operations')
    })
    return operation
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
      if (thread.status === 'running' && !thread.pending) this.scheduleRunEnd(thread.id)
      else if (thread.status === 'waiting' || thread.status === 'idle') this.startNext(thread)
    }
    for (const project of this.world.projects) {
      if (project.status === 'active' && project.agent.state === 'waitingDevice' && this.eligible(device, project)) {
        project.agent = { state: 'running', deviceId: device.id, reason: null }
      }
    }
  }

  // 设备离线或重新同步时，执行中的一轮继续由设备负责，网页上不把它当成已结束。
  // 已发出但没确认的停止回到等待设备，重新连上后再发一次。
  private deviceUnavailable(device: Device) {
    for (const thread of this.world.threads) {
      if (thread.deviceId === device.id && thread.status === 'running') this.cancelRun(thread.id)
    }
    for (const [id, timer] of [...this.stopTimers]) {
      if (this.thread(timer.operation.targetId).deviceId !== device.id) continue
      timer.cancel()
      this.stopTimers.delete(id)
      this.setPhase(timer.operation, 'waitingDevice')
    }
    for (const project of this.world.projects) {
      if (project.agent.deviceId !== device.id || project.agent.state !== 'running') continue
      const fallback = this.world.devices.find((item) => item.connection === 'online' && this.eligible(item, project))
      project.agent = fallback
        ? { state: 'running', deviceId: fallback.id, reason: null }
        : { state: 'waitingDevice', deviceId: null, reason: 'An online device with ChatGPT signed in' }
    }
  }

  // ---- 设备管理 ----

  setDefaultDevice(deviceId: ID) {
    this.device(deviceId)
    this.world.session.defaultDeviceId = deviceId
    this.emit('session', 'devices')
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

  createEnrollment(): EnrollmentRecord {
    this.sequence += 1
    const record: EnrollmentRecord = {
      id: `enr-${this.sequence}`,
      code: sampleCode(this.sequence),
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
    if (!record) throw new ClientError('notFound', `Setup code ${id} not found`)
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
      folders: defaults.folders,
      repos: defaults.repos,
      commandAccess: { enabled: false, user: world.session.account?.username ?? 'kaken', shell: defaults.shell },
    }
    world.devices.push(device)
    record.state = 'connected'
    record.deviceId = device.id
    if (!world.session.defaultDeviceId) world.session.defaultDeviceId = device.id
    this.emit('session', 'devices')

    this.schedule(this.latency.device, () => {
      if (!world.devices.includes(device)) return
      const abilities = { queue: true, steer: true, stop: true, resume: true, switchModel: true }
      device.agents = [
        {
          kind: 'codex',
          version: '0.98.0',
          models: ['gpt-6.1-sol', 'gpt-6.1-mini'],
          defaultModel: 'gpt-6.1-sol',
          abilities,
          account: 'ChatGPT',
          problem: null,
        },
        {
          kind: 'pi',
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

  private eligible(device: Device, _project: Project) {
    return device.hasRuntime && device.subscriptions.some((item) => item.provider === 'ChatGPT' && item.signedIn)
  }

  // 场景里已经在执行或正在停止的 Thread 接着往下走。
  private startExistingRuns() {
    for (const thread of this.world.threads) {
      if (thread.status === 'running' && !thread.pending && this.online(thread.deviceId)) this.scheduleRunEnd(thread.id)
    }
    for (const operation of this.world.operations) {
      if (operation.phase === 'stopping') this.sendStop(this.thread(operation.targetId), operation)
    }
  }

  // 设备上某个目录的子目录，只在允许的目录里列出。
  listFolders(deviceId: ID, path: string | null): FolderListing {
    const device = this.device(deviceId)
    if (device.connection !== 'online') return { state: 'unavailable', deviceId, path, reason: device.connection }
    if (path === null) return { state: 'ready', deviceId, path, folders: device.folders }
    if (!device.folders.some((root) => insideFolder(path, root))) {
      return { state: 'unavailable', deviceId, path, reason: 'outsideFolders' }
    }
    const existing = this.world.directories[deviceId] ?? []
    if (!existing.includes(path)) return { state: 'unavailable', deviceId, path, reason: 'missing' }
    const folders = existing.filter((item) => parentFolder(item) === path).sort()
    return { state: 'ready', deviceId, path, folders }
  }
}
