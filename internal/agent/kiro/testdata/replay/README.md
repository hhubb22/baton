# Kiro ACP V3 录制转录

12 份转录来自 2026-10-19 的真实 Kiro CLI 2.32.0、ACP V3、macOS arm64。录制基线是 Baton b40e64a 与本 PR 的适配器工作区。普通场景使用账号最低倍率模型 qwen3-coder-next（0.05 Credit）；用户授权后，supplement_active 使用 gpt-5.6-sol（4.4 Credit）。provider_error 指定不存在的模型，验证配置错误路径。

规范化保留模型和工具输出，替换目录及运行标识，按原生 Session 筛选父会话。握手里的认证方法、日志位置，以及账号、MCP、steering、工具与命令目录通知按 Kiro 策略过滤，删除数量写入各转录头。Agent 发起的权限请求保留原始 ID，客户端响应严格匹配。主机名、用户名、邮箱、密钥和临时目录扫描未发现残留；提交前已逐场景检查模型文本、工具命令和路径占位符。原始录制只留本机临时目录，成功规范化时删除。

## 场景与覆盖

| 场景 | 真实观察 | 适配器与 Worker 回放 |
|---|---|---|
| simple | 一次 prompt 返回结构化结果 | prompt 响应前没有完成；重复任务输入不写第二次 |
| result_free_text | Qwen 返回自由文本 | Worker 拒绝将自由文本当作成功 |
| interrupt_idle | 已结束回合中止 | 与已有结算一致 |
| interrupt_mid_tool | 前台 Python 到达门控文件后 cancel | 权限响应、cancel 与 prompt 终态分开门控；ACK 无停止证据，晚到终态补报，用过工具时副作用未知 |
| interrupt_before_turn_started | 提交后立即 cancel | 原生身份保留，取消后的回合不交付完成结果 |
| deliver_idle | 空闲回合提交一次子结果 | Worker 的等待前置状态与交付信封由真实转录派生，精确 user 历史确认，输入代次升为 2，重复通知不重注入 |
| restore_load_only | 一次写入 count.txt，关闭后加载同一 ID | 只加载，无 prompt；额外覆盖 Worker 退出后浏览器读取原生历史 |
| restore_missing | 保存映射指向不存在的 ID | list 未找到即拒绝；不调用 load 或 new，Worker 保持待核实 |
| restore_recall | 加载后记住原消息标记，计数保持一次 | 适配器显式发送新的回忆输入；Worker 只回放加载段，恢复本身不发回忆输入 |
| provider_error | 不存在的模型被拒绝 | 配置错误不生成成功结果 |
| symlinked_workspace | 工作目录使用符号链接别名 | 原生 cwd 与保存映射使用规范目录 |
| supplement_active | Sol 在前台工具运行中接受补充输入 | cancel 后等待旧 prompt，再发一次补充；Worker 重复 operation_id 只查询原回执，旧结果不能完成新输入 |

`deliver_active` 不录制第二个活动 prompt：Kiro 的第二个 prompt 会打断原工具。活动员工补充输入的打断行为由 supplement_active 单独验证。

Sol 可能按任务协议坚持返回 JSON，使 result_free_text 无法产生反例；真实入口在这种情况下跳过该次反例录制。已提交的 Qwen 自由文本转录继续提供两层负向覆盖。

`kiroreplaytest.Cases` 从 simple 派生 crash_after_prompt 和 missing_prompt_response，只截断进程。后者保留模型输出及 turn_end，删除 prompt 响应，验证这些事件和 OS 退出均不能提供完成或停止证据。另以 deliver_idle 检查旧终态排队后接受补充输入的竞态。工具结果数组、成功退出码、持久回放的 `Output: ... Exit Code: ...` 格式与堵塞管道超时保留定向单元测试。

## 执行

```sh
go test ./internal/agent/kiro ./internal/session -run 'TestRecordedKiro|TestSupplementInvalidatesQueuedOldResult|TestKiroWorkerRecorded' -count=1
go test -race ./internal/agent/kiro ./internal/session ./internal/agent/replay
BATON_REAL_KIRO=1 BATON_REAL_KIRO_MODEL=gpt-5.6-sol \
  go test -v ./internal/gateway -run '^TestRealKiro$' -count=1 -timeout 30m
```

登录由 Kiro 自身管理，测试不复制或打印凭据。回放不调用模型；Linux、Windows 的回放结果只证明协议与 Worker 处理，真实模型支持范围以目标系统实测为准。
