import type { BatonClient, ChangeEvent } from '../client'
import { ClientError } from '../client'
import type { DeviceConnection, DeviceOS, Enrollment, ID, SessionEnd } from '../types'
import type { ScenarioId } from './scenarios'
import { realScheduler, type Scheduler } from './scheduler'
import { browserLatency, MockStore, type Latency } from './store'
import type { EnrollmentRecord } from './world'

// 开发场景面板使用的控制入口，页面代码不调用。
export interface MockControls {
  readonly scenario: ScenarioId
  reset(scenario?: ScenarioId): void
  setDeviceConnection(deviceId: ID, connection: DeviceConnection): void
  endSession(reason: SessionEnd): void
  // 关闭后所有请求都按连不上 Baton 失败，用来演示网络中断。
  readonly reachable: boolean
  setReachable(reachable: boolean): void
  // 最近一个有效的设置码；没有时为 null。下面三个操作都作用于它。
  readonly pendingEnrollment: { id: ID } | null
  connectEnrollment(name: string, os: DeviceOS): void
  expireEnrollment(): void
  useEnrollmentElsewhere(): void
  completeSubscriptionLogin(deviceNameOrId: string, provider: string): void
}

// 模拟中心返回的接入地址，不是真实服务。
export const mockCoordinatorUrl = 'https://baton.example.com'

export interface MockClient extends BatonClient {
  readonly controls: MockControls
}

export function createMockClient(
  scenario: ScenarioId,
  options: { scheduler?: Scheduler; latency?: Latency } = {},
): MockClient {
  const scheduler = options.scheduler ?? realScheduler()
  const latency = options.latency ?? browserLatency
  const store = new MockStore(scenario, scheduler, latency)
  let reachable = true

  function enrollmentView(record: EnrollmentRecord): Enrollment {
    return {
      id: record.id,
      state: record.state,
      coordinatorUrl: mockCoordinatorUrl,
      expiresIn: Math.max(0, record.expiresAt - scheduler.now()),
      deviceId: record.deviceId,
    }
  }

  function closePending(state: 'expired' | 'used') {
    const record = store.pendingEnrollment()
    if (record) store.closeEnrollment(record, state)
  }

  // 每次读写先等待模拟延迟，返回的数据是副本，页面改动不会影响模拟状态。
  async function connect(ms: number) {
    await scheduler.wait(ms)
    if (!reachable) throw new ClientError('unavailable', 'Baton could not be reached')
  }

  async function read<T>(pick: () => T): Promise<T> {
    await connect(latency.read)
    return structuredClone(pick())
  }

  function signedIn() {
    if (!store.snapshot().session.account) throw new ClientError('unauthorized', 'Sign in to continue')
  }

  async function guarded<T>(pick: () => T): Promise<T> {
    await connect(latency.read)
    signedIn()
    return structuredClone(pick())
  }

  return {
    mode: 'mock',
    controls: {
      get scenario() {
        return store.scenario
      },
      reset: (next) => store.reset(next),
      setDeviceConnection: (deviceId, connection) => store.setDeviceConnection(deviceId, connection),
      endSession: (reason) => store.endSession(reason),
      get reachable() {
        return reachable
      },
      setReachable(next) {
        reachable = next
      },
      get pendingEnrollment() {
        const record = store.pendingEnrollment()
        return record && { id: record.id }
      },
      connectEnrollment: (name, os) => store.connectEnrollment(name, os),
      expireEnrollment: () => closePending('expired'),
      useEnrollmentElsewhere: () => closePending('used'),
      completeSubscriptionLogin: (device, provider) => store.completeSubscriptionLogin(device, provider),
    },

    getSession: () => read(() => store.snapshot().session),
    async signIn(username, password) {
      await connect(latency.save)
      store.signIn(username, password)
      return structuredClone(store.snapshot().session)
    },
    async signOut() {
      await connect(latency.read)
      store.signOut()
    },

    async changePassword(currentPassword, newPassword) {
      await connect(latency.save)
      signedIn()
      if (!currentPassword || newPassword.length < 12) throw new ClientError('invalid', 'Use at least 12 characters.')
      store.signOut()
      return structuredClone(store.snapshot().session)
    },

    listDevices: () => guarded(() => store.snapshot().devices),
    listProjects: () => guarded(() => store.listProjects()),
    listProjectEntries: (projectId) => guarded(() => store.projectEntries(projectId)),
    listProjectMemory: (projectId) => guarded(() => store.projectMemory(projectId)),
    listThreads: () => guarded(() => store.snapshot().threads),
    async getThread(threadId) {
      const thread = (await this.listThreads()).find((item) => item.id === threadId)
      if (!thread) throw new ClientError('notFound', 'The chat was not found.')
      return thread
    },
    listMessages: (threadId) => guarded(() => store.snapshot().messages.filter((item) => item.threadId === threadId)),
    listInbox: () => guarded(() => store.snapshot().inbox),
    readFile: (deviceId, path) => guarded(() => store.readFile(deviceId, path)),
    listFolders: (deviceId, path) => guarded(() => store.listFolders(deviceId, path)),
    readTrace: (messageId) => guarded(() => store.readTrace(messageId)),
    readHistory: (threadId, before) => guarded(() => store.readHistory(threadId, before)),
    readOutput: (threadId) => guarded(() => store.readOutput(threadId)),
    getOperation: (id) => guarded(() => store.operation(id)),

    async createThread({ clientId, ...input }) {
      await connect(latency.read)
      signedIn()
      return structuredClone(store.createThread(input, clientId))
    },
    async sendMessage({ threadId, body, clientId, mode }) {
      await connect(latency.read)
      signedIn()
      return structuredClone(store.sendMessage(threadId, body, clientId, mode))
    },
    async cancelMessage(messageId) {
      await connect(latency.save)
      signedIn()
      return structuredClone(store.cancelMessage(messageId))
    },
    async setThreadModel({ threadId, model }) {
      await connect(latency.save)
      signedIn()
      return structuredClone(store.setThreadModel(threadId, model))
    },
    async stopThread(threadId) {
      await connect(latency.read)
      signedIn()
      return structuredClone(store.stopThread(threadId))
    },
    async archiveThread(threadId) {
      await connect(latency.read)
      signedIn()
      return structuredClone(store.archiveThread(threadId))
    },
    async resumeThread(threadId) {
      await connect(latency.read)
      signedIn()
      return structuredClone(store.resumeThread(threadId))
    },
    async createProject({ clientId, ...input }) {
      await connect(latency.save)
      signedIn()
      return structuredClone(store.createProject(input, clientId))
    },
    async sendProjectMessage({ projectId, body, clientId, reference }) {
      await connect(latency.read)
      signedIn()
      return structuredClone(store.sendProjectMessage(projectId, body, clientId, reference ?? null))
    },
    async updateProject({ projectId, patch }) {
      const savedPatch = structuredClone(patch)
      await connect(latency.save)
      signedIn()
      return structuredClone(store.updateProject(projectId, savedPatch))
    },
    async setProjectStatus({ projectId, status }) {
      await connect(latency.save)
      signedIn()
      return structuredClone(store.setProjectStatus(projectId, status))
    },
    async saveMemory(input) {
      const savedInput = structuredClone(input)
      await connect(latency.save)
      signedIn()
      return structuredClone(store.saveMemory(savedInput))
    },
    async stopProjectRun(projectId) {
      await connect(latency.read)
      signedIn()
      return structuredClone(store.stopProjectRun(projectId))
    },
    async handleItem({ itemId, decision, revision }) {
      await connect(latency.save)
      signedIn()
      return structuredClone(store.handleItem(itemId, decision, revision))
    },
    async retryProject(projectId) {
      await connect(latency.save)
      signedIn()
      return structuredClone(store.retryProject(projectId))
    },

    async setDefaultDevice(deviceId) {
      await connect(latency.save)
      signedIn()
      store.setDefaultDevice(deviceId)
      return structuredClone(store.snapshot().session)
    },
    async addDeviceFolder({ deviceId, path }) {
      await connect(latency.save)
      signedIn()
      return structuredClone(store.addDeviceFolder(deviceId, path))
    },
    async removeDeviceFolder({ deviceId, path }) {
      await connect(latency.save)
      signedIn()
      return structuredClone(store.removeDeviceFolder(deviceId, path))
    },
    async startSubscriptionLogin({ deviceId, provider }) {
      await connect(latency.save)
      signedIn()
      return structuredClone(store.startSubscriptionLogin(deviceId, provider))
    },
    async setCommandAccess({ deviceId, enabled }) {
      await connect(latency.save)
      signedIn()
      return structuredClone(store.setCommandAccess(deviceId, enabled))
    },
    async removeDevice(deviceId) {
      await connect(latency.save + latency.device)
      signedIn()
      store.removeDevice(deviceId)
    },
    async createEnrollment() {
      await connect(latency.save)
      signedIn()
      const record = store.createEnrollment()
      return { ...enrollmentView(record), code: record.code }
    },
    getEnrollment: (id) => guarded(() => enrollmentView(store.enrollment(id))),

    subscribe: (listener: (event: ChangeEvent) => void) => store.subscribe(listener),
  }
}
