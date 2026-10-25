# 安装 Baton

中心部署、设备接入、订阅登录和配置命令统一见仓库 [README](https://github.com/hhubb22/baton/blob/main/README.md)。开发与验证入口见 [AGENTS.md](https://github.com/hhubb22/baton/blob/main/AGENTS.md#常用构建与验证命令)，发布产物、安装包检查与平台验证范围见 [发布设计](https://github.com/hhubb22/baton/blob/main/specs/release/TECH.md)。

设备安装包包含 `batond`（Windows 为 `batond.exe`）、旁置 `node_modules/`、产物清单和许可文件。Project Runtime 编入同一个 SEA 可执行文件，设备无需另装 Node 或 pnpm。选择对应系统与 CPU 架构的完整安装包，解压后保留其目录布局；Pi、Codex、Kiro 的原生程序及认证由设备用户配置。

发布附件的 `.sha256` 文件用于核对归档完整性，`release.json` 记录版本、源码提交和目标平台。核对源码提交后可查看对应版本的仓库说明。

升级时停止运行中的程序，整体替换可执行文件、旁置依赖和许可。中心数据库、签名密钥、设备身份和 Runtime 订阅凭据分别保存在数据目录中，安装包不包含这些私有数据。实验室阶段使用当前数据库和账本结构，结构变化可能需要重建本地数据。
