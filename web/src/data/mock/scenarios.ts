import type { Account, Device, DeviceAgent, InboxItem, Message, Project, Thread } from '../types'
import { fileKey, type World } from './world'

export const scenarioIds = ['normal', 'empty', 'offline', 'waiting', 'error', 'conflict', 'signedOut'] as const
export type ScenarioId = (typeof scenarioIds)[number]

export const scenarioLabels: Record<ScenarioId, string> = {
  normal: 'Normal',
  empty: 'Empty',
  offline: 'Offline',
  waiting: 'Waiting',
  error: 'Error',
  conflict: 'Conflict',
  signedOut: 'Signed out',
}

export function isScenarioId(value: unknown): value is ScenarioId {
  return typeof value === 'string' && (scenarioIds as readonly string[]).includes(value)
}

const minute = 60_000
const hour = 60 * minute

const account: Account = { id: 'emp-kaken', name: 'Kaken He', username: 'kaken' }

const allAbilities = { queue: true, steer: true, stop: true, resume: true, switchModel: true }

const codex: DeviceAgent = {
  kind: 'codex',
  version: '0.98.0',
  models: ['gpt-6.1-sol', 'gpt-6.1-mini'],
  defaultModel: 'gpt-6.1-sol',
  abilities: allAbilities,
  missing: null,
}

const kiro: DeviceAgent = {
  kind: 'kiro',
  version: '1.4.2',
  models: ['claude-sonnet-5-5', 'claude-haiku-5-5'],
  defaultModel: 'claude-sonnet-5-5',
  abilities: { ...allAbilities, steer: false },
  missing: null,
}

const pi: DeviceAgent = {
  kind: 'pi',
  version: '0.31.0',
  models: ['gpt-6.1-sol'],
  defaultModel: 'gpt-6.1-sol',
  abilities: { ...allAbilities, switchModel: false },
  missing: null,
}

function devices(now: number): Device[] {
  return [
    {
      id: 'dev-mac',
      name: 'MacBook Pro',
      os: 'macOS',
      connection: 'online',
      lastSeenAt: now,
      registeredAt: now - 30 * 24 * hour,
      agents: [codex, pi],
      subscriptions: [{ provider: 'ChatGPT', signedIn: true }],
      hasRuntime: true,
      folders: ['~/src'],
      repos: ['~/src/baton', '~/src/compat-suite'],
      commandAccess: { enabled: true, user: 'kaken', shell: 'zsh' },
    },
    {
      id: 'dev-ubuntu',
      name: 'Ubuntu Dev',
      os: 'Linux',
      connection: 'online',
      lastSeenAt: now,
      registeredAt: now - 20 * 24 * hour,
      agents: [codex, kiro],
      subscriptions: [
        { provider: 'ChatGPT', signedIn: true },
        { provider: 'Claude', signedIn: true },
      ],
      hasRuntime: true,
      folders: ['/home/kaken/work'],
      repos: ['/home/kaken/work/baton', '/home/kaken/work/switch-patrol'],
      commandAccess: { enabled: false, user: 'kaken', shell: 'bash' },
    },
    {
      id: 'dev-windows',
      name: 'Windows Desktop',
      os: 'Windows',
      connection: 'offline',
      lastSeenAt: now - 3 * hour,
      registeredAt: now - 10 * 24 * hour,
      agents: [codex, { ...kiro, version: null, models: [], defaultModel: null, missing: 'kiro-cli not found' }],
      subscriptions: [{ provider: 'ChatGPT', signedIn: true }],
      hasRuntime: false,
      folders: ['C:\\src'],
      repos: ['C:\\src\\compat-suite'],
      commandAccess: { enabled: false, user: 'kaken', shell: 'pwsh' },
    },
  ]
}

function projects(now: number): Project[] {
  return [
    {
      id: 'prj-baton',
      name: 'Baton Dev',
      hue: 'slate',
      status: 'active',
      agent: { state: 'running', deviceId: 'dev-ubuntu', reason: null },
      createdAt: now - 14 * 24 * hour,
    },
    {
      id: 'prj-compat',
      name: 'Compatibility',
      hue: 'amber',
      status: 'active',
      agent: { state: 'idle', deviceId: 'dev-mac', reason: null },
      createdAt: now - 9 * 24 * hour,
    },
    {
      id: 'prj-docs',
      name: 'Docs Cleanup',
      hue: 'violet',
      status: 'active',
      agent: { state: 'idle', deviceId: null, reason: null },
      createdAt: now - 5 * 24 * hour,
    },
    {
      id: 'prj-switch',
      name: 'Switch Patrol',
      hue: 'green',
      status: 'paused',
      agent: { state: 'idle', deviceId: null, reason: null },
      createdAt: now - 2 * 24 * hour,
    },
  ]
}

function thread(now: number, fields: Partial<Thread> & Pick<Thread, 'id' | 'title' | 'deviceId' | 'folder'>): Thread {
  return {
    agent: 'codex',
    model: 'gpt-6.1-sol',
    projectId: null,
    status: 'idle',
    stopReason: null,
    createdAt: now - 2 * hour,
    updatedAt: now - 20 * minute,
    runStartedAt: null,
    unread: false,
    ...fields,
  }
}

function threads(now: number): Thread[] {
  return [
    thread(now, {
      id: 'thr-gateway',
      title: 'Fix gateway reconnect race',
      deviceId: 'dev-ubuntu',
      folder: '/home/kaken/work/baton',
      projectId: 'prj-baton',
      status: 'running',
      runStartedAt: now - 4 * minute,
      updatedAt: now - minute,
    }),
    thread(now, {
      id: 'thr-webui',
      title: 'Rebuild web UI foundation',
      deviceId: 'dev-mac',
      folder: '~/src/baton',
      status: 'idle',
      unread: true,
    }),
    thread(now, {
      id: 'thr-compat',
      title: 'Run compat suite on Windows',
      deviceId: 'dev-windows',
      folder: 'C:\\src\\compat-suite',
      projectId: 'prj-compat',
      agent: 'codex',
      status: 'idle',
      updatedAt: now - 3 * hour,
    }),
    thread(now, {
      id: 'thr-switch',
      title: 'Audit switch configs',
      deviceId: 'dev-ubuntu',
      folder: '/home/kaken/work/switch-patrol',
      projectId: 'prj-switch',
      agent: 'kiro',
      model: 'claude-sonnet-5-5',
      status: 'archived',
      updatedAt: now - 30 * hour,
    }),
  ]
}

function messages(now: number): Message[] {
  return [
    {
      id: 'msg-gateway-1',
      threadId: 'thr-gateway',
      role: 'user',
      sender: 'projectAgent',
      body: 'Reproduce the reconnect race in `/home/kaken/work/baton/internal/gateway/conn.go` and fix it.',
      createdAt: now - 4 * minute,
      delivery: 'delivered',
    },
    {
      id: 'msg-webui-1',
      threadId: 'thr-webui',
      role: 'user',
      sender: 'you',
      body: 'Set up the new web UI scaffold with StyleX.',
      createdAt: now - 50 * minute,
      delivery: 'delivered',
    },
    {
      id: 'msg-webui-2',
      threadId: 'thr-webui',
      role: 'agent',
      sender: 'agent',
      body: 'Scaffold is in place. Setup notes are in `~/src/baton/README.md`.',
      createdAt: now - 20 * minute,
      delivery: 'delivered',
    },
    {
      id: 'msg-compat-1',
      threadId: 'thr-compat',
      role: 'user',
      sender: 'projectAgent',
      body: 'Run the compat suite and report failures.',
      createdAt: now - 3 * hour,
      delivery: 'delivered',
    },
    {
      id: 'msg-compat-2',
      threadId: 'thr-compat',
      role: 'agent',
      sender: 'agent',
      body: '2 failures in `path_test.go`. See the report in `C:\\src\\compat-suite\\report.md`.',
      createdAt: now - 3 * hour + 10 * minute,
      delivery: 'delivered',
    },
  ]
}

function inbox(now: number): InboxItem[] {
  return [
    {
      id: 'itm-compat-paths',
      projectId: 'prj-compat',
      threadId: 'thr-compat',
      kind: 'question',
      title: 'Skip Windows path tests for now?',
      body: '2 tests fail only on Windows because of drive letters.',
      options: ['Skip them and open a follow-up', 'Fix them before merging'],
      status: 'pending',
      answer: null,
      revision: 1,
      createdAt: now - 2 * hour,
    },
    {
      id: 'itm-compat-runner',
      projectId: 'prj-compat',
      threadId: null,
      kind: 'question',
      title: 'Which runner should run nightly?',
      body: 'MacBook Pro sleeps at night. Ubuntu Dev is always on.',
      options: ['Ubuntu Dev', 'MacBook Pro'],
      status: 'pending',
      answer: null,
      revision: 1,
      createdAt: now - 90 * minute,
    },
  ]
}

function files(): Record<string, string> {
  return {
    [fileKey('dev-mac', '~/src/baton/README.md')]: '# Baton\n\nCross-device AI agent coordination.\n',
    [fileKey('dev-ubuntu', '/home/kaken/work/baton/internal/gateway/conn.go')]:
      'package gateway\n\n// Conn 是设备的一条连接。\ntype Conn struct{}\n',
    [fileKey('dev-windows', 'C:\\src\\compat-suite\\report.md')]: '# Compat report\n\n- path_test.go: 2 failures\n',
  }
}

function base(now: number): World {
  return {
    session: { account, defaultDeviceId: 'dev-mac', ended: null },
    devices: devices(now),
    projects: projects(now),
    threads: threads(now),
    messages: messages(now),
    inbox: inbox(now),
    operations: [],
    files: files(),
    answeredElsewhere: {},
  }
}

function setDevice(world: World, id: string, connection: Device['connection'], lastSeenAt: number) {
  const device = world.devices.find((item) => item.id === id)
  if (device) Object.assign(device, { connection, lastSeenAt })
}

// 每个场景都从同一个时间点生成，同一场景重复生成得到相同的对象和 ID。
export function createWorld(id: ScenarioId, now: number): World {
  const world = base(now)
  switch (id) {
    case 'normal':
      return world
    case 'empty':
      return {
        ...world,
        session: { account, defaultDeviceId: null, ended: null },
        devices: [],
        projects: [],
        threads: [],
        messages: [],
        inbox: [],
        files: {},
      }
    case 'signedOut':
      return { ...world, session: { account: null, defaultDeviceId: null, ended: null } }
    case 'offline': {
      // Ubuntu Dev 掉线：上面执行中的 Thread 显示设备离线，Project Agent 没有其他满足条件的设备而等待。
      setDevice(world, 'dev-ubuntu', 'offline', now - 6 * minute)
      setDevice(world, 'dev-mac', 'offline', now - 40 * minute)
      for (const project of world.projects) {
        if (project.agent.state === 'running') {
          project.agent = { state: 'waitingDevice', deviceId: null, reason: 'An online device with ChatGPT signed in' }
        }
      }
      return world
    }
    case 'waiting': {
      setDevice(world, 'dev-windows', 'syncing', now)
      const compat = world.threads.find((item) => item.id === 'thr-compat')!
      compat.status = 'waiting'
      world.messages.push({
        id: 'msg-compat-3',
        threadId: 'thr-compat',
        role: 'user',
        sender: 'you',
        body: 'Rerun only the path tests.',
        createdAt: now - 5 * minute,
        delivery: 'waitingDevice',
      })
      world.messages.push({
        id: 'msg-gateway-2',
        threadId: 'thr-gateway',
        role: 'user',
        sender: 'you',
        body: 'Also add a regression test.',
        createdAt: now - minute,
        delivery: 'queued',
      })
      const docs = world.projects.find((item) => item.id === 'prj-docs')!
      docs.agent = { state: 'waitingDevice', deviceId: null, reason: 'An online device with Claude signed in' }
      return world
    }
    case 'error': {
      const compat = world.threads.find((item) => item.id === 'thr-compat')!
      compat.status = 'stopped'
      compat.stopReason = 'Folder not found: C:\\src\\compat-suite'
      const gateway = world.threads.find((item) => item.id === 'thr-gateway')!
      gateway.status = 'unknown'
      gateway.runStartedAt = null
      const ubuntu = world.devices.find((item) => item.id === 'dev-ubuntu')!
      ubuntu.subscriptions = ubuntu.subscriptions.map((item) =>
        item.provider === 'ChatGPT' ? { ...item, signedIn: false } : item,
      )
      const baton = world.projects.find((item) => item.id === 'prj-baton')!
      baton.agent = { state: 'stopped', deviceId: 'dev-ubuntu', reason: 'ChatGPT sign-in expired on Ubuntu Dev' }
      world.inbox.push({
        id: 'itm-baton-signin',
        projectId: 'prj-baton',
        threadId: null,
        kind: 'system',
        title: 'ChatGPT sign-in expired',
        body: 'Sign in to ChatGPT on Ubuntu Dev, then resume the project.',
        options: [],
        status: 'pending',
        answer: null,
        revision: 1,
        createdAt: now - 10 * minute,
      })
      return world
    }
    case 'conflict':
      // 第一个问题已经在另一个页面回答过，这里回答会得到冲突。
      world.answeredElsewhere['itm-compat-paths'] = 'Fix them before merging'
      return world
  }
}
