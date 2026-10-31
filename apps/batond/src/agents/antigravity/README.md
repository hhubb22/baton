# Antigravity 接入

host 使用 fork `packages/provider-antigravity` 的 `makeAntigravityAdapterV2`，从 PATH 查找 `agy` 并启动 `agy acp`，沿用设备上 `agy` 已有的登录。不启动 Google 托管运行时，也不发起 `authenticate` 或打开登录浏览器；未登录时由用户在设备上运行 `agy` 完成。

## 能力

新建、排队、停止和恢复都已开放，Thread 内可逐轮换模型，不支持插入消息（上游 adapter 没有 steer）。恢复使用 `session/resume`，不重放历史。思考档位是 ACP 配置项 `thought_level`，发消息时通过 `session/set_config_option` 设置。

## 权限

原生 `agy acp` 不报告 mode，并对 `session/set_mode` 返回 `-32601`，因此 host 在会话没有 mode 时跳过这一步。权限改由 ACP 客户端决定：`agy` 对每次工具调用发 `session/request_permission`，`approval-required` 转给网页等待回答，其他模式由客户端策略自动放行。`agy` 自己的 sandbox 不启用，这些模式都不提供系统隔离。

## 探测

探测建立一次空会话读取 `model` 和 `thought_level`，不发送 prompt，20 秒超时。错误信息明确表示未登录时报告认证 `missing`，其他失败报告 `unknown` 并允许新建。版本来自 `agy --version`。登录状态的变化通过 `~/.gemini/jetski-standalone-oauth-token` 的文件元数据触发重新探测，不读取其内容。

## 验证范围

离线回放 `src/testing/antigravity/approved-turn.ndjson` 录自 macOS arm64 上的 `agy` 1.4.12，账号档位信息已移除，覆盖探测、新建和审批通过后完成一轮。同版本的真实程序另外手动验证过恢复后的上下文记忆、`full-access` 直接执行和审批未回答时不执行。未登录时 `agy` 的实际报错、Windows 和 Linux 尚未验证。
