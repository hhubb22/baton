# 安装 Baton

安装包包含 Coordinator、设备守护进程 batond 和 Project Agent Runtime。`release.json` 记录版本、源码提交及目标平台。

## 环境要求

- 设备运行 Project assistant 需要 Node.js 22.19.0 或更高版本，并能在终端中执行 `node`。目标设备无需 Go 或 pnpm。
- 部署 Coordinator 需要 PostgreSQL 16+ 和 HTTPS 配置。Coordinator 已嵌入网页，部署中心服务无需 Node.js。
- Pi、Codex、Kiro Thread 需要在对应设备上另行安装和配置相应 Agent 程序。

选择与系统及 CPU 架构对应的安装包：Linux x64、Apple Silicon Mac 或 Windows x64。保留 `batond` 与同目录的整个 `sidecars/`，包括依赖目录和链接。

## 校验安装包

发布附件同时提供 `.sha256` 文件。解压前，使用 `sha256sum -c 文件名.sha256`（Linux）、`shasum -a 256 -c 文件名.sha256`（macOS）或 PowerShell 的 `Get-FileHash -Algorithm SHA256 文件名.zip` 核对校验和。

## 连接设备

管理员先部署 Coordinator 并创建员工账号。用户登录 Baton 网页后，获取一次性设备注册凭据。在设备上解压安装包，打开终端进入解压目录。

### Linux 和 macOS

```sh
export BATON_ENROLLMENT_TOKEN='<网页提供的一次性设备注册凭据>'
./batond register --coordinator https://baton.example --display-name "Workstation" --system macos
unset BATON_ENROLLMENT_TOKEN

./batond login openai-codex
./batond subscriptions
./batond files add --id workspace --path /你的工作目录
./batond run --relay wss://baton.example/v1/node
```

Linux 注册时将 `--system macos` 换成 `--system linux`。服务地址及工作目录按实际配置填写。

### Windows

在 PowerShell 中执行：

```powershell
$env:BATON_ENROLLMENT_TOKEN = '<网页提供的一次性设备注册凭据>'
.\batond.exe register --coordinator https://baton.example --display-name "Workstation" --system windows
Remove-Item Env:BATON_ENROLLMENT_TOKEN

.\batond.exe login openai-codex
.\batond.exe subscriptions
.\batond.exe files add --id workspace --path 'C:\你的工作目录'
.\batond.exe run --relay wss://baton.example/v1/node
```

## 订阅登录

ChatGPT 使用 `openai-codex`，xAI 使用 `xai`。ChatGPT 登录支持浏览器和设备码两种方式；没有浏览器的设备可以选择设备码，在另一台电脑的浏览器中完成授权。Ctrl+C 取消登录。

使用运行 batond 的同一个系统用户登录。模型订阅凭据默认保存在用户主目录的 `.baton/project-runtime`，独立于 Pi、Codex CLI 的登录记录，不上传 Coordinator。若指定 `BATON_PROJECT_RUNTIME_DATA_DIR`，登录和运行守护进程须使用相同配置。

在线设备自动上报登录状态。回到网页，选择订阅和模型并创建 Project。`subscriptions` 只读取本地凭据状态，实际授权有效性由模型请求确认。

## 部署中心服务与升级

数据库迁移、账号管理和 HTTPS 配置见仓库 [README](https://github.com/hhubb22/baton/blob/main/README.md)。核对 `release.json` 中的提交，可查看该提交对应的文档。

Alpha 阶段数据库和设备账本结构可能变化，升级可能需要重建本地数据。升级前备份所需数据，停止正在运行的程序，再整体替换二进制和 `sidecars/`。本地账号、节点身份和模型订阅凭据位于各自的数据目录，不应放入安装包。
