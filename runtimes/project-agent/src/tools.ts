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
    name: "tasks.dispatch",
    description:
      "把开发任务交给执行 Agent；工作目录必须已存在。结果可用 tasks.get 查询。",
    parameters: obj({
      target_node_id: str(),
      agent_type: str(),
      working_directory: str(),
      description: str(),
      expected_outputs: str(),
      queue_timeout_seconds: Type.Optional(Type.Integer({ minimum: 1 })),
      execution_timeout_seconds: Type.Optional(Type.Integer({ minimum: 1 })),
      retry_of_task_id: opt(),
    }),
  },
  {
    name: "tasks.list",
    description: "列出本 Project 的任务。",
    parameters: obj({ status: opt(), after_id: opt(), ...page }),
  },
  {
    name: "tasks.get",
    description: "读取本 Project 的任务状态、结果和证据。",
    parameters: obj({
      task_id: str(),
      version: Type.Optional(Type.Integer({ minimum: 1 })),
      ...page,
    }),
  },
  {
    name: "tasks.cancel",
    description: "请求取消本 Project 的任务。",
    parameters: obj({ task_id: str() }),
  },
  {
    name: "inbox.ask",
    description: "创建请用户处理的事项，立即返回 ID。展示内容为不超过 32 KiB 的 Markdown，链接只允许 https，HTML 和图片不渲染。每个 Project 最多 10 个待处理提案；没有选项时必须允许文字回复。",
    parameters: obj({
      title: str(),
      summary: str(),
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
      task_id: opt(),
    }),
  },
  {
    name: "inbox.list",
    description: "列出本 Project 的提案及系统事项。",
    parameters: obj({ after_id: opt(), ...page }),
  },
  {
    name: "inbox.get",
    description: "读取本 Project 的事项、处理结果、引用的原任务结果和最新版本。",
    parameters: obj({ request_id: str(), ...page }),
  },
  {
    name: "inbox.withdraw",
    description: "撤回本 Project 的待处理提案，必须说明原因。系统事项不能撤回。",
    parameters: obj({ request_id: str(), reason: str() }),
  },
];
