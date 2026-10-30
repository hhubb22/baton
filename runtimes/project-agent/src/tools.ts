import { Type } from '@earendil-works/pi-ai'
const str = () => Type.String()
const opt = () => Type.Optional(str())
const page = {
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
  max_bytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 32768 })),
}
const obj = (properties: Record<string, any>) => Type.Object(properties, { additionalProperties: false })
const evidence = Type.Array(
  obj({
    source_id: str(),
    start_byte: Type.Integer({ minimum: 0 }),
    end_byte: Type.Integer({ minimum: 1 }),
    source_hash: str(),
  }),
  { minItems: 1, maxItems: 32 },
)
const memoryContent = {
  title: str(),
  content: str(),
  kind: Type.Optional(Type.Union(['preference', 'fact', 'decision', 'lesson'].map((v) => Type.Literal(v)))),
  topic: opt(),
  conditions: opt(),
  semantic_key: opt(),
  core: Type.Optional(Type.Boolean()),
  valid_from: Type.Optional(Type.Union([str(), Type.Null()])),
  valid_until: Type.Optional(Type.Union([str(), Type.Null()])),
  time_precision: Type.Optional(Type.Union(['unknown', 'instant', 'day', 'range'].map((v) => Type.Literal(v)))),
}
export const toolDefinitions = [
  {
    name: 'memory.recall',
    description:
      '在本 Project 本地按相关性检索记忆与来源片段，最多 20 条。current 返回当前有效知识；history 可按 as_of 查询事实区间。未命中可改写查询或读取来源；结果明确标识截断、抑制和降级。',
    parameters: obj({
      query: str(),
      mode: Type.Optional(Type.Union(['current', 'history'].map((v) => Type.Literal(v)))),
      as_of: opt(),
      include_inactive: Type.Optional(Type.Boolean()),
      max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
      max_bytes: Type.Optional(Type.Integer({ minimum: 1024, maximum: 32768 })),
    }),
  },
  {
    name: 'memory.read',
    description:
      '读取记忆或原始来源。item_id/source_id/source_seq 三选一。用 source_seq 与 input_id 登记已读用户输入的来源，返回 source_hash 和 UTF-8 字节范围供写入引用；input_id 从 history.read 获取。来源分页保持原文哈希。',
    parameters: obj({
      item_id: opt(),
      source_id: opt(),
      source_seq: Type.Optional(Type.Integer({ minimum: 1 })),
      input_id: Type.Optional(Type.Integer({ minimum: 1 })),
      revision: Type.Optional(Type.Integer({ minimum: 1 })),
      ...page,
      max_bytes: Type.Optional(Type.Integer({ minimum: 4, maximum: 32768 })),
    }),
  },
  {
    name: 'memory.remember',
    description:
      '保存有原始证据的知识，等价知识合并独立证据。先用 memory.read 登记来源；助手报告只能支持推断。保留条件、否定和例外。',
    parameters: obj({ ...memoryContent, evidence }),
  },
  {
    name: 'memory.correct',
    description:
      '纠正知识、补充证据、标记争议或登记事实变化。correct 撤回旧错误；supersede 必须提供同一 semantic_key 和 conditions、明确 valid_from 的后继；support 保持结论与时间一致。编辑不恢复停用条目。',
    parameters: obj({
      item_id: str(),
      expected_revision: Type.Integer({ minimum: 1 }),
      action: Type.Union(['correct', 'supersede', 'support', 'dispute'].map((v) => Type.Literal(v))),
      content: Type.Optional(obj(memoryContent)),
      evidence,
      reason: opt(),
    }),
  },
  {
    name: 'memory.retire',
    description: '根据用户明确请求停用知识，保留原始历史。须引用用户请求证据。',
    parameters: obj({ item_id: str(), expected_revision: Type.Integer({ minimum: 1 }), evidence, reason: opt() }),
  },
  {
    name: 'memory.restore',
    description: '根据用户明确请求恢复停用知识，须引用用户新请求证据及条目的 suppression_id。存在互斥后继时返回冲突。',
    parameters: obj({
      item_id: str(),
      expected_revision: Type.Integer({ minimum: 1 }),
      suppression_id: str(),
      evidence,
    }),
  },
  {
    name: 'history.search',
    description: '搜索主对话原文。',
    parameters: obj({
      query: str(),
      after_seq: Type.Optional(Type.Integer({ minimum: 0 })),
      through_seq: Type.Optional(Type.Integer({ minimum: 1 })),
      ...page,
    }),
  },
  {
    name: 'history.read',
    description: '按序号范围读取主对话原文。',
    parameters: obj({
      after_seq: Type.Integer({ minimum: 0 }),
      through_seq: Type.Optional(Type.Integer({ minimum: 1 })),
      ...page,
    }),
  },
  {
    name: 'devices.list',
    description: '列出本人设备、在线状态和能力。',
    parameters: obj({ after_id: opt(), ...page }),
  },
  {
    name: 'threads.create',
    description:
      '在目标设备上新建 Thread 并向执行 Agent 发出第一条消息，立即返回 Thread ID 和状态。按设备能力、用户要求和项目记忆选择 Agent 与模型；省略 model 时使用设备上该 Agent 的默认模型。runtime_mode 可选 devices.list 报告的模式，省略时使用上游默认模式。工作目录必须已存在；agent_type 不能为 shell，命令通过 nodes.exec 执行。在 message 中写明工作目标和验证方式，找不到验证方式时写明原因。结果可用 threads.read 查询。',
    parameters: obj({
      node_id: str(),
      agent_type: str(),
      runtime_mode: opt(),
      model: opt(),
      working_directory: str(),
      message: str(),
      execution_timeout_seconds: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
  },
  {
    name: 'threads.send',
    description:
      '向本 Project 的 Thread 发送消息。mode 默认为 queue；可用 model 指定下一轮模型，省略时沿用当前模型。设备需上报该模型并支持换模型。steer 插入当前一轮并沿用当前模型，不能同时指定 model，不支持时返回错误。',
    parameters: obj({
      thread_id: str(),
      message: str(),
      model: opt(),
      mode: Type.Optional(Type.Union([Type.Literal('queue'), Type.Literal('steer')])),
    }),
  },
  {
    name: 'threads.withdraw',
    description:
      '撤回本 Project 的 Thread 中尚未发送的消息。message_id 从 threads.get 的 pending_messages 读取；仅接受 accepted 或 queued，已发送或结果未知时拒绝。返回的是撤回请求，最终状态用 threads.get 查询。',
    parameters: obj({ thread_id: str(), message_id: str() }),
  },
  {
    name: 'threads.resume',
    description:
      '显式恢复本 Project 已打开的 Thread，沿用中心的设备能力与执行状态校验；停止尚未确认或正在执行时拒绝。重复请求复用待处理的恢复命令，不重新发送历史消息；shell Thread 不支持恢复。结果用 threads.get 查询。',
    parameters: obj({ thread_id: str() }),
  },
  {
    name: 'threads.stop',
    description: '停止本 Project 的 Thread 当前一轮。',
    parameters: obj({ thread_id: str() }),
  },
  {
    name: 'threads.archive',
    description: '归档本 Project 的 Thread。',
    parameters: obj({ thread_id: str() }),
  },
  {
    name: 'threads.list',
    description: '列出本 Project 的 Thread，可按状态筛选。',
    parameters: obj({ status: opt(), after_id: opt(), ...page }),
  },
  {
    name: 'threads.get',
    description: '读取本 Project 的 Thread 状态、当前 Turn 和待发消息。',
    parameters: obj({ thread_id: str(), ...page }),
  },
  {
    name: 'threads.read',
    description:
      '按 Turn 读取本 Project 的 Thread 消息、回复正文和过程项数量；续读时固定 through_turn，过程项用 threads.trace 读取。',
    parameters: obj({
      thread_id: str(),
      after_turn: Type.Optional(Type.Integer({ minimum: 0 })),
      through_turn: Type.Optional(Type.Integer({ minimum: 1 })),
      ...page,
    }),
  },
  {
    name: 'threads.trace',
    description:
      '读取本 Project 的 Thread 一轮的过程记录，包括命令、文件修改和工具调用的原文；设备离线时仍可读取中心保存的内容。按 next_cursor 续页，单页较大时，将结果外层的 page_cursor 作为 cursor，配合 next_offset 读取剩余 JSON 片段；读完一页再用页内的 next_cursor 翻页并将 offset 归零。省略 cursor 从最新记录重新读取。',
    parameters: obj({
      thread_id: str(),
      worker_turn_seq: Type.Integer({ minimum: 1 }),
      cursor: opt(),
      ...page,
    }),
  },
  {
    name: 'nodes.exec',
    description:
      '在已开启命令执行的节点上管理环境，例如创建 worktree、检查仓库或安装依赖。开发工作优先派发给执行 Agent。Baton 不检查命令内容，也不提供沙箱；命令以节点用户身份运行。工作目录必须已存在并位于节点登记目录内。等待结束后命令继续运行，结果可用 threads.read 查询。',
    parameters: obj({
      node_id: str(),
      command: str(),
      working_directory: str(),
      wait_seconds: Type.Optional(Type.Integer({ minimum: 0, maximum: 600, default: 30 })),
      timeout_seconds: Type.Optional(Type.Integer({ minimum: 1, default: 7200 })),
    }),
  },
]
