import { ClientError, type ChangeEvent, type Topic } from '../client'
import type { Device, DeviceConnection, ID, Message, Operation, OperationKind, OperationPhase, Project, Thread } from '../types'
import { createWorld, type ScenarioId } from './scenarios'
import type { Scheduler } from './scheduler'
import type { World } from './world'

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

// 模拟后端的状态变化规则集中在这里：设备上下线、消息投递、停止和事项处理。
// 页面和 MockClient 都不直接改 World。
export class MockStore {
  private world: World
  private scenarioId: ScenarioId
  private listeners = new Set<(event: ChangeEvent) => void>()
  private timers = new Set<() => void>()
  private runs = new Map<ID, () => void>()
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
      throw new ClientError('unauthorized', 'Username or password is incorrect')
    }
    this.world.session.account = { id: 'emp-kaken', name: 'Kaken He', username: username.trim() }
    if (!this.world.session.defaultDeviceId && this.world.devices.length > 0) {
      this.world.session.defaultDeviceId = [...this.world.devices].sort((a, b) => a.registeredAt - b.registeredAt)[0].id
    }
    this.emit('session')
  }

  signOut() {
    this.world.session.account = null
    this.emit('session')
  }

  // ---- 操作 ----

  private createOperation(kind: OperationKind, targetId: ID): Operation {
    const operation: Operation = {
      id: this.nextId('op'),
      kind,
      targetId,
      phase: 'submitted',
      detail: null,
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

  sendMessage(threadId: ID, body: string, clientId: string): Operation {
    const existing = this.clientIds.get(clientId)
    if (existing) {
      if (existing.body !== body) throw new ClientError('conflict', 'This message was already sent with different text')
      return this.operation(existing.opId)
    }
    const thread = this.thread(threadId)
    if (thread.status === 'archived') throw new ClientError('invalid', "Archived threads can't receive messages")
    if (body.trim() === '') throw new ClientError('invalid', 'Message is empty')

    const operation = this.createOperation('sendMessage', threadId)
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
    this.clientIds.set(clientId, { opId: operation.id, body })
    operation.detail = message.id
    this.emit('messages', 'operations')

    this.schedule(this.latency.save, () => {
      message.delivery = 'saved'
      this.setPhase(operation, 'saved', message.id)
      thread.updatedAt = this.scheduler.now()
      this.route(thread, message, operation)
      this.emit('threads', 'messages', 'operations')
    })
    return operation
  }

  // 已保存的消息：设备离线时等待设备，执行中时排到下一轮，否则开始新的一轮。
  private route(thread: Thread, message: Message, operation: Operation) {
    if (!this.online(thread.deviceId)) {
      message.delivery = 'waitingDevice'
      this.setPhase(operation, 'waitingDevice', message.id)
      if (thread.status !== 'running') thread.status = 'waiting'
      return
    }
    if (thread.status === 'running' || thread.status === 'waiting') {
      message.delivery = 'queued'
      this.setPhase(operation, 'queued', message.id)
      return
    }
    this.startRun(thread, message, operation)
  }

  private startRun(thread: Thread, message: Message, operation: Operation | null) {
    message.delivery = 'delivered'
    thread.status = 'running'
    thread.stopReason = null
    thread.runStartedAt = this.scheduler.now()
    thread.updatedAt = this.scheduler.now()
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
    return this.world.operations.find((item) => item.kind === 'sendMessage' && item.detail === messageId)
  }

  private finishRun(threadId: ID) {
    const thread = this.thread(threadId)
    if (thread.status !== 'running') return
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
    for (const operation of this.world.operations) {
      if (operation.kind === 'sendMessage' && operation.targetId === threadId && operation.phase === 'running') {
        this.setPhase(operation, 'done', operation.detail)
      }
    }
    thread.status = 'idle'
    thread.runStartedAt = null
    thread.updatedAt = now
    thread.unread = true
    this.startNext(thread)
    this.emit('threads', 'messages', 'operations')
  }

  // 一轮结束或设备上线后，发出最早一条排队或等待设备的消息。
  private startNext(thread: Thread) {
    const next = this.world.messages.find(
      (item) =>
        item.threadId === thread.id && item.role === 'user' && (item.delivery === 'queued' || item.delivery === 'waitingDevice'),
    )
    if (!next) {
      if (thread.status === 'waiting') thread.status = 'idle'
      return
    }
    this.startRun(thread, next, this.operationFor(next.id) ?? null)
  }

  stopThread(threadId: ID): Operation {
    const thread = this.thread(threadId)
    const operation = this.createOperation('stopThread', threadId)
    this.emit('operations')

    this.schedule(this.latency.save, () => {
      // 排队中尚未发出的消息一起撤回。
      for (const message of this.world.messages) {
        if (message.threadId !== threadId || message.role !== 'user') continue
        if (message.delivery === 'queued' || message.delivery === 'waitingDevice') {
          message.delivery = 'withdrawn'
          const pending = this.operationFor(message.id)
          if (pending) this.setPhase(pending, 'stopped', message.id)
        }
      }
      if (thread.status !== 'running') {
        if (thread.status === 'waiting') thread.status = 'idle'
        this.setPhase(operation, 'stopped')
      } else if (this.online(thread.deviceId)) {
        this.setPhase(operation, 'stopping')
        this.schedule(this.latency.device, () => this.confirmStop(thread, operation))
      } else {
        this.setPhase(operation, 'waitingDevice')
      }
      this.emit('threads', 'messages', 'operations')
    })
    return operation
  }

  // 只有设备确认停止后，Thread 才变为空闲。
  private confirmStop(thread: Thread, operation: Operation) {
    this.cancelRun(thread.id)
    for (const item of this.world.operations) {
      if (item.kind === 'sendMessage' && item.targetId === thread.id && item.phase === 'running') {
        this.setPhase(item, 'stopped', item.detail)
      }
    }
    thread.status = 'idle'
    thread.runStartedAt = null
    thread.updatedAt = this.scheduler.now()
    this.setPhase(operation, 'stopped')
    this.emit('threads', 'operations')
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
      if (operation.kind !== 'stopThread' || operation.phase !== 'waitingDevice') continue
      const thread = this.thread(operation.targetId)
      if (thread.deviceId === device.id) this.confirmStop(thread, operation)
    }
    for (const thread of this.world.threads) {
      if (thread.deviceId !== device.id) continue
      if (thread.status === 'running') this.scheduleRunEnd(thread.id)
      else if (thread.status === 'waiting' || thread.status === 'idle') this.startNext(thread)
    }
    for (const project of this.world.projects) {
      if (project.status === 'active' && project.agent.state === 'waitingDevice' && this.eligible(device, project)) {
        project.agent = { state: 'running', deviceId: device.id, reason: null }
      }
    }
  }

  // 设备离线或重新同步时，执行中的一轮继续由设备负责，网页上暂停计时，不把它当成已结束。
  private deviceUnavailable(device: Device) {
    for (const thread of this.world.threads) {
      if (thread.deviceId === device.id && thread.status === 'running') this.cancelRun(thread.id)
    }
    for (const project of this.world.projects) {
      if (project.agent.deviceId !== device.id || project.agent.state !== 'running') continue
      const fallback = this.world.devices.find((item) => item.connection === 'online' && this.eligible(item, project))
      project.agent = fallback
        ? { state: 'running', deviceId: fallback.id, reason: null }
        : { state: 'waitingDevice', deviceId: null, reason: 'An online device with ChatGPT signed in' }
    }
  }

  private eligible(device: Device, _project: Project) {
    return device.hasRuntime && device.subscriptions.some((item) => item.provider === 'ChatGPT' && item.signedIn)
  }

  private startExistingRuns() {
    for (const thread of this.world.threads) {
      if (thread.status === 'running' && this.online(thread.deviceId)) this.scheduleRunEnd(thread.id)
    }
  }
}
