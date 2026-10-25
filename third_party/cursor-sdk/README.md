# Cursor SDK

安装包使用 npm 公开发布的 `@cursor/sdk@1.0.35`。这里只保存来源和许可说明，SDK 与平台二进制从已安装依赖复制到可执行文件旁的 `node_modules`，仓库不保存这些文件。`package-batond.mjs` 随包复制本目录到 `licenses/cursor-sdk`，并保留各生产依赖的许可文件。

| 包 | 来源 | npm integrity |
|---|---|---|
| `@cursor/sdk@1.0.35` | `https://registry.npmjs.org/@cursor/sdk/-/sdk-1.0.35.tgz` | `sha512-CJQR4ocRFm74N1miSqSSrhWyEbvTRIJGyMfHQvZlcBIYzLMXCVPmb1bV82L4NJ8mG9TyvbckEjERjbnzpG5akQ==` |
| `@cursor/sdk-darwin-arm64@1.0.35` | npm 对应平台可选包 | `sha512-q9/y2NHTGnE0iwMfJ+FIHmj2gDGDRy45fH3rF3SAFGEGzM4xh726r64n6hH4OQYwKhcMqhqxbPGBpXHd5lRW4A==` |
| `@cursor/sdk-linux-arm64@1.0.35` | npm 对应平台可选包 | `sha512-AAx2DBqOc21kIwKuHRLl+4bCbuU7Su/BWY+TzXMgMsxAOHvLDGg7SGVvHOMV4ENczbOEcO4zc3XDbmQB4x3rdw==` |

[LICENSE.md](LICENSE.md) 原文来自主包的 `LICENSE.md`：版权归 Anysphere Inc.，使用受 [Cursor Terms of Service](https://cursor.com/terms-of-service) 约束。t3code 的 MIT 许可不适用于此 SDK。平台包的 `package.json` 同样声明 `SEE LICENSE IN LICENSE.md`，但此次取得的 darwin-arm64 平台包未附该文件；不能由打包检查推导出额外的再分发许可。正式分发应保留 SDK 许可及生产依赖各自要求的声明，并确认所用版本的分发条款。

SDK 主包声明 Node `>=22.13`，没有 install/postinstall 生命周期脚本。workspace 安装禁用生命周期脚本；SDK 与平台包从锁定依赖复制。主包生产依赖为 `@bufbuild/protobuf`、`@connectrpc/connect`、`@connectrpc/connect-web`、`@statsig/js-client` 和 `zod`，平台包版本均为 `1.0.35`。平台包内含 ripgrep、tree-sitter 与 Bash grammar 的 `.node` 扩展，以及该平台发布的 sandbox helper。

SEA 使用 `createRequire` 从可执行文件旁的 `node_modules` 加载完整 SDK、生产依赖与当前平台包。在已验证的 esbuild 配置下，默认发布入口的动态模块路径无法解析，公开 `/bundled` 入口在 Node SEA 中依赖不存在的 `bun:sqlite`。旁置方案保留这些 JavaScript 文件与平台资产；定制 SDK 模块加载器和 SEA VFS 尚未验证。

[`check-package.mjs`](../../tools/check-package.mjs) 检查搬迁后的安装包：SEA 的 `agent-host --probe` 加载四个 Agent 模块、keyring，并用 Cursor 的 tree-sitter/Bash 原生扩展实际解析命令；隔离的 Node 子进程从包内 `createRequire` 加载 `@cursor/sdk/sqlite`，打开并关闭临时 store；ripgrep `--version` 和 sandbox helper `--help` 直接执行包内程序。store 子进程使用运行工具的 Node 26，并禁用 fetch 和 HTTP(S) 请求。调用方式见 [安装包检查](../../tools/README.md#安装包检查)。

各系统的加载证据、测量结果与未验证项统一记录在 [发布设计](../../specs/release/TECH.md#cursor-加载证据)。Linux arm64 的 sandbox helper 要求 glibc 2.39+，Debian 12 / glibc 2.36 的该项检查失败。加载检查不调用 `Agent.create`、`resume` 或 `send`，仅凭 sandbox helper 的帮助输出也无法证明实际 sandbox 策略可用；认证、真实会话和进程树停止需分别验证。
