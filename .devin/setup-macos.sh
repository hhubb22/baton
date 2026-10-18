#!/usr/bin/env bash
# Devin macOS 快照的系统依赖：Go、PostgreSQL 17、Node.js 与 pnpm、1Password CLI。
# 由 blueprint 的 initialize 执行，重复执行无副作用。Web 端到端测试只在 Linux 上跑，这里不装浏览器。
set -euxo pipefail

pnpm_version=12.11.2

brew update
brew install go postgresql@17 node
brew install --cask 1password-cli || brew upgrade --cask 1password-cli || true
npm install -g "pnpm@$pnpm_version"

pg_bin="$(brew --prefix postgresql@17)/bin"
sudo mkdir -p /etc/profile.d
sudo tee /etc/profile.d/baton.sh >/dev/null <<EOF
export PATH="$pg_bin:\$(brew --prefix)/bin:\$HOME/go/bin:\$PATH"
export BATON_TEST_DATABASE_URL=postgres://postgres:baton@127.0.0.1:5432/baton_test?sslmode=disable
export LC_ALL="\${LC_ALL:-en_US.UTF-8}" LANG="\${LANG:-en_US.UTF-8}"
EOF
for rc in "$HOME/.zshrc" "$HOME/.bashrc"; do
  touch "$rc"
  grep -qxF '. /etc/profile.d/baton.sh' "$rc" || echo '. /etc/profile.d/baton.sh' >> "$rc"
done

. /etc/profile.d/baton.sh
go version
node --version
pnpm --version
psql --version
op --version
