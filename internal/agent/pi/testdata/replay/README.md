# Pi 场景录制

入口为 `TestRealPi/<scenario>`，固定 Pi 1.3.0，在 macOS 沙箱中运行。设置 `BATON_RECORD_DIR` 后写入其 `pi/` 子目录；首批真实转录由 PS-175 在本机生成。录制、规范化与删除命令见 [主 README](../../../../../README.md#本机录制与规范化)。本目录的 `*.ndjson` 是 2026-10-19 在 Baton 9c11002 上录制的首批真实转录：Pi 1.3.0，darwin/arm64，模型 `google-vertex/gemini-3.1-flash-lite`。除跳过的 `deliver_active` 外，`TestRealPi` 的 12 个子测试全部通过并各有一份转录，单份 2.6～71 KB。适配器层 `TestPiRecordedTranscripts` 回放全部 12 份转录；Worker 层 `TestPiWorkerRecordedTranscripts` 通过真实 IPC、许可、SQLite 账本和 Pi 适配器覆盖适用场景。

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

## CI 回放

两层测试共用 `pireplaytest` 准备路径绑定、跨进程捕获、门控和故障变体。转录只替换头部声明的绑定；`<tools>` 等原文保留。符号链接目录不可创建时只跳过 `symlinked_workspace`，其余路径绑定照常在三系统 CI 执行。Worker 构造真实 Pi 适配器时将原生目录绑定到录制中的目录布局，生命周期与协议处理均使用产品代码。

| 场景 | 适配器层断言 | Worker 层断言 |
|---|---|---|
| `startup` | 初始化、版本、非空模型，无输入 | 独立无输入探针不适用；Worker 仅在提交任务时初始化 Agent |
| `simple` | settled 前无最终结果；每条入站帧前检查此前的历史追加 | settled 前无结果报告；重复任务提交只保存一次输入 |
| `result_free_text` | 不能解析为结构化成功 | `failed/result_format` |
| `interrupt_idle` | 完成后 abort 确认停止且结果已知 | 完成报告落账后直接取停止事实；以 `CutAfter(agent_settled)` 截取回合，Worker 无须向空闲 Agent 发 abort |
| `interrupt_mid_tool` | 工具开始时设门，中止超时后由 StopObserver 报告迟到 settled，副作用未知 | 首次 stop_report 未停止；ACK 后迟到停止事实生成新事件，状态保持待核实 |
| `interrupt_before_turn_started` | 提交返回后立即中止，历史可读 | 中止不丢失，停止事实和历史可读 |
| `deliver_idle` | 历史未写入前不确认；精确 ID、角色与重复交付检查 | 子结果通知触发代次 2；历史确认后才回执 delivered；重复通知不再输入 |
| `restore_load_only` | 原 Session ID 跨进程使用，恢复只初始化 | 重启 RunWorker，原 outbox 事件补报且任务输入仍为一次 |
| `restore_missing` | 无输入初始化后缺失历史拒绝恢复 | 准备录制中的无输入映射，以持久化输入意图启动 RunWorker，缺失历史进入 `uncertain_history`，不启动替代会话 |
| `restore_recall` | 恢复后显式第二回合完成 | 以 `CutAfter(response:get_state:2)` 截取恢复阶段，检查原 outbox 与一次任务输入；显式回忆回合由适配器层覆盖 |
| `provider_error` | uncertain 结算，无成功结果 | 待核实，无成功报告 |
| `symlinked_workspace` | 符号链接目录解析后完成 | 同一工作目录完成且不重复输入 |

`deliver_idle` 保留了父任务期间观察到的子任务 `--version` 进程，测试只回放该无输入探测，不运行子 Agent 或模型。交付信封的任务身份和结果来自录制，Session ID、delivery_id 在本次运行捕获。

派生故障：`simple` 经 `CutAfter(tool_execution_start)` 模拟中途崩溃；`Drop(agent_settled)` 验证 agent_end 和退出均不证明结算；最终 assistant 的合法 provider 配额错误通过 `Replace` 生成。`interrupt_mid_tool` 删除 settled 后保留 abort ACK，验证 ACK 不构成停止证据。两层均执行这些变体。Worker 另在交付 ACK 前恢复上一版历史文件，模拟交付记录丢失：即使 ACK 成功，账本仍为 uncertain，重复通知不再注入。

旧覆盖点对应的测试如下。历史样本由单元测试按所需字段构造，不启动手写假 Agent。

| 原覆盖点 | 当前测试或场景 |
|---|---|
| 初始化关闭自动重试、命令顺序、上下文路径 | 全部录制的严格出站比较；`TestPiConfiguredEnvironment` |
| 版本/RPC 使用授权 cwd、新建与恢复 | `symlinked_workspace` 的 RPC cwd；`TestPiSandboxUnreadableCallerCwd` 检查四次进程 cwd |
| settled 后结果、agent_end 不结算、Unicode 保留 | `simple`、`missing_settled`、`TestPiLFFraming`、`TestPiTextContentUnicode` |
| 等待子任务、provider 错误 | `deliver_idle`、`provider_error`、`quota_error` |
| abort ACK、clear_queue 顺序、并发输入拒绝 | `abort_missing_settled`、`interrupt_mid_tool` 的严格帧比较 |
| 迟到 settled、工具副作用未知、停止事实不由进程退出推断 | `interrupt_mid_tool`、`exit_mid_turn`、`TestPiStopStatusDoesNotInferSettlementFromExit` |
| 原生历史交付、精确 ID、工具角色、重复交付 | `deliver_idle`、`delivery_history_missing`、`TestPiHistoryConfirmationRequiresExactEnvelopeAndToolRole` |
| 恢复不 prompt、历史缺失拒绝 | `restore_load_only`、`restore_missing`、`restore_recall` |
| 历史身份/版本/cwd/截断/越界/符号链接校验 | `TestPiHistoryRejectsMismatchedOrEscapedFile` |
| 分页上限、顺序、原字段保留、游标、取消与缺失 | `TestPiUnifiedHistoryPagination`；原浏览器历史单测继续保留 |
| LF/CRLF、UTF-8 跨读取边界、U+2028/U+2029、未终止帧、超大帧 | `TestPiLFFraming`、`TestPiFrameLimit` |

Gateway 的 `TestBrowserSlowSubscriberDoesNotBlockNativeWorker` 使用同一 `simple` 转录，通过 `Replace` 把一条合法文本增量放大到 6 MiB，验证慢订阅者不阻塞 Worker、节点缓存有上限且中心不保存原生输出。Web `history.spec.ts` 也使用该转录，替换一条文本增量以带入随机恶意标记，并在节点历史文件构造渲染样本，继续检查脚本不执行、分页、断线补取、Worker 退出后的只读查询、缺失/离线反馈和中心隐私。两处都使用统一回放可执行文件及路径绑定，不再依赖 Pi 测试二进制的环境开关。
