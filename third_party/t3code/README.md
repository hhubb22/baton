# t3code 来源与许可

来源仓库为 [pingdotgg/t3code](https://github.com/pingdotgg/t3code)，固定提交为 `9828cad49f3e1ef4f9e037b3baaca19f4e4928fc`。上游 MIT 许可和 `Copyright (c) 2026 T3 Tools Inc.` 保留在 [LICENSE](LICENSE)，三个本地包也携带该许可。

| 上游路径 | 本仓库路径 | 使用方式 |
|---|---|---|
| `packages/effect-acp/` | `packages/effect-acp/` | 保留目录与源码，调整包脚本和开发依赖以使用本仓库的 TypeScript、Vitest 和 ESLint |
| `packages/effect-codex-app-server/` | `packages/effect-codex-app-server/` | 保留目录与客户端源码，调整工具配置，固定 Codex 生成来源并重新生成 schema |
| `packages/shared/src/nodeSqliteClient.ts` | `packages/sqlite/src/index.ts` | 参考连接、SqlClient、串行事务和 SQLite 错误适配实现；使用 FULL 同步、逐次 prepare 和单连接，不引入上游 reader/checkpoint worker |

逐文件来源与引入时的 SHA-256 记录在 [sources.json](sources.json)。`kind=copy` 条目给出上游文件与本地文件的对应路径，`kind=derived` 标记 SQLite 实现的参考来源。Baton 新增的测试和许可文件不冒充上游文件。

两个上游包的运行时依赖只有 `effect`。catalog 将 `effect`、`@effect/platform-node`、`@effect/sql-pg`、`@effect/vitest`、生成器所用 `@effect/openapi-generator` 固定为 `4.0.6`。上游源码和测试使用自己的格式；本仓库的格式检查跳过这两个引入目录，生成器显式调用包内 Prettier ignore 文件。

## Codex schema 基线

上游生成脚本原先固定 `openai/codex` 提交 `687a119f0fcaace47e1f1abcc77cec6c813fd6da`。Baton 的生成脚本固定到官方 tag `rust-v0.162.1` 的提交 `092d3acd6bec3e3a14bdc7e7a2810ab628ab759d`，从该提交的 `codex-rs/app-server-protocol/schema/{json,typescript}` 重新生成 `src/_generated/{schema,meta,namespaces}.gen.ts`。官方 Codex 的 Apache 2.0 许可和署名保留在 [CODEX-LICENSE](CODEX-LICENSE)、[CODEX-NOTICE](CODEX-NOTICE)；t3code 的 MIT 许可适用于引入的客户端与生成器代码。

兼容核查使用 Baton 现有 `internal/agent/codex/testdata/replay/*.ndjson` 中标记为 `agent_version=0.162.1` 的 9 个录制场景，提取 642 个成功响应及通知，保存为包内的 `test/fixtures/baton-codex-0.162.1.json`，避免依赖未来将删除的 Go 测试目录。夹具中每个条目保留原场景文件名与 label。`src/baton-compat.test.ts` 按生成方法表解码全部帧，覆盖 initialize、thread/start/read/resume、turn/start/steer/interrupt 及录制中的各类通知。

Go 的 `internal/agent/replay/normalize.go` 会删除 initialize 响应的 `platformFamily`、`platformOs`。这两个字段在官方 0.162.1 JSON Schema 中为必填，测试仅为这 10 个脱敏响应补上 `unix`、`macos`，其余 632 个帧按录制原文解码。原引入 schema 在这一处理后可解码上述全部帧；重新生成后的 schema 同样通过。该结论覆盖现有录制使用的协议，不代表所有 Codex API 或真实 Agent 场景已经验证。原有上游 26 项 Codex 测试继续运行。

生成器保留上游的 JSON Schema 规范化、引用转换与方法表生成逻辑，新增 `--source` 以直接读取本机固定提交的 `app-server-protocol` 目录，避免每个 schema 都请求 GitHub API。未传入时仍读取固定提交的 GitHub 文件。格式化命令使用 Prettier。

```sh
pnpm --filter effect-codex-app-server generate --source /absolute/path/to/codex/codex-rs/app-server-protocol
pnpm --filter effect-codex-app-server typecheck
pnpm --filter effect-codex-app-server test
```

`--source` 目录应来自上面固定的提交。重新生成并不调用模型，也不要求登录 Codex。
