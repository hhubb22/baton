#!/usr/bin/env bash
# 准备 Go 模块、前端依赖和 Playwright Chromium。每次环境构建都会执行，重复执行无副作用。
set -euxo pipefail

id -un
go version
node --version
pnpm --version

go mod download
cd web
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
