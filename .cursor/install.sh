#!/usr/bin/env bash
# 准备 Go 模块和前端依赖。Chromium 已装在镜像的 /opt/ms-playwright。每次环境构建都会执行，重复执行无副作用。
set -euxo pipefail

. /etc/profile.d/baton.sh

id -un
go version
node --version
pnpm --version

go mod download
cd web
pnpm install --frozen-lockfile

# install 以 root 运行时，Agent 可能用普通用户执行测试和构建，它们要写 node_modules 下的缓存。
if [ "$(id -u)" = 0 ]; then
  chmod -R a+rwX node_modules
fi
