import { Type } from "@earendil-works/pi-ai";
const str = () => Type.String();
const opt = () => Type.Optional(str());
const page = {
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
  max_bytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 32768 })),
};
const obj = (properties: Record<string, any>) =>
  Type.Object(properties, { additionalProperties: false });
export const toolDefinitions = [
  {
    name: "memory.search",
    description: "按关键字搜索本 Project 的记忆，最多 20 条。",
    parameters: obj({ query: str(), after_id: opt(), ...page }),
  },
  {
    name: "memory.read",
    description: "读取本 Project 的一条记忆。",
    parameters: obj({
      entry_id: str(),
      revision: Type.Optional(Type.Integer({ minimum: 1 })),
      ...page,
    }),
  },
  {
    name: "memory.write",
    description:
      "保存记忆；新建时 expected_revision 为 0，修改时填写当前版本。",
    parameters: obj({
      entry_id: opt(),
      title: str(),
      content: str(),
      expected_revision: Type.Integer({ minimum: 0 }),
    }),
  },
  {
    name: "history.search",
    description: "搜索主对话原文。",
    parameters: obj({
      query: str(),
      after_seq: Type.Optional(Type.Integer({ minimum: 0 })),
      through_seq: Type.Optional(Type.Integer({ minimum: 1 })),
      ...page,
    }),
  },
  {
    name: "history.read",
    description: "按序号范围读取主对话原文。",
    parameters: obj({
      after_seq: Type.Integer({ minimum: 0 }),
      through_seq: Type.Optional(Type.Integer({ minimum: 1 })),
      ...page,
    }),
  },
  {
    name: "devices.list",
    description: "列出本人设备、在线状态和能力。",
    parameters: obj({ after_id: opt(), ...page }),
  },
  {
    name: "threads.create",
    description:
      "在目标设备上新建 Thread 并向执行 Agent 发出第一条消息，立即返回 Thread ID 和状态。工作目录必须已存在；agent_type 不能为 shell，命令通过 nodes.exec 执行。在 message 中写明工作目标和验证方式，找不到验证方式时写明原因。结果可用 threads.read 查询。",
    parameters: obj({
      node_id: str(),
      agent_type: str(),
      working_directory: str(),
      message: str(),
      execution_timeout_seconds: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
  },
  {
    name: "threads.send",
    description:
      "向本 Project 的 Thread 发送消息，包括用户新建的 Thread。mode 默认为 queue；steer 插入当前一轮，不支持时返回错误。",
    parameters: obj({
      thread_id: str(),
      message: str(),
      mode: Type.Optional(
        Type.Union([Type.Literal("queue"), Type.Literal("steer")]),
      ),
    }),
  },
  {
    name: "threads.stop",
    description: "停止本 Project 的 Thread 当前一轮。",
    parameters: obj({ thread_id: str() }),
  },
  {
    name: "threads.archive",
    description: "归档本 Project 的 Thread。",
    parameters: obj({ thread_id: str() }),
  },
  {
    name: "threads.list",
    description: "列出本 Project 的 Thread，可按状态筛选。",
    parameters: obj({ status: opt(), after_id: opt(), ...page }),
  },
  {
    name: "threads.get",
    description: "读取本 Project 的 Thread 状态、当前 Turn 和待发消息。",
    parameters: obj({ thread_id: str(), ...page }),
  },
  {
    name: "threads.read",
    description: "按 Turn 读取本 Project 的 Thread 消息和回复正文；续读时固定 through_turn。",
    parameters: obj({
      thread_id: str(),
      after_turn: Type.Optional(Type.Integer({ minimum: 0 })),
      through_turn: Type.Optional(Type.Integer({ minimum: 1 })),
      ...page,
    }),
  },
  {
    name: "nodes.exec",
    description:
      "在已开启命令执行的节点上管理环境，例如创建 worktree、检查仓库或安装依赖。开发工作优先派发给执行 Agent。Baton 不检查命令内容，也不提供沙箱；命令以节点用户身份运行。工作目录必须已存在并位于节点登记目录内。等待结束后命令继续运行，结果可用 threads.read 查询。",
    parameters: obj({
      node_id: str(),
      command: str(),
      working_directory: str(),
      wait_seconds: Type.Optional(
        Type.Integer({ minimum: 0, maximum: 600, default: 30 }),
      ),
      timeout_seconds: Type.Optional(
        Type.Integer({ minimum: 1, default: 7200 }),
      ),
    }),
  },
  {
    name: "inbox.ask",
    description: "创建请用户处理的事项，可通过 thread_id 关联本 Project 的 Thread，立即返回事项 ID。展示内容为不超过 32 KiB 的 Markdown，链接只允许 https，HTML 和图片不渲染。每个 Project 最多 10 个待处理事项；没有选项时必须允许文字回复。",
    parameters: obj({
      title: str(),
      content: str(),
      options: Type.Array(
        obj({
          id: str(),
          label: str(),
          description: opt(),
          recommended: Type.Optional(Type.Boolean()),
        }),
        { maxItems: 5 },
      ),
      allow_text: Type.Boolean(),
      thread_id: opt(),
    }),
  },
  {
    name: "inbox.list",
    description: "列出本 Project 的事项及其状态。",
    parameters: obj({ after_id: opt(), ...page }),
  },
  {
    name: "inbox.get",
    description: "读取本 Project 的完整事项、关联 Thread ID 和处理结果。",
    parameters: obj({ request_id: str(), ...page }),
  },
  {
    name: "inbox.withdraw",
    description: "撤回本 Project 的待处理 Agent 事项，必须说明原因；已处理时返回当前状态和处理结果。系统事项不能撤回。",
    parameters: obj({ request_id: str(), reason: str() }),
  },
];
