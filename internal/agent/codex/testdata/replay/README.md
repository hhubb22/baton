# Codex 转录

`simple.ndjson` 由上一级人工样本 `replay.json` 的完成流程转写，包含版本探测、initialize、thread/start、turn/start 和 turn/completed。头部 `source` 明确标记为手写样本转写，`platform` 为 synthetic，`recorded_at` 为空。模型输出沿用原样本，Agent 标识固定为 thread-1、turn-1；适配器请求 id 和输入操作标识通过捕获保存，目录通过运行时绑定提供。

该转录用于验证转录工具链和真实 Codex 适配器的进程边界。`TestTranscriptReplaySimple` 在完成事件之前设门，检查尚未得到最终结果，放行后检查结构化结果。它不调用模型。

PS-172 只交付此完成场景。其余场景和真实录制在后续工单实施；现有手写假 Agent 和测试保持原样，迁移由 PS-176、PS-177 负责。格式、状态文件、门控与派生变体的使用方法见 [工具说明](../../../../../tools/agent-replay/README.md)。
