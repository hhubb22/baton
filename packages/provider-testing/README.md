# Cursor SDK 回放

`@baton/provider-testing/cursor` 导出 `CursorAgentSdkReplayTranscript` schema、`decodeCursorAgentSdkReplayTranscript`、`readCursorAgentSdkReplayTranscript(pathOrUrl)` 和 `makeCursorAgentSdkReplayRunner(transcript)`。runner 的接口与 `@baton/providers/cursor` 相同，按顺序匹配出站操作，并保留原生 agent/run ID、delta 与终态。`runner.assertComplete` 检查全部录制条目已消费。

回放驱动抽取自 t3code `9828cad49f3e1ef4f9e037b3baaca19f4e4928fc` 的 `CursorAdapterV2.testkit.ts`，未引入 orchestrator。独立历史使用静态 `agent.messages.list` 帧；转录缺少该调用时会明确匹配失败。

`test/fixtures` 中保留六份原始 SDK 转录：simple、multi_turn、provider_thread_resume、turn_interrupt_mid_tool、tool_call_read_only、subagent。文件逐字节保留，来源及 SHA-256 见 [sources.json](../../third_party/t3code/sources.json)。转录只声明协议版本 `1`，没有记录生成时的精确 SDK 包版本；固定提交的 provider 依赖为 `@cursor/sdk@1.0.35`。

`src/cursor-sdk-replay.test.ts` 在原生 SDK 边界注入该回放 runner，再执行真实的 `makeCursorAgentSdkRunner`，比较全部出站调用、输入、回调及结果。中断按原始工具开始事件触发，恢复沿用录制的 native ID。消息内容、参数和成功响应均不修改。转录中的上游配置包括 agent retries 和 full access；这些测试验证原始封装与录制参数，Baton 策略差异由 providers 包内测试验证。

离线回放不启动模型、网络或原生工具；工具命令只作为录制字符串经过 SDK 边界。它不证明真实后台任务结束、跨进程恢复或进程树回收。

```sh
pnpm --filter @baton/provider-testing typecheck
pnpm --filter @baton/provider-testing test
```
