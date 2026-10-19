# Codex 转录

`synthetic_simple.ndjson` 由上一级人工样本 `replay.json` 的完成流程转写，包含版本探测、initialize、thread/start、turn/start 和 turn/completed。头部 `source` 明确标记为手写样本转写，`platform` 为 synthetic，`recorded_at` 为空。模型输出沿用原样本，Agent 标识固定为 thread-1、turn-1；适配器请求 id 和输入操作标识通过捕获保存，目录通过运行时绑定提供。

该转录用于验证转录工具链和真实 Codex 适配器的进程边界。`TestTranscriptReplaySimple` 在完成事件之前设门，检查尚未得到最终结果，放行后检查结构化结果。它不调用模型。

PS-172 交付此合成完成场景。首批真实录制由 PS-175 在用户本机生成；现有手写假 Agent 和测试保持原样，迁移由 PS-176、PS-177 负责。格式、状态文件、门控与派生变体的使用方法见 [工具说明](../../../../../tools/agent-replay/README.md)。


## 真实场景入口

`TestRealCodex/<scenario>` 为每个场景创建独立的 app-server、工作目录和原生 thread，使用一次性、独立认证的 CODEX_HOME。设置 `BATON_RECORD_DIR` 后写入其 `codex/` 子目录；本机流程见 [主 README](../../../../../README.md#本机录制与规范化)。本目录其余 `*.ndjson` 是 2026-10-19 在 Baton 9c11002 上录制的首批真实转录：Codex 0.162.1，darwin/arm64，模型 `gpt-6-luna`，单份 1.7～61 KB。首轮提交了通过的 9 个场景：`simple`、`interrupt_idle`、`interrupt_mid_tool`、`deliver_active`、`deliver_idle`、`restore_load_only`、`restore_missing`、`provider_error`、`symlinked_workspace`。

首轮有两个失败场景：

- `interrupt_before_turn_started`：`turn/start` 返回后约 1 毫秒发出 `turn/interrupt`，此时回合的 `startedAt` 还是 null，Codex 返回 `-32600 no active turn to interrupt`。适配器把这个错误直接返回，回合开始后不会再中止，早到的取消因此丢失。这是适配器缺陷，修复后重录。
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
