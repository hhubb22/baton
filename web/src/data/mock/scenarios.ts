import type {
  Account,
  Device,
  DeviceAgent,
  InboxItem,
  MemoryNote,
  Message,
  OutputChunk,
  Project,
  ProjectEntry,
  Thread,
  TraceStep,
} from '../types'
import { fileKey, type DeviceFile, type World } from './world'

export const scenarioIds = [
  'normal',
  'streamingMarkdown',
  'streamingProject',
  'downloads',
  'noDownloads',
  'empty',
  'noChats',
  'offline',
  'waiting',
  'error',
  'conflict',
  'signedOut',
  'inbox',
  'inboxPaused',
  'inboxWithdrawn',
  'maintenance',
  'maintenanceError',
  'memoryConflict',
  'archived',
  'modelSources',
] as const
export type ScenarioId = (typeof scenarioIds)[number]

export const scenarioLabels: Record<ScenarioId, string> = {
  normal: 'Normal',
  streamingMarkdown: 'Streaming Markdown',
  streamingProject: 'Streaming project activity',
  downloads: 'Device downloads',
  noDownloads: 'No device downloads',
  empty: 'Empty',
  noChats: 'No threads',
  offline: 'Offline',
  waiting: 'Waiting',
  error: 'Error',
  conflict: 'Conflict',
  signedOut: 'Signed out',
  inbox: 'Questions and history',
  inboxPaused: 'Questions · paused project',
  inboxWithdrawn: 'Question withdrawn while replying',
  maintenance: 'Project maintenance',
  maintenanceError: 'Maintenance · save and read errors',
  memoryConflict: 'Memory · newer assistant version',
  archived: 'Archived project',
  modelSources: 'Model sources',
}

export function isScenarioId(value: unknown): value is ScenarioId {
  return typeof value === 'string' && (scenarioIds as readonly string[]).includes(value)
}

const minute = 60_000
const hour = 60 * minute
const kb = 1024
const mb = 1024 * kb

const ubuntuRepo = '/home/kaken/work/baton'

const account: Account = { id: 'emp-kaken', name: 'Kaken He', username: 'kaken' }

const allAbilities = { create: true, queue: true, steer: true, stop: true, resume: true, switchModel: true }

const codex: DeviceAgent = {
  kind: 'codex',
  status: 'available',
  reason: null,
  version: '0.98.0',
  models: ['gpt-6.1-sol', 'gpt-6.1-mini'],
  defaultModel: 'gpt-6.1-sol',
  abilities: allAbilities,
  account: 'ChatGPT',
  problem: null,
}

const kiro: DeviceAgent = {
  kind: 'kiro',
  status: 'available',
  reason: null,
  version: '1.4.2',
  models: ['claude-sonnet-5-5', 'claude-haiku-5-5'],
  defaultModel: 'claude-sonnet-5-5',
  abilities: { ...allAbilities, steer: false, resume: false },
  account: 'Kiro',
  problem: null,
}

const pi: DeviceAgent = {
  kind: 'pi',
  status: 'available',
  reason: null,
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
        { provider: 'ChatGPT', providerId: 'openai-codex', loginMethods: ['oauth', 'device_code'], signedIn: true },
        { provider: 'Claude', providerId: 'anthropic', loginMethods: ['oauth', 'api_key'], signedIn: true },
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
      archivedAt: null,
      name: 'Baton Dev',
      hue: 'slate',
      status: 'active',
      goal: 'Keep device connections stable across network changes and restarts.',
      subscription: 'ChatGPT',
      model: 'gpt-6.1-sol',
      memoryEmbedding: null,
      agent: { state: 'running', deviceId: 'dev-ubuntu', reason: null, activity: 'Planning the next step…' },
      createdAt: now - 14 * 24 * hour,
    },
    {
      id: 'prj-compat',
      archivedAt: null,
      name: 'Compatibility',
      hue: 'amber',
      status: 'active',
      goal: 'Run the compat suite on every supported OS before each release.',
      subscription: 'ChatGPT',
      model: 'gpt-6.1-sol',
      memoryEmbedding: null,
      agent: { state: 'idle', deviceId: 'dev-mac', reason: null, activity: null },
      createdAt: now - 9 * 24 * hour,
    },
    {
      id: 'prj-docs',
      archivedAt: null,
      name: 'Docs Cleanup',
      hue: 'violet',
      status: 'active',
      goal: 'Remove outdated setup steps from the docs.',
      subscription: 'Claude',
      model: 'claude-sonnet-5-5',
      memoryEmbedding: null,
      agent: { state: 'notStarted', deviceId: null, reason: null, activity: null },
      createdAt: now - 5 * 24 * hour,
    },
    {
      id: 'prj-switch',
      archivedAt: null,
      name: 'Switch Patrol',
      hue: 'green',
      status: 'paused',
      goal: 'Audit switch configs every week.',
      subscription: 'ChatGPT',
      model: 'gpt-6.1-sol',
      memoryEmbedding: null,
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
      reference: null,
      body: 'Devices reconnect twice after a network change. Find out why on Ubuntu Dev and fix it.',
      delivery: 'delivered',
      createdAt: now - 5 * minute,
    },
    {
      id: 'ent-baton-2',
      projectId: 'prj-baton',
      kind: 'assistant',
      process: [{ kind: 'note', body: 'Gateway code is in `/home/kaken/work/baton/apps/server/src` on Ubuntu Dev.' }],
      threads: { action: 'opened', threadIds: ['thr-gateway'] },
      body: "Opened a thread on Ubuntu Dev to reproduce the race and fix it. I'll report back when Codex finishes.",
      createdAt: now - 4 * minute,
    },
    {
      id: 'ent-compat-1',
      projectId: 'prj-compat',
      kind: 'user',
      reference: null,
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
      body: "Opened a thread on Windows Desktop. I'll report back once the suite finishes.",
      createdAt: now - 3 * hour,
    },
    {
      id: 'ent-compat-3',
      projectId: 'prj-compat',
      kind: 'assistant',
      process: [],
      threads: { action: 'replies', threadIds: ['thr-compat'] },
      body: 'The suite finished with 2 failures in `path.test.ts`. Both come from Windows drive letters. I asked in your inbox whether to skip them for now, and which runner should run the nightly suite.',
      createdAt: now - 2 * hour,
    },
  ]
}

function memory(now: number): MemoryNote[] {
  const notes: Pick<MemoryNote, 'id' | 'projectId' | 'body' | 'updatedAt'>[] = [
    {
      id: 'mem-baton-1',
      projectId: 'prj-baton',
      body: 'Gateway code is in `/home/kaken/work/baton/apps/server/src` on Ubuntu Dev.',
      updatedAt: now - 4 * minute,
    },
    {
      id: 'mem-baton-2',
      projectId: 'prj-baton',
      body: 'Run `pnpm --filter @baton/server test:unit src/gateway.test.ts` before reporting a fix.',
      updatedAt: now - 2 * 24 * hour,
    },
    {
      id: 'mem-compat-1',
      projectId: 'prj-compat',
      body: 'Compat suite is in `C:\\src\\compat-suite` on Windows Desktop.',
      updatedAt: now - 3 * hour,
    },
  ]
  return notes.map((note) => {
    const first = { version: 1, source: 'assistant' as const, body: note.body, updatedAt: note.updatedAt }
    return {
      ...note,
      ...first,
      versions: [first],
      status: 'active',
      effective: true,
      topic: '',
      suppressionId: null,
      evidence: [],
    }
  })
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
      createdAt: now - 12 * minute,
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

type MessageSeed = Omit<Message, 'activity' | 'attachments'> & Partial<Pick<Message, 'activity' | 'attachments'>>

function message(seed: MessageSeed): Message {
  return { activity: null, attachments: [], ...seed }
}

function messages(now: number): Message[] {
  const seeds: MessageSeed[] = [
    {
      id: 'msg-gateway-0',
      threadId: 'thr-gateway',
      role: 'user',
      sender: 'projectAgent',
      body: 'Run `pnpm --filter @baton/server test:unit src/gateway.test.ts` and attach the log.',
      createdAt: now - 12 * minute,
      delivery: 'delivered',
    },
    {
      id: 'msg-gateway-r1',
      threadId: 'thr-gateway',
      role: 'agent',
      sender: 'agent',
      body: '47 of 48 tests passed. `reconnects after sleep` did not reconnect within 30s after waking from sleep; log attached.',
      createdAt: now - 6 * minute,
      delivery: 'delivered',
      activity: { commands: 1, tools: 0, files: 1 },
      attachments: [
        { kind: 'file', deviceId: 'dev-ubuntu', path: `${ubuntuRepo}/logs/reconnect.log`, size: 48 * kb },
        { kind: 'file', deviceId: 'dev-windows', path: 'C:\\src\\baton\\logs\\windows-reconnect.log', size: 52 * kb },
        {
          kind: 'commit',
          repo: 'github.com/hhubb22/baton',
          sha: '9b1e4d7a2c5f8e0b3d6a9c2f5e8b1d4a7c0e3f62',
          subject: 'test(gateway): cover reconnect after sleep',
        },
      ],
    },
    {
      id: 'msg-gateway-1',
      threadId: 'thr-gateway',
      role: 'user',
      sender: 'projectAgent',
      body: 'Reproduce the reconnect race in `/home/kaken/work/baton/apps/server/src/gateway.ts` and fix it.',
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
      body: `## Web UI scaffold is ready

Scaffold is in place. The workspace uses **React, TypeScript and StyleX**. Setup notes are in \`~/src/baton/README.md\`.

### What changed

- Added a shared page layout and navigation.
- Defined light and dark theme tokens.
- Added a mock client for local development.

### Checks

| Check | Result | Details |
| --- | --- | --- |
| TypeScript | Passed | No type errors |
| Tests | Passed | 24 tests |
| Build | Passed | Output in \`dist/\` |

Start the mock interface locally:

\`\`\`sh
pnpm --dir web dev
\`\`\`

Open the app with \`?mock=1\`. See the [React documentation](https://react.dev/) for framework details.

> The mock data resets when the page reloads.`,
      createdAt: now - 20 * minute,
      delivery: 'delivered',
      activity: { commands: 2, tools: 1, files: 2 },
      attachments: [
        { kind: 'file', deviceId: 'dev-mac', path: '~/src/baton/README.md', size: 1229 },
        {
          kind: 'commit',
          repo: 'github.com/hhubb22/baton',
          sha: '3f9c2a7e4b1d8c6f0a5e2d9b7c4a1f3e8d6b2c90',
          subject: 'feat(web): scaffold StyleX workspace',
        },
      ],
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
      body: '2 failures in `path.test.ts`. See the report in `C:\\src\\compat-suite\\report.md`.',
      createdAt: now - 3 * hour + 10 * minute,
      delivery: 'delivered',
      activity: { commands: 1, tools: 0, files: 1 },
      attachments: [
        { kind: 'file', deviceId: 'dev-windows', path: 'C:\\src\\compat-suite\\report.md', size: 3482 },
        {
          kind: 'commit',
          repo: 'github.com/hhubb22/compat-suite',
          sha: '4f2c9e1a7d3b5c8e0f6a2d4b9c1e7f3a5d8b0c26',
          subject: 'test: add drive letter cases to path tests',
        },
      ],
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
      body: 'Run pnpm test and summarize the failures.',
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
      activity: { commands: 2, tools: 0, files: 0 },
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
      activity: { commands: 0, tools: 1, files: 1 },
      attachments: [{ kind: 'file', deviceId: 'dev-mac', path: '~/src/baton/docs/batond.md', size: 2150 }],
    },
  ]
  return seeds.map(message)
}

// 设备上存在的目录。允许的目录之外的不列出。
function directories(): Record<string, string[]> {
  return {
    'dev-mac': [
      '~/src',
      '~/src/baton',
      '~/src/baton/docs',
      '~/src/baton/web',
      '~/src/compat-suite',
      '~/src/elyx',
      '~/src/dotfiles',
    ],
    'dev-ubuntu': [
      '/home/kaken/work',
      '/home/kaken/work/baton',
      '/home/kaken/work/baton/apps',
      '/home/kaken/work/baton/apps/server',
      '/home/kaken/work/baton/apps/server/src',
      '/home/kaken/work/baton/apps/server/src/testing',
      '/home/kaken/work/baton/apps/server/src/testing/data',
      '/home/kaken/work/baton/logs',
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
      recommended: 1,
      allowText: true,
      status: 'pending',
      result: null,
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
      recommended: 0,
      allowText: false,
      status: 'pending',
      result: null,
      revision: 1,
      createdAt: now - 90 * minute,
    },
  ]
}

const gatewayTs = `import type { RawData } from 'ws'

export const webSocketText = (data: RawData): string =>
  (Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)).toString('utf8')
`

const readme = `# Baton

Cross-device AI agent coordination.

## Development

Install dependencies and start the web UI:

    pnpm --dir web install
    pnpm --dir web dev

The mock backend runs in the browser. Pick a scenario with ?scenario=offline.
`

const reconnectLog = Array.from({ length: 48 }, (_, index) => {
  const seconds = String(index).padStart(2, '0')
  if (index === 41) return `14:31:${seconds} FAIL reconnects after sleep (30.02s): no reconnect after resume`
  return `14:31:${seconds} ok   reconnect/case-${index + 1} (${(index * 0.07).toFixed(2)}s)`
}).join('\n')

// 超过单片读取上限的完整日志。
const soakLog = Array.from(
  { length: 1600 },
  (_, index) =>
    `soak ${String(index + 1).padStart(5, '0')} reconnect ok rtt=${12 + (index % 9)}ms frames=${index * 3} 状态=在线`,
).join('\n')

function file(text: string | null, size = text === null ? 0 : new TextEncoder().encode(text).length): DeviceFile {
  return { size, text }
}

function files(): Record<string, DeviceFile> {
  return {
    [fileKey('dev-mac', '~/src/baton/README.md')]: file(readme),
    [fileKey('dev-mac', '~/src/baton/docs/batond.md')]: file(
      '# batond on macOS\n\n1. Install with Homebrew.\n2. Run `batond enroll` and enter the code from the web page.\n3. Run `brew services start batond`.\n',
    ),
    [fileKey('dev-ubuntu', `${ubuntuRepo}/apps/server/src/gateway.ts`)]: file(gatewayTs),
    [fileKey('dev-ubuntu', `${ubuntuRepo}/apps/server/src/gateway.test.ts`)]: file(
      "import { expect, test } from 'vite-plus/test'\nimport { webSocketText } from './gateway.ts'\n\ntest('decodes WebSocket data', () => {\n  expect(webSocketText(Buffer.from('你好🙂'))).toBe('你好🙂')\n})\n",
    ),
    [fileKey('dev-ubuntu', `${ubuntuRepo}/apps/server/src/nodes.ts`)]: file(
      'export interface NodeSource {\n  employee_id: string\n  node_id: string\n  conn_id: string\n}\n',
    ),
    [fileKey('dev-ubuntu', `${ubuntuRepo}/apps/server/src/server.ts`)]: file(
      "import { createServer } from 'node:http'\n\nexport const server = createServer()\n",
    ),
    [fileKey('dev-ubuntu', `${ubuntuRepo}/apps/server/src/testing/data/capture.bin`)]: file(null, 2.4 * mb),
    [fileKey('dev-ubuntu', `${ubuntuRepo}/logs/reconnect.log`)]: file(reconnectLog, 48 * kb),
    [fileKey('dev-ubuntu', `${ubuntuRepo}/logs/gateway-soak.log`)]: file(soakLog),
    [fileKey('dev-windows', 'C:\\src\\compat-suite\\report.md')]: file(
      '# Compat report\n\n- path.test.ts: 2 failures\n  - join drive letters: got C:foo, want C:\\foo\n  - relative paths across drives: different volumes\n',
    ),
    [fileKey('dev-windows', 'C:\\src\\baton\\logs\\windows-reconnect.log')]: file('14:30:02 ok reconnect\n', 52 * kb),
  }
}

// 设备上保存的回复过程，只在展开时按需读取。
function traces(): Record<string, TraceStep[]> {
  const command = (input: string, output: string) => ({ type: 'command_execution', data: { input, output } })
  const file = (fileName: string, diffStr?: string) => ({
    type: 'file_change',
    data: { fileName, ...(diffStr === undefined ? {} : { diffStr }) },
  })
  const tool = (toolName: string, input: string) => ({ type: 'dynamic_tool', data: { toolName, input } })
  const records = {
    'msg-gateway-r1': [
      command(
        'pnpm --filter @baton/server test:unit src/gateway.test.ts',
        'FAIL src/gateway.test.ts > reconnects after sleep (30020ms)\nError: no reconnect after resume\n    at src/gateway.test.ts:41\nTests  1 failed | 47 passed (48)',
      ),
      file(ubuntuRepo + '/logs/reconnect.log'),
    ],
    'msg-webui-2': [
      command('pnpm create vite web --template react-ts', 'Scaffolding project in ~/src/baton/web...\nDone.'),
      tool('Read', '~/src/baton/specs/web-ui/PLAN.md'),
      file(
        '~/src/baton/web/vite.config.ts',
        "@@ -1,5 +1,9 @@\n import { defineConfig } from 'vite'\n \n export default defineConfig({\n-  plugins: [],\n+  plugins: [react()],\n+  server: {\n+    host: 'localhost',\n+    port: 5173,\n+  },\n })\n",
      ),
      command(
        'pnpm --dir web build',
        'vite v7.1.4 building for production...\n✓ 42 modules transformed.\n✓ built in 1.84s',
      ),
      file('~/src/baton/README.md'),
    ],
    'msg-compat-2': [
      command(
        'pnpm test',
        'FAIL src/path.test.ts > join drive letters\nFAIL src/path.test.ts > relative paths across drives\nTests  2 failed',
      ),
      file('C:\\src\\compat-suite\\report.md'),
    ],
    'msg-upgrade-2': [
      command('batond upgrade --version 0.9.2', 'Downloaded batond 0.9.2 (18.4 MB)'),
      command('Restart-Service batond', ''),
    ],
    'msg-guide-2': [tool('Search', 'batond enroll'), file('~/src/baton/docs/batond.md')],
  }
  return Object.fromEntries(
    Object.entries(records).map(([messageId, steps]) => [
      messageId,
      steps.map((step, ordinal) => ({
        ...step,
        item_id: messageId + ':' + ordinal,
        ordinal,
        status: 'completed',
        truncated: false,
        original_bytes: new TextEncoder().encode(JSON.stringify(step.data)).length,
      })),
    ]),
  )
}

// 执行中 Thread 已经收到的实时输出。
function outputs(): Record<string, OutputChunk[]> {
  return {
    'thr-gateway': [
      {
        kind: 'text',
        text: '$ pnpm --filter @baton/server test:unit src/gateway.test.ts\nRUN src/gateway.test.ts > reconnects after sleep\n    src/gateway.test.ts:41: waiting for resume\n',
      },
    ],
    'thr-patrol': [{ kind: 'text', text: '$ ls scripts/\npatrol.sh  backup.sh  collect.py\n' }],
  }
}

function base(now: number): World {
  return {
    session: { account, defaultDeviceId: 'dev-mac', ended: null },
    devices: devices(now),
    projects: projects(now),
    projectEntries: projectEntries(now),
    memory: memory(now),
    passiveInputs: [],
    assistantContexts: {},
    threads: threads(now),
    messages: messages(now),
    inbox: inbox(now),
    operations: [],
    files: files(),
    traces: traces(),
    outputs: outputs(),
    outputLoss: [],
    failingReads: [],
    answeredElsewhere: {},
    withdrawnElsewhere: {},
    failItemSaves: 0,
    enrollments: [],
    directories: directories(),
    stubbornStops: [],
    lostHistory: [],
    failProjectSaves: 0,
    failSettingsSaves: 0,
    failMemorySaves: 0,
    failStatusSaves: 0,
    memoryElsewhere: {},
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
  world.messages.push(
    message({
      id: `msg-${threadId}-withdrawn`,
      threadId,
      role: 'user',
      sender: 'you',
      body: 'Attach the log as well.',
      createdAt: now - minute,
      delivery: 'withdrawn',
    }),
  )
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
    case 'modelSources': {
      const device = world.devices.find((item) => item.id === 'dev-ubuntu')!
      device.modelConnections = [
        {
          id: '11111111-1111-4111-8111-111111111111',
          name: 'Local gateway',
          protocol: 'openai-completions',
          base_url: 'http://localhost:8080/v1',
          models: ['local-model'],
          keyNeeded: true,
        },
        {
          id: '22222222-2222-4222-8222-222222222222',
          name: 'Team API',
          protocol: 'anthropic-messages',
          base_url: 'https://api.anthropic.com',
          models: ['claude-model'],
          keyNeeded: false,
        },
      ]
      return world
    }
    case 'streamingMarkdown': {
      const target = findThread(world, 'thr-webui')
      target.title = 'Streaming Markdown demo'
      world.messages = world.messages.filter((item) => item.threadId !== target.id)
      world.messages.push(
        message({
          id: 'msg-stream-demo',
          threadId: target.id,
          role: 'agent',
          sender: 'agent',
          body: '',
          streaming: true,
          createdAt: now,
          delivery: 'delivered',
        }),
      )
      return world
    }
    case 'streamingProject':
    case 'normal':
    case 'downloads':
    case 'noDownloads':
    case 'maintenance':
      return world
    case 'maintenanceError':
      world.failSettingsSaves = 1
      world.failMemorySaves = 1
      world.failStatusSaves = 1
      world.failingReads.push('projects', 'memory:prj-compat')
      return world
    case 'memoryConflict':
      world.memoryElsewhere['mem-compat-1'] = 'Run the Windows drive-letter tests before every release.'
      return world
    case 'archived': {
      const project = world.projects.find((item) => item.id === 'prj-compat')!
      project.status = 'archived'
      project.archivedAt = now - hour
      project.agent = { ...project.agent, state: 'stopped', reason: null, activity: null }
      for (const item of world.inbox) {
        if (item.projectId !== project.id || item.status !== 'pending') continue
        item.status = 'withdrawn'
        item.revision += 1
        item.result = {
          option: null,
          note: '',
          actor: account.name,
          at: project.archivedAt,
          reason: 'Project archived',
          inputId: null,
        }
      }
      return world
    }
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
        traces: {},
        outputs: {},
      }
    case 'noChats':
      // 设备已接入，还没有任何对话。
      return {
        ...world,
        threads: [],
        messages: [],
        traces: {},
        outputs: {},
        inbox: world.inbox.filter((item) => item.threadId === null),
      }
    case 'inbox':
    case 'inboxPaused': {
      world.inbox.push({
        id: 'itm-compat-notes',
        projectId: 'prj-compat',
        threadId: null,
        kind: 'question',
        title: 'What should the release notes mention?',
        body: '**Windows support** needs a release note.\n\n- Include the drive-letter fix\n- Mention the nightly runner\n\nSee [release guidance](https://example.com/releases).',
        options: [],
        recommended: null,
        allowText: true,
        status: 'pending',
        result: null,
        revision: 1,
        createdAt: now - 5 * minute,
      })
      for (const [index, status] of (['answered', 'closed', 'withdrawn', 'resolved'] as const).entries()) {
        world.inbox.push({
          id: `itm-history-${status}`,
          projectId: 'prj-compat',
          threadId: 'thr-compat',
          kind: status === 'resolved' ? 'system' : 'question',
          title: `Release preparation · ${status}`,
          body: 'Past context is kept with the result.',
          options: [],
          recommended: null,
          allowText: status !== 'resolved',
          status,
          result: {
            option: null,
            note: status === 'answered' ? 'Include Windows support.' : '',
            actor: status === 'withdrawn' ? 'Project assistant' : account.name,
            at: now - hour,
            reason: status === 'withdrawn' ? 'The newer test run replaced this question.' : null,
            inputId: null,
          },
          revision: 2,
          createdAt: now - (index + 4) * hour,
        })
      }
      if (id === 'inboxPaused') world.projects.find((item) => item.id === 'prj-compat')!.status = 'paused'
      return world
    }
    case 'inboxWithdrawn':
      world.withdrawnElsewhere['itm-compat-paths'] = 'A newer test run replaced this question.'
      return world
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
        reference: null,
        body: 'Also add a regression test for the double reconnect.',
        delivery: 'waitingDevice',
        createdAt: now - 2 * minute,
      })
      // Ubuntu Dev 断开期间的输出有一段没保留下来，重连后标出缺口。
      world.outputLoss.push('thr-gateway')
      // 停止请求在 Ubuntu Dev 离线后提交，等它连上再发出。
      pendingStop(world, now, 'thr-patrol', 'waitingDevice')
      return world
    }
    case 'waiting': {
      setDevice(world, 'dev-windows', 'syncing', now)
      const compat = world.threads.find((item) => item.id === 'thr-compat')!
      compat.status = 'waiting'
      world.messages.push(
        message({
          id: 'msg-compat-3',
          threadId: 'thr-compat',
          role: 'user',
          sender: 'you',
          body: 'Rerun only the path tests.',
          createdAt: now - 5 * minute,
          delivery: 'waitingDevice',
        }),
      )
      world.messages.push(
        message({
          id: 'msg-gateway-2',
          threadId: 'thr-gateway',
          role: 'user',
          sender: 'you',
          body: 'Also add a regression test.',
          createdAt: now - minute,
          delivery: 'queued',
        }),
      )
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
        reference: null,
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
        state: 'blocked',
        deviceId: 'dev-ubuntu',
        reason: 'ChatGPT sign-in expired on Ubuntu Dev',
        activity: null,
      }
      // 第一次新建 Project 保存失败，重试成功。
      world.failProjectSaves = 1
      world.failItemSaves = 1
      // 这些内容第一次读取失败，重试成功。
      world.failingReads.push(
        'trace:msg-webui-2',
        fileKey('file:dev-ubuntu', `${ubuntuRepo}/apps/server/src/gateway.test.ts`),
      )
      world.inbox.push({
        id: 'itm-baton-signin',
        projectId: 'prj-baton',
        threadId: null,
        kind: 'system',
        title: 'ChatGPT sign-in expired',
        body: 'Sign in to ChatGPT on Ubuntu Dev, then resume the project.',
        options: [],
        recommended: null,
        allowText: false,
        status: 'pending',
        result: null,
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
