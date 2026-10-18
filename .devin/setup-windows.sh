#!/usr/bin/env bash
# Devin Windows 快照的系统依赖：Go、PostgreSQL 17、1Password CLI。Web 检查只在 Linux 上跑，这里不装 Node.js 与 pnpm。
# 在 Git Bash 中由 blueprint 的 initialize 执行，重复执行无副作用。
# PostgreSQL 由安装包注册为 Windows 服务，postgres 用户口令为 baton，只用于本机测试。
set -euxo pipefail

choco install -y --no-progress golang op
choco install -y --no-progress postgresql17 --params '/Password:baton'

pg_bin='/c/Program Files/PostgreSQL/17/bin'
cat > "$HOME/.baton-env.sh" <<EOF
export PATH="$pg_bin:/c/Program Files/Go/bin:\$HOME/go/bin:\$PATH"
export BATON_TEST_DATABASE_URL=postgres://postgres:baton@127.0.0.1:5432/baton_test?sslmode=disable
EOF
touch "$HOME/.bashrc"
grep -qxF '. "$HOME/.baton-env.sh"' "$HOME/.bashrc" || echo '. "$HOME/.baton-env.sh"' >> "$HOME/.bashrc"

. "$HOME/.baton-env.sh"
go version
psql --version
op --version
