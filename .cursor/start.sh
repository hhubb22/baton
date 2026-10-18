#!/usr/bin/env bash
# 启动测试用的 PostgreSQL 17，并准备 BATON_TEST_DATABASE_URL 指向的库。重复执行无副作用。
# Linux 上 root 时使用系统集群；普通用户（Linux、macOS）在 $HOME 下建自己的集群，不依赖 sudo。
# Windows（Git Bash）上 PostgreSQL 是安装包注册的服务，这里只确认它在运行。
set -euo pipefail

if [ -f /etc/profile.d/baton.sh ]; then
  . /etc/profile.d/baton.sh
elif [ -f "$HOME/.baton-env.sh" ]; then
  . "$HOME/.baton-env.sh"
fi

if [ -d /usr/lib/postgresql/17/bin ]; then
  bin=/usr/lib/postgresql/17/bin
else
  bin=$(dirname "$(command -v pg_ctl)")
fi
export PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres PGPASSWORD=baton
# macOS 上没有 LC_ALL 时 postmaster 启动阶段会变成多线程并退出。
if [ "$(uname -s)" = Darwin ]; then
  export LC_ALL="${LC_ALL:-en_US.UTF-8}" LANG="${LANG:-en_US.UTF-8}"
fi

case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*)
    sc.exe start postgresql-x64-17 >/dev/null 2>&1 || true
    ;;
  *)
    if [ "$(id -u)" = 0 ]; then
      pg_ctlcluster 17 main start 2>/dev/null || true
    else
      data="$HOME/.baton-postgres"
      if [ ! -s "$data/PG_VERSION" ]; then
        pwfile=$(mktemp)
        echo baton > "$pwfile"
        "$bin/initdb" -D "$data" -U postgres --pwfile="$pwfile" --auth=scram-sha-256 --encoding=UTF8 --locale=C >/dev/null
        rm -f "$pwfile"
      fi
      "$bin/pg_ctl" -D "$data" -l "$data/server.log" -o "-c listen_addresses=127.0.0.1 -p 5432 -k /tmp" status >/dev/null 2>&1 \
        || "$bin/pg_ctl" -D "$data" -l "$data/server.log" -o "-c listen_addresses=127.0.0.1 -p 5432 -k /tmp" -w start >/dev/null
    fi
    ;;
esac

for _ in $(seq 1 30); do
  "$bin/pg_isready" -q -h 127.0.0.1 -p 5432 && break
  sleep 1
done
if [ "$(uname -s)" = Linux ] && [ "$(id -u)" = 0 ]; then
  su postgres -c "psql -h /var/run/postgresql -qc \"ALTER USER postgres PASSWORD 'baton'\""
fi
"$bin/psql" -tAc "SELECT 1 FROM pg_database WHERE datname = 'baton_test'" postgres | grep -q 1 \
  || "$bin/createdb" baton_test
