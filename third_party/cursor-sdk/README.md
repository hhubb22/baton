# Cursor SDK

P0 打包检查使用 npm 公开发布的 `@cursor/sdk@1.0.35`。这里只保存来源和许可说明，SDK 与平台二进制通过隔离依赖目录安装，仓库不保存这些文件。

| 包 | 来源 | npm integrity |
|---|---|---|
| `@cursor/sdk@1.0.35` | `https://registry.npmjs.org/@cursor/sdk/-/sdk-1.0.35.tgz` | `sha512-CJQR4ocRFm74N1miSqSSrhWyEbvTRIJGyMfHQvZlcBIYzLMXCVPmb1bV82L4NJ8mG9TyvbckEjERjbnzpG5akQ==` |
| `@cursor/sdk-darwin-arm64@1.0.35` | npm 对应平台可选包 | `sha512-q9/y2NHTGnE0iwMfJ+FIHmj2gDGDRy45fH3rF3SAFGEGzM4xh726r64n6hH4OQYwKhcMqhqxbPGBpXHd5lRW4A==` |
| `@cursor/sdk-linux-arm64@1.0.35` | npm 对应平台可选包 | `sha512-AAx2DBqOc21kIwKuHRLl+4bCbuU7Su/BWY+TzXMgMsxAOHvLDGg7SGVvHOMV4ENczbOEcO4zc3XDbmQB4x3rdw==` |

[LICENSE.md](LICENSE.md) 原文来自主包的 `LICENSE.md`：版权归 Anysphere Inc.，使用受 [Cursor Terms of Service](https://cursor.com/terms-of-service) 约束。t3code 的 MIT 许可不适用于此 SDK。平台包的 `package.json` 同样声明 `SEE LICENSE IN LICENSE.md`，但此次取得的 darwin-arm64 平台包未附该文件；不能由打包检查推导出额外的再分发许可。正式分发应保留 SDK 许可及生产依赖各自要求的声明，并确认所用版本的分发条款。

SDK 主包声明 Node `>=22.13`，没有 install/postinstall 生命周期脚本。检查以 `npm install --ignore-scripts` 安装；不执行其发布、构建或下载脚本。主包生产依赖为 `@bufbuild/protobuf`、`@connectrpc/connect`、`@connectrpc/connect-web`、`@statsig/js-client` 和 `zod`，平台包版本均为 `1.0.35`。平台包内含 ripgrep、tree-sitter 与 Bash grammar 的 `.node` 扩展，以及该平台发布的 sandbox helper。

[`cursor-sea.mjs`](../../tools/ts-migration/cursor-sea.mjs) 比较默认入口 bundle、默认入口加平台目录、`/bundled` 入口、`/bundled` 入口加平台目录、完整 SDK 附带目录五个方案。esbuild 直接处理默认发布入口时会遍历其动态模块路径，报 `Could not resolve "vendor/cursor-sdk-shared/core-adapter.js"`、`./errors.js` 等错误；增加原生目录不会解决这些 JS 解析错误。公开 `/bundled` 入口能够构建，但在 Node SEA 启动时报 `ERR_UNKNOWN_BUILTIN_MODULE: bun:sqlite`。经验证的方案是把完整 SDK、生产依赖和当前平台包保留在可执行文件旁的 `node_modules`，通过 `createRequire` 从可执行文件所在目录加载。该结论限于这里验证的 esbuild 配置，未尝试定制 SDK 模块加载器或 SEA VFS。

macOS arm64 的全部上述加载检查通过；Linux arm64 的 SDK/store/tree-sitter/ripgrep 通过，但 sandbox helper 在 Debian 12（glibc 2.36）上报缺少 `GLIBC_2.39`，因此该组合的完整打包检查失败。Windows、Linux x64 未测。平台与耗时结果记录在 [迁移规格](../../specs/ts-migration/TECH.md#待验证与批准事项)。检查没有调用 `Agent.create`、`resume` 或 `send`，不证明认证、真实会话、进程树停止或 sandbox 策略可用。
