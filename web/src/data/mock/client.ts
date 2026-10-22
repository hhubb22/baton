import type { BatonClient, ChangeEvent } from '../client'
import { ClientError } from '../client'
import type { DeviceConnection, FilePreview, ID, SessionEnd } from '../types'
import type { ScenarioId } from './scenarios'
import { realScheduler, type Scheduler } from './scheduler'
import { browserLatency, MockStore, type Latency } from './store'
import { fileKey } from './world'

// 开发场景面板使用的控制入口，页面代码不调用。
export interface MockControls {
  readonly scenario: ScenarioId
  reset(scenario?: ScenarioId): void
  setDeviceConnection(deviceId: ID, connection: DeviceConnection): void
  endSession(reason: SessionEnd): void
  // 关闭后所有请求都按连不上 Baton 失败，用来演示网络中断。
  readonly reachable: boolean
  setReachable(reachable: boolean): void
}

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

    listDevices: () => guarded(() => store.snapshot().devices),
    listProjects: () => guarded(() => store.snapshot().projects),
    listThreads: () => guarded(() => store.snapshot().threads),
    listMessages: (threadId) => guarded(() => store.snapshot().messages.filter((item) => item.threadId === threadId)),
    listInbox: () => guarded(() => store.snapshot().inbox),
    readFile: (deviceId, path) =>
      guarded((): FilePreview => {
        const world = store.snapshot()
        const device = store.device(deviceId)
        if (device.connection === 'offline') return { state: 'unavailable', deviceId, path, reason: 'offline' }
        if (device.connection === 'syncing') return { state: 'unavailable', deviceId, path, reason: 'syncing' }
        if (!device.folders.some((folder) => path.startsWith(folder))) {
          return { state: 'unavailable', deviceId, path, reason: 'outsideFolders' }
        }
        const content = world.files[fileKey(deviceId, path)]
        if (content === undefined) return { state: 'unavailable', deviceId, path, reason: 'missing' }
        return { state: 'ready', deviceId, path, content }
      }),
    getOperation: (id) => guarded(() => store.operation(id)),

    async sendMessage({ threadId, body, clientId }) {
      await connect(latency.read)
      signedIn()
      return structuredClone(store.sendMessage(threadId, body, clientId))
    },
    async stopThread(threadId) {
      await connect(latency.read)
      signedIn()
      return structuredClone(store.stopThread(threadId))
    },
    async answerItem({ itemId, answer, revision }) {
      await connect(latency.read)
      signedIn()
      return structuredClone(store.answerItem(itemId, answer, revision))
    },

    subscribe: (listener: (event: ChangeEvent) => void) => store.subscribe(listener),
  }
}
