# Project Agent 实施顺序与工单调整

Status: approved
Owner: Asa
Date: 2026-10-18
Baseline: `hhubb22/baton@6da5ebef0d4d129fad4776de3dafd8b2e681f958`；Linear 项目 Baton（P-PS-11）在 2026-10-18 的状态
Approval: 2026-10-18 用户确认。工作项在 Linear 的 Baton 项目中创建，标题保留 PA-W 编号；进度以 Linear 为准。

## 新增工作

| 编号 | 工作 | 主要内容 | 依赖 | 迁移 |
|---|---|---|---|---|
| PA-W01 | 平等节点与默认设备 | 去掉 `pc`/`ubuntu` 角色；默认 PC 改为默认设备，新旧 API 并存；Web 文案和字段改为默认设备 | 无 | 0015 |
| PA-W02 | 节点能力报告 | batond 上报 `node_runtime_reports`：登记目录及真实路径、目录内的 Git 仓库、命令执行开关与 shell、Runtime 版本和订阅登录状态（通过 `probe`） | PA-W01 | 无 |
| PA-W03 | Project 与主对话 | 建表；Project、消息、事件分页、记忆的 API；`client_message_id` 去重；对话事件只追加 | PA-W01 | 0016 |
| PA-W04 | 输入队列、放置与租约 | 输入队列与运行记录建表；各类输入的写入限长；用户修改记忆和 Project 标题、目标时写被动通知；`bootstrap` 与 `read_events` 分页；`claim_inputs` 的批量上限和记忆通知合并；放置扫描（只看主动输入）、取得租约、`project_run_start` 投递与重发、batond 启停 Runtime 和续租、唤醒、`finish`、失败计数与 `needs_attention`；Relay 新消息类型。用一个测试用的假 Runtime 验收 | PA-W02、PA-W03 | 0017 |
| PA-W05 | Project Agent 工具 | `call_tool` 事务（校验租约和 `tool_call_id`、执行、写 `tool_result`）；记忆、历史、设备、任务工具；把 `acceptOnce` 拆出可接受外部事务的版本；任务终态写输入队列 | PA-W04 | 无 |
| PA-W06 | Runtime | `runtimes/project-agent`：pi-agent-core 主循环、事件写入、崩溃恢复、`login` / `probe` 命令、发布方式。用 pi-ai 的 faux provider 做无模型测试 | 协议在 PA-W04 确定后可并行开始 | 无 |
| PA-W07 | 主对话界面 | Project 列表、主对话（含流式片段）、记忆、运行状态与等待原因、需要处理时的重试按钮；Project Agent 执行的命令在主对话和 Project 任务里显示，全局任务列表默认隐藏并提供筛选 | PA-W03、PA-W04 | 无 |
| PA-W08 | 首个端到端验收 | 三台设备、真实订阅跑 PA-A01、PA-A02、PA-A06 | PA-W05～W07 | 无 |
| PA-W09 | 压缩与历史工具 | 第 6 节的清除、复用前缀的摘要、`compaction` 事件校验；`history.search` / `history.read` 在 PA-W05 已有，这里补被清除内容的占位与范围说明 | PA-W06 | 无 |
| PA-W10 | 命令执行 | Worker 内置 `shell` 执行器；`nodes.exec` 与 `wait_tool`；节点本地开关与二次检查；Windows Job Object | PA-W05；#21、#22 合并之后 | 无 |
| PA-W11 | 后续验收 | PA-A07、PA-A11、PA-A12；三系统上的 Runtime 安装与命令执行 | PA-W09、PA-W10 | 无 |

PA-W08 是第一个里程碑。它不需要压缩和命令执行：对话短时不会触发压缩，派发任务时使用已有目录。先跑通「跨设备接续、不重复派发、离线等待」，再加压缩和命令执行。

PA-W10 依赖 #21、#22（T14、T15，均已合并）。这两个 PR 把 Worker 的适配接口统一成 `internal/agent.Adapter`，Worker 只在 `internal/session/adapter.go` 的 `configureAdapter` 一处按 `agent_type` 从 `registeredAdapters` 选择适配器。`shell` 执行器实现这个接口并注册一项，不改 Worker 的生命周期和账本。

[Agent Inbox](../agent-inbox/PRODUCT.md) 的工作项在它的技术设计完成后另列，依赖 PA-W08。0017 已经包含它的输入类型 `attention_answer`，事项表和通知订阅表使用后续迁移。PA-W05 不实现 `inbox.*` 工具。

PA-W02 和 PA-W03 可以并行。PA-W06 的 TypeScript 部分只依赖 PA-W04 确定的 `ProjectRuntimeRequest` 协议，可以和 PA-W05 并行。

按项目约定，工作项派给 Devin 云端会话。PA-W06 需要 Node.js 环境，`.devin/blueprint.yaml` 里已有为 `web/` 准备的 Node.js 和 pnpm，派发前确认版本满足 pi-agent-core 的要求。PA-W08 和 PA-W11 需要真实设备和订阅，按 `lab-request` 准备，实测使用各订阅里最便宜的模型。

## 现有工单

执行 Session 的历史仍留在节点，工作目录也沿用现有的 `working_directory`，所以大部分现有工单不受影响。

| 工单 | 状态 | 处理 |
|---|---|---|
| PS-105、PS-107～PS-117、PS-120、PS-122、PS-128～PS-130、PS-132、PS-142～PS-151 | Done | 不受影响，保留原验收 |
| PS-106 T02 本人节点注册与稳定默认 PC | Done | 原验收保留。默认 PC 改为默认设备由 PA-W01 完成 |
| PS-124 T20 Web UI 登录、节点与默认 PC 设置 | Done | 原验收保留。界面改名由 PA-W01 完成 |
| PS-118 T14 Pi 真实任务（PR #22） | 已合并 | 不受影响。这是执行 Agent 的接入，和 Project Agent 的 Runtime 是两回事 |
| PS-119 T15 Codex 真实任务（PR #21） | 已合并 | 不受影响。适配接口已统一到 `internal/agent.Adapter` |
| PS-121 T17、PS-123 T19 Cursor、Kiro 接入 | Backlog | 不受影响 |
| PS-125 T21、PS-127 T23 Web UI 与本地历史 | Backlog | 不受影响 |
| PS-126 T22 Web UI 任务、委托、取消与核实 | Backlog | 任务详情页的只读部分由 Agent Inbox 的 IB-W03 先做；T22 在同一个页面加入发起任务、委托链、取消、核实和新执行，验收条件相应调整。「由 Project Agent 发起」由 PA-W07 补充 |
| PS-131 T27 Plane 回写 | Backlog | 不受影响；Plane 不接入 Project Agent |
| PS-133 T29 凭据轮换、保留与空间不足 | Backlog | 验收增加一条：Project Agent 的对话事件不被 180 天清理删除；空间不足时拒绝新消息 |
| PS-134～PS-136 T30～T32 macOS、Windows、Linux 安装验收 | Backlog | 验收增加可选项：安装 `baton-project-runtime`、`login`、`probe` 能正确上报；可以等 PA-W11 一起做 |
| PS-137 T33 真实网络委托验收 | Backlog | 不受影响 |
| PS-138～PS-140 T34～T36 容量与长稳 | Backlog | 负载加入 Project Agent 唤醒、对话写入和输入队列积压（Baton R-39 修订） |
| PS-141 T37 首版交付审查 | Backlog | 审查范围加入 Project Agent |
| PS-152 Windows 单调时钟 panic | Backlog | 不受影响，继续 |

需要修改验收条件的只有 PS-126、PS-133、PS-134～PS-136、PS-138～PS-141，都还没有开始。已完成的工单不重新打开，新增内容由 PA-W01 等新工作项承担。

## 规格批准后的操作

1. 合并本规格变更：`specs/baton/PRODUCT.md`、`specs/baton/TECH.md`、`specs/project-agent/` 和决策记录。
2. 在 Linear 的 Baton 项目里新建 PA-W01～PA-W11，用 blocked by 记录上表的依赖，并新建一个「Project Agent」里程碑。
3. 修改 PS-126、PS-133、PS-134～PS-136、PS-138～PS-141 的验收条件。
4. 派发 PA-W01 时登记迁移编号 0015～0017。
