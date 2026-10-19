# Pi 场景录制

入口为 `TestRealPi/<scenario>`，固定 Pi 1.3.0，在 macOS 沙箱中运行。设置 `BATON_RECORD_DIR` 后写入其 `pi/` 子目录；首批真实转录由 PS-175 在本机生成。录制、规范化与删除命令见 [主 README](../../../../../README.md#本机录制与规范化)。本目录的 `*.ndjson` 是 2026-10-19 在 Baton 9c11002 上录制的首批真实转录：Pi 1.3.0，darwin/arm64，模型 `google-vertex/gemini-3.1-flash-lite`。除跳过的 `deliver_active` 外，`TestRealPi` 的 12 个子测试全部通过并各有一份转录，单份 2.6～71 KB。上一级的照文档转录样本和手写假 Agent 继续保留，迁移由 PS-176 负责。

场景与断言：

- `simple`：完整 Coordinator、batond、Worker 链路提交一次任务，结构化结果通过中心校验。
- `result_free_text`：要求只返回自由文本，中心必须以 `failed/result_format` 结束。
- `interrupt_idle`：无工具回合结束后中止，确认停止且结果已知。
- `interrupt_mid_tool`：工具写入启动文件后取消，保留原测试的 ACK、迟到停止确认、待核实状态、`outcomeKnown=false` 与后续写入时序断言。
- `interrupt_before_turn_started`：提交返回后立即中止，通过 StopObserver 等待停止并确认原生历史可读。
- `deliver_idle`：完整父子委托，父回合空闲后交付，中心 `child_deliveries.status=delivered` 证明原生历史确认；保留子 Worker 存在检查。
- `restore_load_only`：独立完成一次任务，重启 batond 后仍为原 Worker，再恢复相同 Pi 会话；恢复后无输出，`count.txt` 仍只有一次写入。
- `restore_missing`：建立独立会话后，用同一 Session ID 和不存在的历史目录恢复，必须返回 `ErrHistoryMissing`。拒绝发生在启动 Pi 之前；转录保留初始化过程，回放还需构造缺失历史。
- `provider_error`：使用不存在的模型名，启动或输入失败，或以 uncertain 结束；不得输出成功结果。
- `symlinked_workspace`：通过 macOS `/tmp` 下的符号链接工作目录启动并完成结构化结果。

`deliver_active` 不适用，保留同名跳过子测试。`internal/agent/pi/pi.go` 的 `DeliverResult` 校验交付 ID 后调用 `SubmitInput`，后者在 `active=true` 时返回 busy，没有 steer 分支。[Baton TECH](../../../../../specs/baton/TECH.md)「Agent 发起委托」中的子结果通知规则规定活动工具通过 CLI 查询结果，空闲且等待该委托时才提交结果输入；活动工具查询在 Pi 原生历史中由 `HistoryContains(deliveryID, true)` 检查。因此该场景无法录成活动回合注入，也不能把 prompt ACK 视为交付确认。

额外保留 `startup`，独立检查实际模型非空和版本，避免它的探针会话成为其他场景的首个会话；`restore_recall` 保留恢复后显式新回合回忆原上下文及 once-only 文件断言。所有场景都执行原沙箱的内部读写、外部读写拒绝、符号链接逃逸拒绝检查，对应目录隔离能力。
