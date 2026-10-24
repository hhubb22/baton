# Cursor provider runtime

本包从 t3code `9828cad49f3e1ef4f9e037b3baaca19f4e4928fc` 抽取 Cursor SDK runner、异常处理与消息正文读取。来源、完整 provider 尝试和验证范围见 [来源记录](../../third_party/t3code/README.md#cursor-sdk-复用)。生产依赖为 `effect` 和 `@cursor/sdk@1.0.35`。

`@baton/providers/cursor` 不加载 SDK，导出：

- `makeBatonCursorAgentSdkRunner(loggerFor?)`：返回 Effect，环境需要 `CursorSdk`。使用显式 API key、本地 runtime、`autoReview: true`、sandbox 开启、`enableAgentRetries: false`。关闭与取消幂等，wait 缓存运行结果。
- `makeCursorAgentSdkRunner(loggerFor)`：保留上游参数与日志形状的底层 runner，供原始转录使用；同样移除了冲突后的取消与重发。
- `CursorAgentSdkRunner` Effect service、`CursorAgentSdkRunnerError` 和 runner/session/run/input/history/log 类型。
- `CursorSdk` service、`layerWithSdk`，以及 `ThreadId`、`ProviderSessionId` 构造器。
- `inspectCursorSdk()`：静态读取实际 SDK/平台版本、Node 要求、entry/packageRoot、helper/rg/tree-sitter 路径与 `missingAssets`，不加载 SDK 或执行 helper。
- `textFromAgentMessage(message)`、`textFromInteractionUpdate(update)`；后者只提取 `text-delta` 正文。完整 delta 仍为 SDK `InteractionUpdate`。
- SDK 的 `AgentOptions`、`AgentMessage`、`RunResult`、`SendOptions`、`SDKUserMessage`、`LocalAgentStore` 等实际类型。

`@baton/providers/cursor/sdk` 是运行入口，导出 `CursorSdk` 和 `layer`。service 包含真实的 `Agent`、`createAgentPlatform`、`SqliteLocalAgentStore`。仅在 cursor-host 内动态导入它。`/cursor/sdk-loader` 保留底层 SDK 导出，通过 `node:sea.isSea()` 选择 `createRequire(join(dirname(process.execPath), 'package.json'))` 或源码的 `createRequire(import.meta.url)`，要求磁盘上存在完整 SDK、依赖、chunks 和平台资产。

```ts
import * as Effect from 'effect/Effect'
import {
  makeBatonCursorAgentSdkRunner, ThreadId, ProviderSessionId,
} from '@baton/providers/cursor'

const { CursorSdk, layer } = await import('@baton/providers/cursor/sdk')

const program = Effect.gen(function* () {
  const { SqliteLocalAgentStore } = yield* CursorSdk
  const store = yield* Effect.acquireRelease(
    Effect.tryPromise(() => SqliteLocalAgentStore.open({
      workspaceRef: cwd,
      stateRoot: privateStateDirectory,
    })),
    store => Effect.promise(() => store.dispose()),
  )
  const runner = yield* makeBatonCursorAgentSdkRunner()
  const session = yield* runner.open({
    operation: 'create', // Resume uses operation: 'resume' and agentId.
    options: { apiKey, model: { id: modelId ?? 'default' }, local: { cwd, store, settingSources: [] }, mcpServers: {} },
    threadId: ThreadId.make(threadId),
    providerSessionId: ProviderSessionId.make(providerSessionId),
  })
  yield* Effect.addFinalizer(() => session.close.pipe(Effect.ignore))
  const run = yield* session.send({
    message: 'User input',
    onDelta: update => consumeDelta(update),
  })
  // The run handle alone is not evidence that the native history contains input.
  const result = yield* run.wait
  const messages = yield* runner.listMessages(session.agentId, { cwd, store })
  return { result, messages }
}).pipe(Effect.scoped, Effect.provide(layer))
```

runner 接口为：

```ts
runner.open(input): Effect<CursorAgentSdkSession, CursorAgentSdkRunnerError>
runner.listMessages(nativeId, { cwd, store? }): Effect<ReadonlyArray<AgentMessage>, CursorAgentSdkRunnerError>
runner.assertComplete: Effect<void, CursorAgentSdkRunnerError>
session.send({ message, options?, onDelta? }): Effect<CursorAgentSdkRun, CursorAgentSdkRunnerError>
session.listMessages: Effect<ReadonlyArray<AgentMessage>, CursorAgentSdkRunnerError>
session.close: Effect<void, CursorAgentSdkRunnerError>
run.wait: Effect<RunResult, CursorAgentSdkRunnerError>
run.cancel: Effect<void, CursorAgentSdkRunnerError>
```

独立历史只调用 `Agent.messages.list(nativeId, {runtime: 'local', cwd, store})`。session 历史使用 open 的同一 store。store 是公开 `LocalAgentStore` 对象；`SqliteLocalAgentStore.open` 接收 `workspaceRef` 和 `stateRoot`，没有公开的单个数据库文件 `storePath` 参数。销毁顺序为 session close、store dispose。独立历史进程可以用同一 workspaceRef/stateRoot 重新打开 store。

cancel 完成只表示取消请求结束；wait 仍等待 SDK 终态，失败则保留失败。句柄建立前与之后的待处理 delta 均限制为 256，超限以 `run.onDelta` 失败传播。超时、中断调用或 close 均不能作为整个进程树已停止的证据。Worker 的持久输入证据、事件归属、停止预算与进程回收由宿主实现。

离线测试覆盖 SDK runner、原上游异常处理、关闭 SDK 重试和取消后等待原生终态；原生 store、独立历史与跨进程恢复通过显式的 `tools/ts-migration/verify-cursor.mjs` 验证。SDK 1.0.35 的真实多轮、非空独立历史、取消、Worker 崩溃回收及恢复后执行已在 macOS arm64 验证；支持矩阵和复现入口见 [本地 Thread 文档](../../apps/batond/README.md)。离线转录自身不扩大平台支持范围。
