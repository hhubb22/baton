#!/usr/bin/env bash
# 启动测试用的 PostgreSQL 17，并准备 BATON_TEST_DATABASE_URL 指向的库。重复执行无副作用。
# root 时使用系统集群；普通用户在 $HOME 下建自己的集群，不依赖 sudo。
set -euo pipefail

bin=/usr/lib/postgresql/17/bin
export PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres PGPASSWORD=baton

if [ "$(id -u)" = 0 ]; then
  pg_ctlcluster 17 main start 2>/dev/null || true
  as_pg=(su postgres -c)
else
  data="$HOME/.baton-postgres"
  if [ ! -s "$data/PG_VERSION" ]; then
    pwfile=$(mktemp)
    echo baton > "$pwfile"
    "$bin/initdb" -D "$data" -U postgres --pwfile="$pwfile" --auth=scram-sha-256 --encoding=UTF8 --locale=C.UTF-8 >/dev/null
    rm -f "$pwfile"
  fi
  "$bin/pg_ctl" -D "$data" -l "$data/server.log" -o "-c listen_addresses=127.0.0.1 -p 5432 -k /tmp" status >/dev/null 2>&1 \
    || "$bin/pg_ctl" -D "$data" -l "$data/server.log" -o "-c listen_addresses=127.0.0.1 -p 5432 -k /tmp" -w start >/dev/null
  as_pg=(bash -c)
fi

for _ in $(seq 1 30); do
  "$bin/pg_isready" -q -h 127.0.0.1 -p 5432 && break
  sleep 1
done
if [ "$(id -u)" = 0 ]; then
  "${as_pg[@]}" "psql -h /var/run/postgresql -qc \"ALTER USER postgres PASSWORD 'baton'\""
fi
psql -tAc "SELECT 1 FROM pg_database WHERE datname = 'baton_test'" postgres | grep -q 1 \
  || createdb baton_test
