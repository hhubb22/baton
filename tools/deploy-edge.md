# edge-01 部署

`Deploy edge-01` 工作流把已发布 GitHub Release 的中心镜像和设备安装包部署到 `edge-01`，入口为 `https://baton.suupa.dev`。工作流使用受保护的 `production` environment，手动选择版本；发布版本和允许设备升级是两个独立操作。

只发布 CLI 和中心时，手动触发 `Release packages` 并将 `desktop` 设为 `false`；发布仍验证四个平台的 CLI 安装包。标签触发默认包含桌面安装包。

## 配置

- 仓库变量 `BATON_UPDATE_PUBLIC_KEYS`：与安装包内置公钥一致的 JSON 公钥列表。
- `production` secret `DEPLOY_KEY`：允许以 `ops` 登录 `2.29.124.38` 的 SSH 私钥。
- `production` secret `DEPLOY_KNOWN_HOSTS`：经管理员独立核对的 SSH 主机公钥记录。
- 部署任务通过自身具有 `packages: read` 权限的临时 `GITHUB_TOKEN` 拉取 GHCR 镜像。凭据存入本次部署的私有临时目录，任务退出后删除；服务器无需保存个人 GitHub Token。

服务器沿用 `/opt/services/baton/compose.yaml`、`.env`、`data/server` 和 `data/postgres`，部署用户须可通过 `sudo -n` 执行部署脚本。网关、域名、数据库用户和私密配置由服务器维护。工作流不修改其他服务。

## 更新过程

发布资产包含 `update-manifest.json`、清单列出的完整原始安装包和 feed，以及 `server-image.txt` 中固定到 SHA-256 digest 的中心镜像。工作流用预先配置的公钥验签，核对版本、所有文件大小和摘要，然后上传。

`tools/deploy-edge.sh` 使用独占锁，拉取镜像，将制品写入 `release-versions/<版本>` 目录。同版本重试要求全部制品字节一致。停止中心后，它把 PostgreSQL dump、中心身份目录、Compose 配置和私有 `.env` 保存到权限为 0700 的 `backups/deploy-*`，再生成 `compose.release.json`，用新镜像和同版本制品启动中心并等待健康检查。数据库和网关容器继续运行。

Compose 日常维护须包含覆盖文件：

```sh
cd /opt/services/baton
sudo docker compose -f compose.yaml -f compose.release.json ps
sudo docker compose -f compose.yaml -f compose.release.json logs --tail 100 baton-server
```

新版本启动失败时中心保持停止。迁移可能已经写入数据库，不能只切回旧镜像；管理员检查备份和迁移结果后，选择修复后向前部署，或在中心停止期间恢复数据库、身份目录及上一份 Compose 配置。部署不自动删除旧实验数据；首次建立正式基线时，可由管理员明确重建 Baton 数据库和设备身份，再重新接入设备。

macOS 正式自动更新需 Developer ID 签名；没有证书时可完成 CLI 和中心发布、本地更新测试，桌面正式签名安装仍需单独验证。
