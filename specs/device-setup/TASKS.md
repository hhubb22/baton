# 任务清单：设备接入

依据：[PRODUCT.md](PRODUCT.md) DS-01～DS-23，[TECH.md](TECH.md)
确认：2026-10-27

部署配置 Schema 已在 `packages/protocol/src/deployment.ts`，各任务直接使用。

## T01 batond 使用部署配置并保存 CA

- 所属条目：DS-05、DS-06、DS-07、DS-11
- 阻塞于：无，可立即开始
- 交付：`batond register` 和 `up` 可显式指定中心地址与 CA，之后 `run`、`reauth` 和更新使用保存的 CA；客户端和服务所需的身份、状态与退出接口可用
- 依据：TECH.md「部署配置」「batond」中除 `batond service` 外的部分
- 验证：batond 包内单元测试与本地注册连接测试
- 状态：已完成

验收：

- [x] 部署配置回退、显式参数优先、已有身份不读部署配置，CA 保存与替换有单元测试
- [x] 持有 `daemon.lock` 时 `run` 输出 `daemon_running`；认证、拒绝和 stdin 关闭后状态文件与退出码正确

## T02 中心托管安装包，网页给出 CLI 下载与命令

- 所属条目：DS-01～DS-04、DS-12、DS-13
- 阻塞于：无，可立即开始；e2e 全链路在 T01 合入后补
- 交付：管理员配置下载目录和 CA 后，员工在注册对话框下载原始 CLI 包，按给出的命令注册；页面提供「在客户端中打开」
- 依据：TECH.md「中心：安装包托管」「网页」中注册对话框与接入链接部分
- 验证：server 单元与集成测试，web 单元测试
- 状态：待开始

验收：

- [ ] 下载字节与发布归档相同；不合格的包不进清单
- [ ] 清单与下载无需登录，Host 决定中心地址，未列出的文件名 404
- [ ] 注册对话框提供中心地址和注册命令，命令中不包含凭据

## T03 batond 安装为用户服务

- 所属条目：DS-08、DS-09、DS-10
- 阻塞于：无，可立即开始；`service status` 显示拒绝原因需要 T01 的状态文件
- 交付：`batond service install|uninstall|status` 在 macOS 安装 launchd 用户代理、在 Linux 安装 systemd 用户单元
- 依据：TECH.md「`batond service install|uninstall|status`」
- 验证：渲染与回滚用替身 runner 做单元测试；macOS launchd 已用开发 bundle 手动验证，Linux systemd 真机未验证
- 状态：已完成

验收：

- [x] plist 与 unit 内容、重复安装替换路径、命令失败后恢复原定义有单元测试
- [x] 本机 macOS 上 install → status → uninstall 手动跑通

## T04 桌面客户端接入个人电脑

- 所属条目：DS-14～DS-23
- 阻塞于：T01、T02
- 交付：macOS arm64 与 Windows x64 安装客户端，经接入链接确认中心，登录后点「接入这台电脑」即在线，托盘常驻、登录自启
- 依据：TECH.md「桌面客户端」与「网页」中的桌面模式
- 验证：链接解析、证书校验、进程监管的 Node 单元测试，web 桌面模式单元测试；打包与安装在两个平台手动验证
- 状态：桌面包、桥接、打包与网页桌面模式已实现；真实接入与 Windows 手动验证待完成

验收：

- [x] 非 https 源、非 CA 证书、其他 CA 签发的叶子被拒；非中心 host 不使用保存的 CA
- [x] 终止类失败不重启，退避与次数上限正确，退出时关闭 stdin
- [x] 网页通过桥接接入和重新认证本机，凭据不渲染，状态订阅与失败重试有单元测试
- [ ] `tools/package-desktop.mjs` 在本机产出 dmg 与 `.sha256`，安装后完成一次接入
