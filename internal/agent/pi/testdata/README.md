# Pi 回放数据

`replay/*.ndjson` 来自 2026-10-19 在 macOS 上对 Pi 1.3.0 / `google-vertex/gemini-3.1-flash-lite` 的真实录制，包含出站请求、入站事件、原生历史追加与退出记录。来源、场景和限制见 [场景说明](replay/README.md)。CI 用这些转录驱动真实 Pi 适配器和 `RunWorker`，不访问模型。

规范化保留模型和工具输出；任务文本与系统提示按规则使用 `<any>`，路径使用 `transcript_start.bindings` 声明的绑定，运行时标识使用捕获占位符。只替换声明的绑定名，Pi 系统提示中的 `<tools>`、`<rules>` 等文本保持原样。Linux、macOS、Windows 使用各自的临时目录；绑定绝对路径的分隔符按当前系统比较。

进程崩溃、缺失 settled 和配额错误由测试中的 `CutAfter`、`Drop`、`Replace` 派生，不另存伪造场景。分帧、超大帧、Unicode 分隔符、历史校验与分页保留为纯单元测试。回放通过只证明适配器能处理这些已录制的序列；真实 Agent 的版本、平台和模型结论以录制说明为准。

录制与规范化工具见 [使用说明](../../../../tools/agent-replay/README.md) 和 [回放设计](../../../../specs/agent-replay/TECH.md)。Agent 升级或出站请求变化后应重录并审查转录差异；原始录制仅在仓库外临时保存，规范化和残留扫描后删除。
