#!/usr/bin/env bash
# Devin Ubuntu 快照的系统依赖：Go、PostgreSQL 17、Node.js 与 pnpm、Playwright Chromium、1Password CLI。
# 由 blueprint 的 initialize 以 ubuntu 用户执行，重复执行无副作用。
set -euxo pipefail

go_version=1.27.0
node_version=24
pnpm_version=12.11.2
playwright_version=1.62.1

sudo apt-get update
sudo apt-get install -y --no-install-recommends ca-certificates curl gnupg lsb-release

if ! /usr/local/go/bin/go version 2>/dev/null | grep -q "go$go_version "; then
  curl -fsSL "https://go.dev/dl/go$go_version.linux-amd64.tar.gz" -o /tmp/go.tgz
  sudo rm -rf /usr/local/go
  sudo tar -C /usr/local -xzf /tmp/go.tgz
  rm -f /tmp/go.tgz
fi

sudo install -d /usr/share/postgresql-common/pgdg
sudo curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" \
  | sudo tee /etc/apt/sources.list.d/pgdg.list >/dev/null
curl -fsSL https://downloads.1password.com/linux/keys/1password.asc | sudo gpg --batch --yes --dearmor -o /usr/share/keyrings/1password-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/1password-archive-keyring.gpg] https://downloads.1password.com/linux/debian/$(dpkg --print-architecture) stable main" \
  | sudo tee /etc/apt/sources.list.d/1password.list >/dev/null
sudo install -d /etc/debsig/policies/AC2D62742012EA22 /usr/share/debsig/keyrings/AC2D62742012EA22
sudo curl -fsSL https://downloads.1password.com/linux/debian/debsig/1password.pol -o /etc/debsig/policies/AC2D62742012EA22/1password.pol
curl -fsSL https://downloads.1password.com/linux/keys/1password.asc | sudo gpg --batch --yes --dearmor -o /usr/share/debsig/keyrings/AC2D62742012EA22/debsig.gpg
sudo apt-get update
sudo apt-get install -y --no-install-recommends postgresql-17 1password-cli

# .cursor/start.sh 以普通用户在 $HOME 下建自己的集群，系统集群不需要随开机启动。
sudo systemctl disable --now postgresql 2>/dev/null || true

export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh"
nvm install "$node_version"
nvm alias default "$node_version"
npm install -g "pnpm@$pnpm_version"

sudo install -d -m 1777 /opt/ms-playwright /opt/pnpm-store
PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright npx -y "playwright@$playwright_version" install --with-deps chromium

sudo tee /etc/profile.d/baton.sh >/dev/null <<'EOF'
export PATH=/usr/local/go/bin:$HOME/go/bin:$PATH
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
export PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
export npm_config_store_dir=/opt/pnpm-store
export BATON_TEST_DATABASE_URL=postgres://postgres:baton@127.0.0.1:5432/baton_test?sslmode=disable
EOF
grep -qxF '. /etc/profile.d/baton.sh' "$HOME/.bashrc" || echo '. /etc/profile.d/baton.sh' >> "$HOME/.bashrc"

. /etc/profile.d/baton.sh
go version
node --version
pnpm --version
psql --version
op --version
