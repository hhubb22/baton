// 首页原型的示例数据，字段按现有规格取名，接入接口时整体替换

export type ProjectStatus = 'running' | 'waiting' | 'idle' | 'paused' | 'attention'

export interface Project {
  id: string
  title: string
  goal: string
  status: ProjectStatus
  model: string
  runtime?: string
  hue: number
  unread: number
}

export interface Device {
  id: string
  name: string
  online: boolean
  isDefault: boolean
  agents: string[]
  directories: string[]
}

export interface InboxItem {
  id: string
  projectID: string
  taskID?: string
  title: string
  summary: string
  options: { label: string; suggested?: boolean }[]
  createdAt: string
  system?: boolean
}

export type TaskState = 'running' | 'queued' | 'succeeded' | 'failed' | 'unverified'

export interface Task {
  id: string
  projectID: string
  title: string
  device: string
  agent: string
  state: TaskState
  by: 'agent' | 'user'
  updatedAt: string
  summary?: string
}

export interface Memory {
  id: string
  projectID: string
  text: string
  version: number
  by: 'agent' | 'user'
  updatedAt: string
}

export type Entry =
  | { kind: 'day'; label: string }
  | { kind: 'user'; text: string; time: string; pending?: boolean }
  | { kind: 'agent'; text: string; time: string }
  | { kind: 'task'; taskID: string }
  | { kind: 'inbox'; itemID: string }
  | { kind: 'note'; text: string }

export const projects: Project[] = [
  { id: 'p1', title: 'Baton 开发', goal: '第一个里程碑：一件真实工作跨设备走通全程', status: 'running', model: 'gpt-6.1-sol', runtime: 'Ubuntu 开发机', hue: 186, unread: 0 },
  { id: 'p2', title: '兼容性测试', goal: '每次发版前在三种系统上跑完整测试', status: 'attention', model: 'gpt-6.1-sol', hue: 28, unread: 2 },
  { id: 'p3', title: '文档整理', goal: '', status: 'idle', model: 'qwen3-coder-next', hue: 262, unread: 0 },
  { id: 'p4', title: '交换机巡检', goal: '实验室交换机的版本和告警', status: 'paused', model: 'gpt-6.1-sol', hue: 140, unread: 0 },
]

export const devices: Device[] = [
  { id: 'd1', name: 'MacBook Pro', online: false, isDefault: true, agents: ['Codex', 'Pi', 'Kiro'], directories: ['~/src/baton', '~/src/docs'] },
  { id: 'd2', name: 'Windows 台式机', online: true, isDefault: false, agents: ['Codex'], directories: ['D:\\src\\baton'] },
  { id: 'd3', name: 'Ubuntu 开发机', online: true, isDefault: false, agents: ['Codex', 'Pi'], directories: ['~/work/baton'] },
]

export const inbox: InboxItem[] = [
  {
    id: 'i1',
    projectID: 'p2',
    taskID: 't2',
    title: '重连测试失败，下一步怎么处理',
    summary: 'Windows 上 42 项通过，1 项失败：断线 30 秒后没有重新同步。',
    options: [{ label: '调查原因并修复', suggested: true }, { label: '再跑一次' }, { label: '先跳过' }],
    createdAt: '12 分钟前',
  },
  {
    id: 'i2',
    projectID: 'p2',
    taskID: 't5',
    title: '任务结果待核实',
    summary: '设备在交付前断开，无法确认测试报告是否已经写入。',
    options: [],
    createdAt: '1 小时前',
    system: true,
  },
]

export const tasks: Task[] = [
  { id: 't1', projectID: 'p1', title: '补齐 Kiro 恢复路径的回放用例', device: 'Ubuntu 开发机', agent: 'Codex', state: 'running', by: 'agent', updatedAt: '刚刚' },
  { id: 't6', projectID: 'p1', title: '修复 Codex 中止后的重复上报', device: 'MacBook Pro', agent: 'Codex', state: 'succeeded', by: 'agent', updatedAt: '昨天', summary: '提交 4a3a257，回放 11 项全部通过' },
  { id: 't3', projectID: 'p1', title: '迁移 0031 在空库上的演练', device: 'MacBook Pro', agent: 'Pi', state: 'queued', by: 'user', updatedAt: '40 分钟前' },
  { id: 't2', projectID: 'p2', title: '在 Windows 上跑一遍兼容性测试', device: 'Windows 台式机', agent: 'Codex', state: 'failed', by: 'agent', updatedAt: '12 分钟前', summary: '42 项通过，1 项失败' },
  { id: 't5', projectID: 'p2', title: '在 macOS 上跑一遍兼容性测试', device: 'MacBook Pro', agent: 'Codex', state: 'unverified', by: 'agent', updatedAt: '1 小时前' },
  { id: 't4', projectID: 'p3', title: '整理 README 的运行要求', device: 'MacBook Pro', agent: 'Pi', state: 'succeeded', by: 'agent', updatedAt: '昨天', summary: '删掉 3 处重复说明' },
]

export const memories: Memory[] = [
  { id: 'm1', projectID: 'p1', text: 'Baton 仓库在 Ubuntu 开发机上的路径是 ~/work/baton', version: 2, by: 'agent', updatedAt: '昨天' },
  { id: 'm2', projectID: 'p1', text: '真实 Agent 验收用 gpt-6.1-sol，不用回放代替', version: 1, by: 'user', updatedAt: '3 天前' },
  { id: 'm3', projectID: 'p1', text: '第一个版本之前不做性能和容量优化', version: 1, by: 'agent', updatedAt: '3 天前' },
  { id: 'm4', projectID: 'p2', text: 'Windows 台式机只装了 Codex', version: 1, by: 'agent', updatedAt: '上周' },
]

export const conversations: Record<string, Entry[]> = {
  p1: [
    { kind: 'day', label: '昨天' },
    { kind: 'user', text: 'Codex 中止之后偶尔会重复上报一次停止，帮我查一下。', time: '21:04' },
    { kind: 'agent', text: '我先让 MacBook 上的 Codex 复现。有结果我再告诉你。', time: '21:05' },
    { kind: 'task', taskID: 't6' },
    { kind: 'agent', text: '修好了。原因是关闭连接和分发响应同时发生，停止事件被补报了一次。提交是 4a3a257，11 份回放都通过了。', time: '21:47' },
    { kind: 'note', text: '记住了：Baton 仓库在 Ubuntu 开发机上的路径是 ~/work/baton' },
    { kind: 'day', label: '今天' },
    { kind: 'note', text: 'MacBook Pro 离线，改在 Ubuntu 开发机上继续' },
    { kind: 'user', text: 'Kiro 的恢复路径还没有回放用例，补一下。', time: '14:52' },
    { kind: 'agent', text: '好。Ubuntu 开发机上有 Codex，我派给它，工作目录用 ~/work/baton。完成标准是 `go test ./internal/agent/kiro` 通过，并且新增的转录能在回放里命中 session/load。', time: '14:53' },
    { kind: 'task', taskID: 't1' },
  ],
  p2: [
    { kind: 'day', label: '今天' },
    { kind: 'user', text: '发版前在 Windows 和 macOS 上各跑一遍兼容性测试。', time: '13:20' },
    { kind: 'agent', text: '两边同时开始。Windows 用 Codex，macOS 也用 Codex。', time: '13:21' },
    { kind: 'task', taskID: 't2' },
    { kind: 'task', taskID: 't5' },
    { kind: 'agent', text: 'Windows 跑完了，有一项没过：断线 30 秒后没有重新同步，其余 42 项正常。要不要我继续查？', time: '14:48' },
    { kind: 'inbox', itemID: 'i1' },
    { kind: 'inbox', itemID: 'i2' },
  ],
  p3: [
    { kind: 'day', label: '昨天' },
    { kind: 'user', text: 'README 的运行要求写得很乱，整理一下。', time: '10:02' },
    { kind: 'task', taskID: 't4' },
    { kind: 'agent', text: '整理好了，删掉了 3 处重复的说明，Go 和 PostgreSQL 的版本要求合到了一段。', time: '10:31' },
  ],
  p4: [
    { kind: 'day', label: '上周' },
    { kind: 'user', text: '检查一下实验室 6 台交换机的版本和告警。', time: '周五 09:12' },
    { kind: 'agent', text: '6 台版本一致，都是 4.4.2，没有新的告警。', time: '周五 09:30' },
    { kind: 'note', text: '你暂停了这个 Project' },
  ],
}

export const employee = { name: 'Asa', initial: 'A' }
