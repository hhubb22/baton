# Codex 转录

## 真实场景入口

`TestRealCodex/<scenario>` 为每个场景创建独立的 app-server、工作目录和原生 thread，使用一次性、独立认证的 CODEX_HOME。设置 `BATON_RECORD_DIR` 后写入其 `codex/` 子目录；本机流程见 [主 README](../../../../../README.md#本机录制与规范化)。首轮 9 份真实转录于 2026-10-19 在 Baton 9c11002 上录制：Codex 0.162.1，darwin/arm64，模型 `gpt-6-luna`，单份 1.7～61 KB。首轮提交了通过的 9 个场景：`simple`、`interrupt_idle`、`interrupt_mid_tool`、`deliver_active`、`deliver_idle`、`restore_load_only`、`restore_missing`、`provider_error`、`symlinked_workspace`。

首轮失败场景的补录结果：

- `interrupt_before_turn_started`：PS-178 修复后于同日在 `845e1b5` 基线加本工单工作区改动上补录，Codex 0.162.1 / `gpt-6.1-sol`，真实子测试通过。`turn/start` 响应的 `startedAt` 为 null，首次中止被 `-32600 no active turn to interrupt` 拒绝；收到匹配的 `turn/started` 后补发一次，ACK 后收到 `status=interrupted` 的 `turn/completed`，原 thread 历史可读。规范化转录 8,062 字节，删除 2 帧机器信息；残留扫描及用户名、主机名、邮箱、临时路径检查通过。适配器和 Worker 均回放此转录；从真实 `simple` 派生的手写拒绝/开始窗口另覆盖重复通知、其他 thread/turn、开始通知先到、补发失败及完成后晚到的开始通知。ACK 保持 false/false，仅匹配的完成通知确认停止，Worker 保留 needs_verification。
- `delegation`：首轮用 `gpt-6-luna` 录制时，子任务描述要求不运行工具、不再委托，子 Agent 仍然继续委托，后几层请求文件无效，失败一路传回父任务，属于模型不遵守指令。同日改用 `gpt-6.1-sol` 重录后通过，`delegation.ndjson` 头部记录的模型是 `gpt-6.1-sol`。规范化只保留父会话，子会话的 80 帧计入 `dropped_frames`。

- `simple`：版本探测、创建 thread、一次输入、settled、结构化结果及摘要检查。
- `interrupt_idle`：完成后调用 Abort，使用已保存的停止事实，保持 `outcomeKnown=false`。
- `interrupt_mid_tool`：工具写入门控文件后中止；ACK 必须仍是 `false/false`，终止事件保留 Stopped/Uncertain 检查，并检查 StopObserver。
- `interrupt_before_turn_started`：SubmitInput 返回后立即 Abort，观察停止，核对原 thread/turn 身份和历史可读。
- `deliver_active`：保留原工具等待文件、补充输入摘要 token 检查；通过 DeliverResult 调用 `turn/steer`，并额外核对原生历史中的精确 delivery_id。
- `deliver_idle`：独立回合完成后用 DeliverResult 启动交付回合，核对精确 delivery_id，保留原任务输入的一次提交。
- `restore_load_only`：关闭进程后 Attach 同一映射，不发送输入；保留 thread/turn ID 不变、原完成事实和有效 JSON 历史检查。
- `restore_missing`：本地映射指向不存在的 thread，`thread/read` 失败，映射不得被替换，也不得新建 thread。
- `provider_error`：不存在的模型名必须导致方法失败或 uncertain 终止，不得返回成功结果。
- `symlinked_workspace`：通过 macOS `/tmp` 下的符号链接目录完成任务，使用适配器现有的 cwd 规范化。

`result_free_text` 不适用，保留同名跳过子测试。`internal/agent/codex/codex.go` 的 `StartTask` 每次 `turn/start` 都携带 `outputSchema: ResultSchema()`，`internal/agent/codex/result.go` 要求包含 status、summary 等字段的对象；[Baton TECH](../../../../../specs/baton/TECH.md)「结构化结果」优先使用原生 output schema。当前适配器无法通过任务提示关闭该约束，要求模型自由文本不能稳定产生对应转录。自由文本拒绝继续由既有结果校验测试覆盖，真实错误帧的派生回放由后续迁移工单处理。

额外子测试 `delegation` 保留完整 Coordinator/batond/Worker 委托链路及原 CLI 的 delegate、wait、result 流程，检查父摘要、恰好一个完成且摘要正确的子任务、父任务完成。它包含真实子 Agent 会话，规范化只保留父会话，丢弃条目计入 dropped_frames。该流程还覆盖活动工具查询子结果，独立于 `deliver_active` 的 steer 注入。

## CI 回放

`TestRecordedCodexScenarios` 和 `TestRecordedCodexWorkerScenarios` 分别回放上述 10 份转录（含补录的 delegation）。`interrupt_before_turn_started` 的录制随 PS-178 提交；文件尚未合入时，两层测试都显式跳过，合入后纳入同一场景遍历。`delegation` 通过成功查询工具输出中的精确 delivery_id 确认，回放只包含父会话，不启动真实子 Agent。

测试用独立临时目录绑定 `transcript_start.bindings`，`symlinked_workspace` 额外创建符号链接；不支持创建符号链接的平台显式跳过该项。测试只保留与 app-server 配对的版本探测；录制驱动的额外探测、被筛除子会话留下的探测在测试准备时去掉，进程连续编号。录制响应、方法、thread/turn 身份和原有捕获保留。每个 app-server 末尾设门，检查已经消费全部所选请求，并检查 `failure.json`。

适配器层交付按录制时的精简信封执行。Worker 层使用以下派生前置条件，原始转录文件保持不变：

- 选择 Worker 会调用的历史查询，去掉录制测试额外的前后观察查询；所选查询与响应保持录制内容。
- 出站交付文本按 Worker 的完整 `ChildDelivery` 信封生成，保留同一 delivery_id 捕获；原生历史继续使用录制响应。确认只检查精确 delivery_id。
- `deliver_active`、`restore_load_only` 的活动交付先准备账本中已有的 `waiting_children` 事实。录制驱动直接调用 DeliverResult；Worker 自动续接要求已有等待子结果的事实。
- `deliver_idle` 将第一回合的最终消息派生为 `baton_waiting_for_children`，以满足 Worker 自动续接条件；第二回合和交付历史保留录制内容。

交付后的历史响应前设门：即使 steer ACK 和 settled 已到，Worker 仍保存 uncertain，放行含精确 ID 的历史后才产生 delivered 回执。`delivery_wrong_id` 将该历史里的 ID 改为相似值并 CutAfter，检查保留 uncertain、结果待核实。`delegation` 由 Worker 的 queried 子结果通知触发：wait 的嵌套 JSON 输出没有顶层 delivery_id，保持 uncertain；result 的成功工具输出含精确 ID，放行后才确认 delivered，不向 Agent 注入新输入。重复通知不再注入；`restore_load_only` 重启 Worker 后补报同一条 outbox 结果，保持原 thread/turn，不再提交任务。

`interrupt_mid_tool` 的录制没有 commandExecution 开始事件。回放在录制的 `turn/moderationMetadata` 处设门，然后发 Abort，并在 `turn/completed` 前另设门，分别验证 ACK 与迟到的 StopObserver 停止事实；outcomeKnown 保持 false。该回放不能证明工具开始事件的门控能力。

## 覆盖对应表

| 原 FIXTURE_MODE / 覆盖点 | 当前证据 |
|---|---|
| `complete` | 两层 `simple`、`restore_load_only`；结构化结果在 settled 后输出、重复任务拒绝、恢复身份与 outbox 补报 |
| `running` | 两层 `interrupt_mid_tool`、`deliver_active`、`deliver_idle`；StopObserver、交付路由、精确历史确认；`TestUnifiedWaitingOutput` 保留等待标记单测 |
| `disconnect` | 两层 `disconnect`：simple.CutAfter(request:turn/start)；`TestPendingInputRecoveryNeverResubmits` 覆盖未确认输入的恢复拒绝 |
| `missing` | 两层 `restore_missing`；`TestRecoveryPaginationAndGuards/wrong-thread` 覆盖返回错误 thread 身份 |
| `incompatible` | `TestRecoveryPaginationAndGuards/incompatible`，恢复返回 -32601 时拒绝，不新建会话 |
| `paged` | `TestRecoveryPaginationAndGuards/paged`，turn 与 item 均跨页；`TestHistoryContainsExactIdentity` 的交付查询跨页 |
| `absentturn` | `TestRecoveryPaginationAndGuards/absentturn` |
| `cycle` | `TestRecoveryPaginationAndGuards/cycle` |
| `missing-items` | `TestRecoveryPaginationAndGuards/missing-items` |
| `wrongversion` | `TestRecordedCodexFaults/wrongversion`，Replace 版本响应 |
| `badturn` | `TestRecordedCodexFaults/badturn`，Replace 空 turn ID，输入保持不可重试 |
| `badsteer` | `TestRecordedCodexFaults/badsteer`，Replace 错误 turn ID，交付保持不可重试 |
| 默认无完成事件 | 两层 `drop_settled`，Drop(turn/completed) 后没有成功或停止证据 |
| 符号链接目录与重定向 | 两层 `symlinked_workspace`；适配器层重定向后拒绝恢复 |
| 历史角色、查询成功与精确 ID | `TestHistoryContainsExactIdentity`；Worker `delivery_wrong_id` |
| 浏览器历史与大帧 | `TestBrowserHistoryReadableAfterExit`、`TestBrowserHistoryFallbackReplayIsolation`、`TestCodexLFFramingLimits`；原生文件只读、协议查询连接隔离与 limit=1、截断、缺失映射、跨读取边界与 8 MiB 上限 |
| 通知身份、审批拒绝与有界输出 | `TestNotificationsAreBoundAndApprovalsRefused`、`TestBrowserDeltaUsesSeparateBoundedQueue`、`TestDrainIgnoresPreviousTurnAfterSessionReuse` |

`exit_mid_turn` 从 simple.CutAfter(response:turn/start) 派生，两层均拒绝成功，Worker 进入待核实。配额错误无法稳定按需录制，适配器层用 Replace 派生 failed 回合。Codex 固定 outputSchema，`free_text` 用 Replace 派生最终消息：适配器层校验拒绝该候选，Worker 记录 failed。
