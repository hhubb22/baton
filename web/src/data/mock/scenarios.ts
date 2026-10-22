import type {
  Account,
  Device,
  DeviceAgent,
  InboxItem,
  MemoryNote,
  Message,
  Project,
  ProjectEntry,
  Thread,
} from '../types'
import { fileKey, type World } from './world'

export const scenarioIds = [
  'normal',
  'empty',
  'noChats',
  'offline',
  'waiting',
  'error',
  'conflict',
  'signedOut',
] as const
export type ScenarioId = (typeof scenarioIds)[number]

export const scenarioLabels: Record<ScenarioId, string> = {
  normal: 'Normal',
  empty: 'Empty',
  noChats: 'No chats',
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
  account: 'ChatGPT',
  problem: null,
}

const kiro: DeviceAgent = {
  kind: 'kiro',
  version: '1.4.2',
  models: ['claude-sonnet-5-5', 'claude-haiku-5-5'],
  defaultModel: 'claude-sonnet-5-5',
  abilities: { ...allAbilities, steer: false, resume: false },
  account: 'Kiro',
  problem: null,
}

const pi: DeviceAgent = {
  kind: 'pi',
  version: '0.31.0',
  models: ['gpt-6.1-sol'],
  defaultModel: 'gpt-6.1-sol',
  abilities: { ...allAbilities, switchModel: false },
  account: null,
  problem: null,
}

function devices(now: number): Device[] {
  return [
    {
      id: 'dev-mac',
      name: 'MacBook Pro',
      os: 'macOS',
      system: 'macOS 15.0.1',
      batondVersion: '0.9.2',
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
      system: 'Ubuntu 24.04',
      batondVersion: '0.9.2',
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
      system: 'Windows 11 24H2',
      batondVersion: '0.9.2',
      connection: 'offline',
      lastSeenAt: now - 3 * hour,
      registeredAt: now - 10 * 24 * hour,
      agents: [codex, { ...kiro, version: null, models: [], defaultModel: null, problem: 'notInstalled' }],
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
      goal: 'Keep device connections stable across network changes and restarts.',
      subscription: 'ChatGPT',
      model: 'gpt-6.1-sol',
      agent: { state: 'running', deviceId: 'dev-ubuntu', reason: null, activity: 'Planning the next step…' },
      createdAt: now - 14 * 24 * hour,
    },
    {
      id: 'prj-compat',
      name: 'Compatibility',
      hue: 'amber',
      status: 'active',
      goal: 'Run the compat suite on every supported OS before each release.',
      subscription: 'ChatGPT',
      model: 'gpt-6.1-sol',
      agent: { state: 'idle', deviceId: 'dev-mac', reason: null, activity: null },
      createdAt: now - 9 * 24 * hour,
    },
    {
      id: 'prj-docs',
      name: 'Docs Cleanup',
      hue: 'violet',
      status: 'active',
      goal: 'Remove outdated setup steps from the docs.',
      subscription: 'Claude',
      model: 'claude-sonnet-5-5',
      agent: { state: 'notStarted', deviceId: null, reason: null, activity: null },
      createdAt: now - 5 * 24 * hour,
    },
    {
      id: 'prj-switch',
      name: 'Switch Patrol',
      hue: 'green',
      status: 'paused',
      goal: 'Audit switch configs every week.',
      subscription: 'ChatGPT',
      model: 'gpt-6.1-sol',
      agent: { state: 'idle', deviceId: null, reason: null, activity: null },
      createdAt: now - 2 * 24 * hour,
    },
  ]
}

// Baton Dev 的助手开了一个 Thread 还没回复；Compatibility 的助手已经汇报过 Thread 的结果。
function projectEntries(now: number): ProjectEntry[] {
  return [
    {
      id: 'ent-baton-1',
      projectId: 'prj-baton',
      kind: 'user',
      body: 'Devices reconnect twice after a network change. Find out why on Ubuntu Dev and fix it.',
      delivery: 'delivered',
      createdAt: now - 5 * minute,
    },
    {
      id: 'ent-baton-2',
      projectId: 'prj-baton',
      kind: 'assistant',
      process: [{ kind: 'note', body: 'Gateway code is in `/home/kaken/work/baton/internal/gateway` on Ubuntu Dev.' }],
      threads: { action: 'opened', threadIds: ['thr-gateway'] },
      body: "Opened a chat on Ubuntu Dev to reproduce the race and fix it. I'll report back when Codex finishes.",
      createdAt: now - 4 * minute,
    },
    {
      id: 'ent-compat-1',
      projectId: 'prj-compat',
      kind: 'user',
      body: 'Run the compat suite on Windows Desktop and report failures.',
      delivery: 'delivered',
      createdAt: now - 3 * hour - 2 * minute,
    },
    {
      id: 'ent-compat-2',
      projectId: 'prj-compat',
      kind: 'assistant',
      process: [
        {
          kind: 'command',
          deviceId: 'dev-mac',
          command: 'git -C ~/src/compat-suite log -1 --oneline',
          exitCode: 0,
          output: '4f2c9e1 Add drive letter cases to path tests',
          durationMs: 400,
        },
        { kind: 'note', body: 'Compat suite is in `C:\\src\\compat-suite` on Windows Desktop.' },
      ],
      threads: { action: 'opened', threadIds: ['thr-compat'] },
      body: "Opened a chat on Windows Desktop. I'll report back once the suite finishes.",
      createdAt: now - 3 * hour,
    },
    {
      id: 'ent-compat-3',
      projectId: 'prj-compat',
      kind: 'assistant',
      process: [],
      threads: { action: 'replies', threadIds: ['thr-compat'] },
      body: 'The suite finished with 2 failures in `path_test.go`. Both come from Windows drive letters. I asked in your inbox whether to skip them for now, and which runner should run the nightly suite.',
      createdAt: now - 2 * hour,
    },
  ]
}

function memory(now: number): MemoryNote[] {
  return [
    {
      id: 'mem-baton-1',
      projectId: 'prj-baton',
      body: 'Gateway code is in `/home/kaken/work/baton/internal/gateway` on Ubuntu Dev.',
      updatedAt: now - 4 * minute,
    },
    {
      id: 'mem-baton-2',
      projectId: 'prj-baton',
      body: 'Run `go test ./internal/gateway/...` before reporting a fix.',
      updatedAt: now - 2 * 24 * hour,
    },
    {
      id: 'mem-compat-1',
      projectId: 'prj-compat',
      body: 'Compat suite is in `C:\\src\\compat-suite` on Windows Desktop.',
      updatedAt: now - 3 * hour,
    },
  ]
}

function thread(now: number, fields: Partial<Thread> & Pick<Thread, 'id' | 'title' | 'deviceId' | 'folder'>): Thread {
  return {
    agent: 'codex',
    model: 'gpt-6.1-sol',
    projectId: null,
    status: 'idle',
    stop: null,
    pending: null,
    stopCanceled: 0,
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
    thread(now, {
      id: 'thr-patrol',
      title: 'Organize switch patrol scripts',
      deviceId: 'dev-ubuntu',
      folder: '/home/kaken/work/switch-patrol',
      agent: 'kiro',
      model: 'claude-sonnet-5-5',
      status: 'running',
      runStartedAt: now - 18 * minute,
      updatedAt: now - 2 * minute,
    }),
    thread(now, {
      id: 'thr-unit',
      title: 'Run unit tests on Ubuntu',
      deviceId: 'dev-ubuntu',
      folder: '/home/kaken/work/baton',
      status: 'stopped',
      stop: { kind: 'byYou', detail: null },
      stopCanceled: 1,
      updatedAt: now - 25 * minute,
    }),
    thread(now, {
      id: 'thr-upgrade',
      title: 'Upgrade batond on Windows',
      deviceId: 'dev-windows',
      folder: 'C:\\src\\baton',
      status: 'unknown',
      updatedAt: now - 3 * hour - 5 * minute,
    }),
    thread(now, {
      id: 'thr-sleep',
      title: 'Run sleep tests on Windows',
      deviceId: 'dev-windows',
      folder: 'C:\\src\\baton',
      status: 'waiting',
      updatedAt: now - 8 * minute,
    }),
    thread(now, {
      id: 'thr-guide',
      title: 'Write batond setup guide',
      deviceId: 'dev-mac',
      folder: '~/src/baton',
      agent: 'pi',
      createdAt: now - 3 * 24 * hour,
      updatedAt: now - 3 * 24 * hour,
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
    {
      id: 'msg-patrol-1',
      threadId: 'thr-patrol',
      role: 'user',
      sender: 'you',
      body: 'Group the patrol scripts by switch model and add a README for each group.',
      createdAt: now - 18 * minute,
      delivery: 'delivered',
    },
    {
      id: 'msg-unit-1',
      threadId: 'thr-unit',
      role: 'user',
      sender: 'you',
      body: 'Run go test ./... and summarize the failures.',
      createdAt: now - 30 * minute,
      delivery: 'delivered',
    },
    {
      id: 'msg-unit-2',
      threadId: 'thr-unit',
      role: 'user',
      sender: 'you',
      body: 'Then rerun only the failing packages.',
      createdAt: now - 27 * minute,
      delivery: 'withdrawn',
    },
    {
      id: 'msg-upgrade-1',
      threadId: 'thr-upgrade',
      role: 'user',
      sender: 'you',
      body: 'Upgrade batond to 0.9.2 and restart the service.',
      createdAt: now - 3 * hour - 20 * minute,
      delivery: 'delivered',
    },
    {
      id: 'msg-upgrade-2',
      threadId: 'thr-upgrade',
      role: 'agent',
      sender: 'agent',
      body: 'Downloaded 0.9.2. Restarting the batond service now.',
      createdAt: now - 3 * hour - 12 * minute,
      delivery: 'delivered',
    },
    {
      id: 'msg-upgrade-3',
      threadId: 'thr-upgrade',
      role: 'user',
      sender: 'you',
      body: 'Check the service log after the restart.',
      createdAt: now - 3 * hour - 5 * minute,
      delivery: 'unknown',
    },
    {
      id: 'msg-sleep-1',
      threadId: 'thr-sleep',
      role: 'user',
      sender: 'you',
      body: 'Sleep for 3 minutes, wake up, and check that batond reconnects.',
      createdAt: now - 8 * minute,
      delivery: 'waitingDevice',
    },
    {
      id: 'msg-guide-1',
      threadId: 'thr-guide',
      role: 'user',
      sender: 'you',
      body: 'Write a setup guide for batond on macOS.',
      createdAt: now - 3 * 24 * hour - 10 * minute,
      delivery: 'delivered',
    },
    {
      id: 'msg-guide-2',
      threadId: 'thr-guide',
      role: 'agent',
      sender: 'agent',
      body: 'The guide is in `~/src/baton/docs/batond.md`.',
      createdAt: now - 3 * 24 * hour,
      delivery: 'delivered',
    },
  ]
}

// 设备上存在的目录。允许的目录之外的不列出。
function directories(): Record<string, string[]> {
  return {
    'dev-mac': ['~/src', '~/src/baton', '~/src/baton/web', '~/src/compat-suite', '~/src/elyx', '~/src/dotfiles'],
    'dev-ubuntu': [
      '/home/kaken/work',
      '/home/kaken/work/baton',
      '/home/kaken/work/switch-patrol',
      '/home/kaken/work/netops',
    ],
    'dev-windows': ['C:\\src', 'C:\\src\\baton', 'C:\\src\\compat-suite'],
  }
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
    projectEntries: projectEntries(now),
    memory: memory(now),
    threads: threads(now),
    messages: messages(now),
    inbox: inbox(now),
    operations: [],
    files: files(),
    answeredElsewhere: {},
    enrollments: [],
    directories: directories(),
    stubbornStops: [],
    lostHistory: [],
    failProjectSaves: 0,
  }
}

function findThread(world: World, id: string) {
  return world.threads.find((item) => item.id === id)!
}

// 已经提交给设备的停止请求，连同被撤回的一条排队消息。
function pendingStop(world: World, now: number, threadId: string, phase: 'stopping' | 'waitingDevice') {
  const target = findThread(world, threadId)
  target.pending = 'stop'
  target.stopCanceled = 1
  world.messages.push({
    id: `msg-${threadId}-withdrawn`,
    threadId,
    role: 'user',
    sender: 'you',
    body: 'Attach the log as well.',
    createdAt: now - minute,
    delivery: 'withdrawn',
  })
  world.operations.push({
    id: `op-${threadId}-stop`,
    kind: 'stopThread',
    targetId: threadId,
    phase,
    detail: null,
    updatedAt: now - minute,
  })
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
        projectEntries: [],
        memory: [],
        threads: [],
        messages: [],
        inbox: [],
        files: {},
      }
    case 'noChats':
      // 设备已接入，还没有任何对话。
      return { ...world, threads: [], messages: [], inbox: world.inbox.filter((item) => item.threadId === null) }
    case 'signedOut':
      return { ...world, session: { account: null, defaultDeviceId: null, ended: null } }
    case 'offline': {
      // Ubuntu Dev 掉线：上面执行中的 Thread 显示设备离线，Project Agent 没有其他满足条件的设备而等待。
      setDevice(world, 'dev-ubuntu', 'offline', now - 6 * minute)
      setDevice(world, 'dev-mac', 'offline', now - 40 * minute)
      for (const project of world.projects) {
        if (project.agent.state === 'running') {
          project.agent = {
            state: 'waitingDevice',
            deviceId: null,
            reason: 'An online device with ChatGPT signed in',
            activity: null,
          }
        }
      }
      world.projectEntries.push({
        id: 'ent-baton-3',
        projectId: 'prj-baton',
        kind: 'user',
        body: 'Also add a regression test for the double reconnect.',
        delivery: 'waitingDevice',
        createdAt: now - 2 * minute,
      })
      // 停止请求在 Ubuntu Dev 离线后提交，等它连上再发出。
      pendingStop(world, now, 'thr-patrol', 'waitingDevice')
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
      // Docs Cleanup 用 Claude，只有 Ubuntu Dev 登录过 Claude，现在登录已过期。
      const ubuntu = world.devices.find((item) => item.id === 'dev-ubuntu')!
      ubuntu.subscriptions = ubuntu.subscriptions.map((item) =>
        item.provider === 'Claude' ? { ...item, signedIn: false } : item,
      )
      const docs = world.projects.find((item) => item.id === 'prj-docs')!
      docs.agent = {
        state: 'waitingDevice',
        deviceId: null,
        reason: 'An online device with Claude signed in',
        activity: null,
      }
      world.projectEntries.push({
        id: 'ent-docs-1',
        projectId: 'prj-docs',
        kind: 'user',
        body: 'List the docs pages that still mention the old installer.',
        delivery: 'waitingDevice',
        createdAt: now - 3 * minute,
      })
      // Kiro 收到停止请求后没有停下，一分钟后设备结束它。
      pendingStop(world, now, 'thr-patrol', 'stopping')
      world.stubbornStops.push('thr-patrol')
      return world
    }
    case 'error': {
      const compat = findThread(world, 'thr-compat')
      compat.status = 'stopped'
      compat.stop = { kind: 'folderMissing', detail: compat.folder }
      world.directories['dev-windows'] = world.directories['dev-windows'].filter((item) => item !== compat.folder)
      // Ubuntu Dev 重启打断了 Kiro，Kiro 不能恢复对话。
      const patrol = findThread(world, 'thr-patrol')
      Object.assign(patrol, { status: 'stopped', runStartedAt: null, stop: { kind: 'interrupted', detail: null } })
      // Pi 支持恢复，但设备上的对话记录已经没有了，恢复时失败。
      const guide = findThread(world, 'thr-guide')
      Object.assign(guide, { status: 'stopped', stop: { kind: 'interrupted', detail: null } })
      world.lostHistory.push('thr-guide')
      const sleep = findThread(world, 'thr-sleep')
      Object.assign(sleep, {
        status: 'stopped',
        stop: { kind: 'startFailed', detail: 'Codex exited during startup: config.toml is invalid' },
      })
      world.messages.find((item) => item.id === 'msg-sleep-1')!.delivery = 'withdrawn'
      const gateway = world.threads.find((item) => item.id === 'thr-gateway')!
      gateway.status = 'unknown'
      gateway.runStartedAt = null
      const ubuntu = world.devices.find((item) => item.id === 'dev-ubuntu')!
      ubuntu.subscriptions = ubuntu.subscriptions.map((item) =>
        item.provider === 'ChatGPT' ? { ...item, signedIn: false } : item,
      )
      ubuntu.agents = ubuntu.agents.map((agent) =>
        agent.account === 'ChatGPT' ? { ...agent, problem: 'signedOut' } : agent,
      )
      const baton = world.projects.find((item) => item.id === 'prj-baton')!
      baton.agent = {
        state: 'stopped',
        deviceId: 'dev-ubuntu',
        reason: 'ChatGPT sign-in expired on Ubuntu Dev',
        activity: null,
      }
      // 第一次新建 Project 保存失败，重试成功。
      world.failProjectSaves = 1
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
