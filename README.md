# Baton

Baton 是跨设备 AI Agent 协同系统。员工使用管理员分配的本地账号登录中心服务，注册并管理自己的设备，在指定设备和目录中使用 Cursor、Pi、Codex、Kiro、Antigravity、Droid Thread，也可以通过 Project Agent 主对话协调多个 Thread。中心保存输入、回复、附件引用和记忆；原生会话与模型凭据保存在设备上。

目录职责见 [Agent Guide](AGENTS.md#核心架构与目录)，领域名词见 [术语表](GLOSSARY.md)，执行与恢复机制见 [技术设计](specs/baton/TECH.md)。

## 环境要求

- 官方 Node.js 26+、pnpm 12+，用于工作区开发和构建。SEA 打包要求 Node 支持 `--build-sea`，并保留官方归档中的 LICENSE。
- PostgreSQL 16+ 与 pgvector 0.5+，用于中心数据与本地集成测试。macOS 可用 `brew install pgvector`，容器可用 `pgvector/pgvector:pg16` 镜像。
- Agent 所需原生 CLI 或 SDK 及设备本地认证。Cursor 使用显式配置的 `CURSOR_API_KEY`；Pi、Codex、Kiro 使用原生 CLI 配置。

## 构建与运行

首次检出后，在仓库根目录运行：

```sh
git submodule update --init
pnpm install --frozen-lockfile --ignore-scripts
node tools/build.mjs
```

统一构建从根 workspace 按锁文件安装依赖，构建中心和节点 bundle，再生成 `bin/` 中当前平台的 batond SEA 安装包。安装包包含 `batond`（Windows 为 `batond.exe`）、旁置 `node_modules/`、许可、安装说明、`package-manifest.json` 和 `release.json`。设备运行无需安装 Node 或 pnpm，须保留整个安装目录。安装包检查会搬迁产物，在空 PATH 和临时 HOME 下验证 Worker、Agent host、Project Runtime、私有文件及缺失依赖的错误。

中心和节点 bundle 分别位于 `apps/server/dist` 与 `apps/batond/dist`。中心构建生成 `server.cjs`、相邻的 `web/` 和 `migrations/`；启动时须保留这三个部分。设备运行 SEA 时须保留整个安装目录。单独构建与打包的参数见 [工具说明](tools/README.md)，发布布局和验证范围见 [发布设计](specs/release/TECH.md)。产物不提交 Git。

### 中心服务与员工账号

先建立 PostgreSQL 数据库并安装 pgvector。迁移在 `public` 执行 `CREATE EXTENSION IF NOT EXISTS vector`；连接用户没有建扩展权限时，由管理员先在该库执行这条语句。然后在仓库根目录配置连接和公开 HTTPS Origin：

```sh
export BATON_DATABASE_URL='postgres://用户:口令@127.0.0.1:5432/baton?sslmode=disable'
export BATON_ALLOWED_ORIGINS='https://baton.example'
node apps/server/dist/server.cjs admin employee create --username alice --display-name Alice
node apps/server/dist/server.cjs serve
```

账号创建命令输出一次性口令，员工首次登录后须修改口令并重新登录。重置口令使用 `node apps/server/dist/server.cjs admin employee reset-password --username alice`。`serve`、账号管理、`migrate` 和恢复后处理都先执行并核对迁移，`migrate` 完成后退出。

中心默认监听 `127.0.0.1:8080`，由支持 WebSocket 的 HTTPS 反向代理接入；直接 HTTPS 可同时配置 `BATON_TLS_CERT_FILE` 和 `BATON_TLS_KEY_FILE`。签名密钥默认保存在工作目录的 `node-signing.key`，可用 `BATON_NODE_SIGNING_KEY` 指定。文件不存在时生成 `0600` Ed25519 私钥，已有文件校验类型、权限、所有者与内容；Windows 不校验权限位和所有者，依赖目录继承的 ACL。部署时须持久保存数据库和密钥。

中心数据库恢复旧备份后，在停服状态下显式运行 `node apps/server/dist/server.cjs admin restore-finalize`，再启动 `serve`。该命令要求配套的原签名密钥，注销旧浏览器会话、使待确认的设备码会话过期、暂停旧命令派发并将不确定输入和运行标为未知或 lost，Project 保持暂停。未吊销的长效设备凭据与原有吊销事实保留；设备重连并重新同步后恢复可用，未决命令不自动重发。备份材料、数据回退影响、格式兼容检查和操作步骤见 [备份与恢复](specs/release/TECH.md#备份与恢复)。

也可用容器部署中心。根目录的 `Dockerfile` 以 `node:26-bookworm-slim` 构建中心 bundle，由非 root 的 `baton` 用户在 `/var/lib/baton` 运行，签名密钥保存在该目录。`compose.yaml` 同时启动带 pgvector 的 PostgreSQL 16，须设置 `BATON_POSTGRES_PASSWORD` 与 `BATON_ALLOWED_ORIGINS`；中心默认映射到 `127.0.0.1:8080`，可用 `BATON_BIND_ADDR` 和 `BATON_PORT` 修改。账号管理通过 `docker compose exec baton-server node /opt/baton/server.cjs admin employee create …` 执行。

实验室阶段使用当前 schema 基线，结构变化后可重建本地数据。迁移按版本记录幂等执行，正式发布后可用于增量迁移。证书须匹配访问主机名，并由系统根证书库信任。反向代理同时转发普通 HTTP 请求及 `/v1/node`、`/api/v1/events` 的 WebSocket 升级。

### 安装包下载

中心可通过 `BATON_DOWNLOADS_DIR` 托管发布安装包；每个包旁须有同名 `.sha256` 文件。支持的文件名为：

- CLI：`baton-<版本>-<darwin-arm64|linux-x64|linux-arm64>.tar.gz`。
- 桌面客户端：`baton-desktop-<版本>-darwin-arm64.dmg`、`baton-desktop-<版本>-win32-x64.exe`。

```sh
export BATON_DOWNLOADS_DIR='/srv/baton/releases'
node apps/server/dist/server.cjs serve
```

中心核对同版本安装包的 SHA-256 后原样提供；接入链接只传递 HTTPS 中心地址，不包含证书或秘密。Windows 下载清单只展示桌面客户端。

`GET /api/v1/downloads` 与 `GET /downloads/<文件名>` 无需登录；未配置目录时清单返回 `enabled: false`。反向代理须转发 `/downloads/`，并保留浏览器请求的 Host，使中心能从 `BATON_ALLOWED_ORIGINS` 选择对应的 HTTPS 源。Host 无匹配时不生成接入链接，安装包仍可下载。

网页添加设备弹窗按平台展示下载链接、版本、大小、SHA-256 与无秘密的登录和用户服务命令；Windows 引导下载桌面客户端。Devices 页面提供「在客户端中打开」接入链接。

### 设备接入

在 macOS 或 Linux 安装包目录运行：

```sh
./batond login --coordinator https://baton.example
./batond status
./batond service install
```

登录命令按需拉起本机唯一的后台守护进程，展示验证网址、短验证码和有效期；有图形环境时打开浏览器。员工在已登录的 `/device-login` 页面核对设备名称、系统和短码，确认后设备自动保存身份并连接中心。登录会话有效期为 10 分钟；过期、拒绝或取消后可重新发起。Ctrl-C 只退出终端等待，取消后台登录使用 `batond login --cancel`。

已有同中心身份时直接复用；跨中心或凭据已吊销时先执行 `batond logout` 再登录。登出断开中心、停止本机活动执行并清除绑定，保留账本、目录配置和模型凭据。重新绑定后，旧绑定的任务、待发送报告与输出保持隔离，不自动执行或发往新中心。设备连接使用系统根证书库验证 HTTPS / WSS，不需要导入应用私有 CA。设备连接凭据长期有效，直至显式吊销。

默认数据目录为 `~/.baton/data`，各命令可指定相同的 `--data-dir`。CLI 与本地客户端共享受令牌保护的控制通道；`status` 查询未绑定、等待确认、连接中、同步中、在线或已拒绝状态，协议不兼容或凭据已吊销时停止自动重连并保留原因。首次登录且目录配置不存在时开放用户主目录，已有配置（含空列表）保留。目录可在新建对话的选目录弹窗或通过本机 `files` 命令维护。

macOS / Linux 的 `service install` 将守护进程交给当前用户的 launchd / systemd 服务：先正常停止已有后台实例，再接管启动。`service status` 显示是否安装、运行状态、程序路径与日志路径；`service uninstall` 停止并移除服务，保留本地数据。重复安装使用当前程序路径；系统命令失败时恢复原服务定义。Linux 要求可用的 systemd 用户实例与 `XDG_RUNTIME_DIR`，未开启 linger 时注销将停止服务。Windows 不支持 CLI 用户服务。

macOS 与 Linux 的安装包解压后运行一次 `./batond install`，之后可以删除解压目录，在任意位置使用 `batond`。安装后的文件都在 `~/.baton`：`data/` 放身份、Thread 数据和订阅凭据，`program/` 放程序，`backups/` 放升级备份；命令入口是 `~/.local/bin/batond`，该目录不在 PATH 时命令会提示。每次更新完成后只保留当前版本和用于回滚的上一版。

`batond doctor` 输出版本、各目录位置和占用空间、服务状态，并提示旧目录和数据目录不一致等问题。`batond uninstall` 停止服务并删除程序和命令入口，保留数据和备份；加 `--purge` 同时删除数据（含订阅凭据）和备份。

指定 `--data-dir` 时，程序放在该目录的 `installation/`，备份放在同级的 `<目录>.upgrade-backups`，一台机器上可以这样运行多份互不影响的安装。

Linux 需要有效的 `XDG_RUNTIME_DIR` 和 systemd 用户实例；`status` 还显示 linger 状态，未开启时提示管理员为需要注销后保持运行的用户开启 linger。Windows 使用桌面客户端，不支持 CLI 用户服务。

六个 Agent 在程序或 SDK 已安装且认证有效或未知时报告 `available`，按上游 adapter 与已实现的执行路径开放新建与恢复。版本、系统与认证未知写入诊断，缺少某个组合的验证证据不会关闭能力。缺程序、明确未认证或已确认运行依赖失败时报告 `unavailable`。探测只检查认证、模型和依赖，不发送推理请求。

### 桌面客户端

`apps/desktop` 提供 macOS arm64 和 Windows x64 客户端，内置 batond。首次启动显示本地说明页，收到 `baton://connect` 接入链接后显示中心地址与 CA 指纹，经确认才保存并打开中心页面。已有同一中心的 CLI 身份直接沿用，已有外部 daemon 时显示由外部服务运行。

客户端关闭窗口后留在托盘，默认登录启动，可从托盘关闭该选项或退出。数据目录与 CLI 共用 `~/.baton/data`，替换应用保留身份与配置。Devices 页面的「Open in desktop app」生成接入链接；客户端桥接、构建和验证范围见 [桌面客户端文档](apps/desktop/README.md)，DMG/NSIS 打包见 [工具说明](tools/README.md#桌面客户端)。

### 设备升级

设备从已配置中心读取签名发布清单并在后台预下载。首次安装使用发布构建内的可信公钥，或由设备操作者明确配置本地公钥；中心下载响应不能添加信任根。设备详情可发起更新，离线请求在设备重新连接后处理。本地命令如下：

```sh
batond update --data-dir /原数据目录
batond update status --data-dir /原数据目录
batond update policy manual --data-dir /原数据目录
```

默认等待正在运行的任务结束；`update policy idle` 允许设备空闲时自动更新，迁移前可用 `batond update cancel` 取消。桌面客户端使用「更新并重启」。升级前设备生成一致备份，目标版本使用独立目录和固定启动入口；断线后继续等待中心，结果补报并确认完成后恢复队列。

登出重绑后保留的旧任务和未确认报告仍会被现有更新就绪检查计入阻塞；可先停止守护进程并覆盖安装。旧更新链路的清理由发布切片处理，旧绑定数据继续保留。

正式发布基线之前的本地实验数据可重建。备份、失败恢复与验证范围见 [设备准备与切换](specs/release/TECH.md#设备准备与切换)。

### Project 与模型订阅

网页可管理 Project 主对话、记忆与历史版本、目录授权、附件预览及本机命令执行开关。Project 使用设备本地的 ChatGPT、xAI 或 Claude 配置，按租约启动独立 Runtime；本机执行开关默认关闭，`nodes.exec` 创建独立 Execution 执行命令，Project 可查看执行详情、停止命令和读取完整输出。

设备详情按 Runtime 报告的登录方式显示入口。ChatGPT 和 xAI 支持设备码登录，凭据保存在设备上，完成后立即刷新报告。终端登录和状态查询可使用：

```sh
node apps/batond/dist/batond.cjs login openai-codex
node apps/batond/dist/batond.cjs subscriptions
node apps/batond/dist/batond.cjs project-runtime connection-key <连接 ID> < key-file
```

在设备详情新增 API 连接并填写模型 ID 后，在目标设备使用 `connection-key` 从私有文件经标准输入保存密钥。桌面客户端可在本机直接填写；中心只接收连接元数据。密钥为非空单行文本，最多 16 KiB。配置保存不代表在线验证成功。

`login` 接受 provider ID 及 ChatGPT、xAI、Claude 别名，由 Runtime 注册表决定支持范围。Runtime 当前注册 `openai-codex`、`xai`、`anthropic`。登录和守护进程须使用同一系统用户及凭据目录；这些凭据独立于执行 Agent 的原生 CLI 账号。开发 bundle 的 Runtime 使用同一 bundle 的子命令及构建身份，安装包入口见 [发布设计](specs/release/TECH.md)。

## 配置参考

| 环境变量 | 适用进程 | 说明 |
|---|---|---|
| `BATON_DATABASE_URL` | 中心 | PostgreSQL 连接串 |
| `BATON_DB_SCHEMA` | 中心 | 数据库 schema，默认 `public`；自定义 schema 须先创建，名称以小写字母开头，只含小写字母、数字、下划线，最长 63 字符 |
| `BATON_HTTP_ADDR` | 中心 | HTTP/WebSocket 监听地址，默认 `127.0.0.1:8080` |
| `BATON_ALLOWED_ORIGINS` | 中心 | 逗号分隔的允许 HTTPS Origin，`serve` 必填 |
| `BATON_TRUSTED_PROXY_CIDRS` | 中心 | 可信反向代理的 CIDR 列表，以逗号分隔；默认不信任转发地址 |
| `BATON_NODE_SIGNING_KEY` | 中心 | Ed25519 私钥路径，默认工作目录下的 `node-signing.key` |
| `BATON_TLS_CERT_FILE` / `BATON_TLS_KEY_FILE` | 中心 | 直接提供 HTTPS/WSS 时的证书与私钥 |
| `BATON_WEB_DIR` | 中心 | 网页目录，默认 bundle 旁的 `web/` |
| `BATON_DOWNLOADS_DIR` | 中心 | 发布安装包与同名 `.sha256` 所在目录；未配置时不提供下载 |
| `BATON_SESSION_TTL` | 中心 | 浏览器会话期限，默认 `12h`，范围 5 分钟至 7 天 |
| `BATON_ENROLLMENT_TTL` | 中心 | 一次性注册凭据期限，默认 `10m`，范围 1 分钟至 24 小时 |
| `BATON_HEARTBEAT_INTERVAL` | 中心 | 连接检查间隔，默认 `10s`，范围 100 ms 至 2 分钟 |
| `BATON_OFFLINE_AFTER` | 中心 | 设备离线期限，默认 `30s`，范围 200 ms 至 10 分钟，须大于心跳间隔 |
| `BATON_PROJECT_RUNTIME_DATA_DIR` | 节点 / Runtime | 模型凭据目录，默认 `~/.baton/data/credentials` |

控制操作预算、临时 RPC 名额和 OTLP 追踪配置见 [中心文档](apps/server/README.md)。遥测后端地址和 key 配置在中心，节点与网页经中心转发；设备本地可单独配置 OTLP 用于排查。

## 本地开发与测试

开发、验证命令和测试数据库配置集中在 [AGENTS.md](AGENTS.md#常用构建与验证命令)。脚本参数见 [工具说明](tools/README.md)。适配器与 Runtime 使用离线转录和本地替身，回放范围见 [回放测试设计](specs/agent-replay/TECH.md)。网页开发与模拟场景见 [Web 文档](web/README.md)。

## 规格与设计文档

- 界面文案：[web/WRITING.md](web/WRITING.md)
- 全局规格：[PRODUCT](specs/baton/PRODUCT.md)、[TECH](specs/baton/TECH.md)
- Agent 适配：[PRODUCT](specs/agent-adapters/PRODUCT.md)、[TECH](specs/agent-adapters/TECH.md)
- Project Agent：[PRODUCT](specs/project-agent/PRODUCT.md)、[TECH](specs/project-agent/TECH.md)
- Project 长期记忆草案：[PRODUCT](specs/project-memory/PRODUCT.md)、[TECH](specs/project-memory/TECH.md)
- 上游转录与回放：[TECH](specs/agent-replay/TECH.md)
- 术语与代码命名：[GLOSSARY](GLOSSARY.md)
- 目录与验证入口：[AGENTS](AGENTS.md)
- 打包、发布与升级：[PRODUCT](specs/release/PRODUCT.md)、[TECH](specs/release/TECH.md)
- 追踪、日志、指标与排障：[TECH](specs/observability/TECH.md)
- 工具参数：[tools/README](tools/README.md)
