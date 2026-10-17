# Cursor Cloud Agent 的 Baton 开发环境：Go、PostgreSQL 17、Node.js 与 pnpm、Playwright Chromium 的系统依赖，
# 以及读取测试凭据用的 1Password CLI（凭据由 OP_SERVICE_ACCOUNT_TOKEN 对应的只读 Service Account 提供）。
FROM node:24-bookworm-slim AS node

FROM golang:1.27-bookworm

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl gnupg lsb-release sudo git \
    && install -d /usr/share/postgresql-common/pgdg \
    && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
    && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
    && curl -fsSL https://downloads.1password.com/linux/keys/1password.asc | gpg --dearmor -o /usr/share/keyrings/1password-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/1password-archive-keyring.gpg] https://downloads.1password.com/linux/debian/$(dpkg --print-architecture) stable main" > /etc/apt/sources.list.d/1password.list \
    && install -d /etc/debsig/policies/AC2D62742012EA22 /usr/share/debsig/keyrings/AC2D62742012EA22 \
    && curl -fsSL https://downloads.1password.com/linux/debian/debsig/1password.pol -o /etc/debsig/policies/AC2D62742012EA22/1password.pol \
    && curl -fsSL https://downloads.1password.com/linux/keys/1password.asc | gpg --dearmor -o /usr/share/debsig/keyrings/AC2D62742012EA22/debsig.gpg \
    && apt-get update \
    && apt-get install -y --no-install-recommends postgresql-17 1password-cli \
    && rm -rf /var/lib/apt/lists/*

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && npm install -g pnpm@12.11.2 \
    && PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright npx -y playwright@1.62.1 install --with-deps chromium \
    && chmod -R a+rX /opt/ms-playwright \
    && rm -rf /var/lib/apt/lists/* /root/.npm

# Cursor 执行 install、start 和 Agent 命令的 shell 不继承镜像的 ENV，环境变量放在 profile 里由脚本和交互 shell 加载。
# 测试只连本机实例，start.sh 负责启动并设置口令。
RUN printf '%s\n' \
      'export PATH=/usr/local/go/bin:/go/bin:$PATH' \
      'export GOPATH=/go' \
      'export PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright' \
      'export npm_config_store_dir=/opt/pnpm-store' \
      'export BATON_TEST_DATABASE_URL=postgres://postgres:baton@127.0.0.1:5432/baton_test?sslmode=disable' \
      > /etc/profile.d/baton.sh \
    && echo '. /etc/profile.d/baton.sh' >> /etc/bash.bashrc \
    && install -d -m 1777 /opt/pnpm-store
