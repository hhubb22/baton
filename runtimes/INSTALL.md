# 安装 Baton

设备安装包包含 `batond` SEA 可执行文件、旁置 `node_modules/` 和许可文件，Project Runtime 编入同一个可执行文件。中心服务通过 Node 镜像部署。`release.json` 记录版本、源码提交及目标平台。

## 环境要求

- 设备无需安装 Node.js 或 pnpm，须保留完整安装包中的运行时依赖。
- 部署中心服务需要 PostgreSQL 16+ 和 HTTPS 配置。Docker 镜像包含 Node 与网页，可使用 Docker Compose 部署中心服务和数据库。
- Pi、Codex、Kiro Thread 需要在对应设备上另行安装和配置相应 Agent 程序。

选择与系统及 CPU 架构对应的安装包：Linux x64、Linux arm64、Apple Silicon Mac 或 Windows x64。保留 `batond` 与同目录的整个 `node_modules/` 及许可文件。

## 校验安装包

发布附件同时提供 `.sha256` 文件。解压前，使用 `sha256sum -c 文件名.sha256`（Linux）、`shasum -a 256 -c 文件名.sha256`（macOS）或 PowerShell 的 `Get-FileHash -Algorithm SHA256 文件名.zip` 核对校验和。

## 连接设备

管理员先部署 `baton-server` 并创建员工账号。用户登录 Baton 网页后，获取一次性设备注册凭据。在设备上解压安装包，打开终端进入解压目录。

### Linux 和 macOS

```sh
BATON_ENROLLMENT_TOKEN='<网页提供的一次性设备注册凭据>' \
  ./batond up --coordinator https://baton.example
```

服务地址按实际配置填写。首次 `up` 完成注册并运行，尚无浏览目录配置时默认开放当前用户主目录；后续执行 `./batond up` 即可。显示名默认主机名，系统自动识别，可用 `--display-name` 和 `--system` 指定。

### Windows

在 PowerShell 中执行：

```powershell
$env:BATON_ENROLLMENT_TOKEN = '<网页提供的一次性设备注册凭据>'
try {
  .\batond.exe up --coordinator https://baton.example
} finally {
  Remove-Item Env:BATON_ENROLLMENT_TOKEN
}
```

后续执行 `.\batond.exe up` 复用本地身份。

连接后，在网页 Devices 展开这台在线设备，在 Allowed folders 中直接添加或移除目录；选目录弹窗也可输入路径后添加并选中。路径必须是设备上已经存在的绝对路径。已有浏览配置（包括空列表）会保留，重启不补回主目录；也可用 `--workspace /绝对路径` 在启动时登记指定目录。

也可使用 `batond register --coordinator https://baton.example` 单独注册，再用 `batond run` 连接。注册凭据来自 `BATON_ENROLLMENT_TOKEN` 或 `--enrollment-file`，注册会在 `identity.json` 保存 `coordinator_url`。`run` 自动推导 WSS 地址；可通过 `--relay wss://主机/v1/node` 指定，身份文件没有中心地址时需要该参数。指定 `--data-dir` 时，注册、运行和目录登记均使用同一目录。

## 订阅登录

在网页 Devices 展开在线设备，点击 `Sign in to ChatGPT` 或 `Sign in to xAI`。复制弹窗中的设备码，打开授权页并确认登录。设备报告已登录后，弹窗显示 `Signed in`，点击 `Done` 关闭。设备使用 `batond project-runtime` 运行包内的 Project Runtime。

终端也可登录：ChatGPT 使用 `batond login openai-codex`，xAI 使用 `batond login xai`。ChatGPT 支持浏览器和设备码两种方式；没有浏览器的设备可选择设备码，在另一台电脑的浏览器中完成授权。Ctrl+C 取消终端登录。

终端登录时，使用运行 batond 的同一个系统用户。模型订阅凭据默认保存在用户主目录的 `.baton/project-runtime`，独立于 Pi、Codex CLI 的登录记录，不上传 Coordinator。若指定 `BATON_PROJECT_RUNTIME_DATA_DIR`，登录和运行守护进程须使用相同配置。

在线设备自动上报登录状态。回到网页，选择订阅和模型并创建 Project。`subscriptions` 只读取本地凭据状态，实际授权有效性由模型请求确认。

## 部署中心服务与升级

`baton-server serve` 启动时自动执行迁移，并在工作目录生成缺失的 `node-signing.key`（`0600`）；`BATON_NODE_SIGNING_KEY` 可指定密钥路径。数据库和密钥须持久保存。`baton-server migrate` 可单独执行迁移，员工账号通过 `baton-server admin employee create` / `reset-password` 管理。

从源码仓库使用 Docker Compose 时，设置 `BATON_POSTGRES_PASSWORD` 与公开 HTTPS 地址 `BATON_ALLOWED_ORIGINS`，执行 `docker compose up -d --build`。Compose 持久保存 PostgreSQL 数据和 `/var/lib/baton`，默认将服务绑定到 `127.0.0.1:8080`，交给支持 WebSocket 的 HTTPS 反向代理。可执行 `docker compose exec baton-server baton-server admin employee create --username alice --display-name Alice` 创建员工账号。

数据库迁移、账号管理和 HTTPS 配置见仓库 [README](https://github.com/hhubb22/baton/blob/main/README.md)。核对 `release.json` 中的提交，可查看该提交对应的文档。

Alpha 阶段数据库和设备账本结构可能变化，升级可能需要重建本地数据。升级前备份所需数据，停止正在运行的程序，再整体替换可执行文件、`node_modules/` 和许可文件。本地账号、节点身份和模型订阅凭据位于各自的数据目录，不应放入安装包。
