import type { BatonClient, ChangeEvent } from '../client'
import { ClientError } from '../client'
import type { DeviceConnection, DeviceOS, Enrollment, ID, SessionEnd } from '../types'
import type { ScenarioId } from './scenarios'
import { mockDownloads } from './downloads'
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
    if (!reachable) throw new ClientError('unavailable', '无法连接 Baton')
  }

  async function read<T>(pick: () => T): Promise<T> {
    await connect(latency.read)
    return structuredClone(pick())
  }

  function signedIn() {
    if (!store.snapshot().session.account) throw new ClientError('unauthorized', '请先登录')
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

    getDownloads: () => read(() => mockDownloads(store.scenario === 'downloads', mockCoordinatorUrl)),
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
      if (!currentPassword || newPassword.length < 12) throw new ClientError('invalid', '密码至少需要 12 个字符。')
      store.signOut()
      return structuredClone(store.snapshot().session)
    },

    listDevices: () => guarded(() => store.snapshot().devices),
    listProjects: () => guarded(() => store.listProjects()),
    markProjectRead: (projectId, seq) => guarded(() => store.markProjectRead(projectId, seq)),
    getProject: (projectId) => guarded(() => store.project(projectId)),
    listProjectEntries: (projectId) => guarded(() => store.projectEntries(projectId)),
    listProjectMemory: (projectId) => guarded(() => store.projectMemory(projectId)),
    getMemoryStatus: (projectId) =>
      guarded(() => {
        store.projectMemory(projectId)
        return { pending_batches: 0, attention: [], jobs: [], has_more: false }
      }),
    listThreads: () => guarded(() => store.snapshot().threads),
    async getThread(threadId) {
      const thread = (await this.listThreads()).find((item) => item.id === threadId)
      if (!thread) throw new ClientError('notFound', '找不到对话。')
      return thread
    },
    listMessages: (threadId) => guarded(() => store.snapshot().messages.filter((item) => item.threadId === threadId)),
    markThreadRead: (threadId) => store.markThreadRead(threadId),
    readFile: (deviceId, path, continuation) => guarded(() => store.readFile(deviceId, path, continuation)),
    listFolders: (deviceId, path) => guarded(() => store.listFolders(deviceId, path)),
    readTrace: (messageId, cursor) => guarded(() => store.readTrace(messageId, cursor)),
    readOutput: (threadId) => guarded(() => store.readOutput(threadId)),
    getOperation: (id) => guarded(() => store.operation(id)),

    async createThread({ clientId, ...input }) {
      await connect(latency.read)
      signedIn()
      return structuredClone(store.createThread(input, clientId))
    },
    async sendMessage({ threadId, body, clientId, mode, thinking }) {
      await connect(latency.read)
      signedIn()
      return structuredClone(store.sendMessage(threadId, body, clientId, mode, thinking))
    },
    async answerThreadQuestion({ threadId, answer }) {
      await connect(latency.save)
      signedIn()
      return structuredClone(store.answerThreadQuestion(threadId, answer))
    },
    async cancelMessage(messageId) {
      await connect(latency.save)
      signedIn()
      return structuredClone(store.cancelMessage(messageId))
    },
    async setThreadExecutionLimit({ threadId, executionTimeoutSeconds }) {
      await connect(latency.save)
      signedIn()
      return structuredClone(store.setThreadExecutionLimit(threadId, executionTimeoutSeconds))
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
    async changeMemory(input) {
      await connect(latency.save)
      signedIn()
      return structuredClone(store.changeMemory(input))
    },
    memorySources: () => guarded(() => []),
    async stopProjectRun(projectId) {
      await connect(latency.read)
      signedIn()
      return structuredClone(store.stopProjectRun(projectId))
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
    async updateDevice(deviceId) {
      await connect(latency.save)
      signedIn()
      if (!store.snapshot().devices.some((item) => item.id === deviceId))
        throw new ClientError('notFound', '找不到设备。')
    },
    async listDeviceFolders(deviceId) {
      await connect(latency.read)
      signedIn()
      const device = store.snapshot().devices.find((item) => item.id === deviceId)
      if (!device) throw new ClientError('notFound', '找不到设备。')
      if (device.connection !== 'online') throw new ClientError('unavailable', '设备已离线。')
      return [...device.folders]
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
    async configureModelConnection({ deviceId, action, connection }) {
      await connect(latency.save)
      signedIn()
      return structuredClone(store.configureModelConnection(deviceId, action, connection))
    },
    async logoutSubscription({ deviceId, provider }) {
      await connect(latency.save)
      signedIn()
      store.logoutSubscription(deviceId, provider)
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
    async createEnrollment(nodeId) {
      await connect(latency.save)
      signedIn()
      const record = store.createEnrollment(nodeId)
      return { ...enrollmentView(record), code: record.code }
    },
    getEnrollment: (id) => guarded(() => enrollmentView(store.enrollment(id))),

    subscribe: (listener: (event: ChangeEvent) => void) => store.subscribe(listener),
  }
}
