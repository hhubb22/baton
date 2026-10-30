#!/usr/bin/env bash
set -euo pipefail

# 在 edge-01 上由受保护的部署任务调用；沿用已有数据库、网关和私有配置。
version=${1:?release version required}
staging=${2:?staging directory required}
image=${3:?image digest required}
reset_data=${4:-false}
[[ "$reset_data" = true || "$reset_data" = false ]] || exit 2
[[ "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$ ]] || exit 2
[[ "$staging" =~ ^/tmp/baton-deploy-[A-Za-z0-9-]+$ ]] || exit 2
[[ "$image" =~ ^ghcr\.io/hhubb22/baton@sha256:[a-f0-9]{64}$ ]] || exit 2
[[ $(id -u) = 0 ]] || { echo 'Deploy requires sudo.' >&2; exit 2; }
cd /opt/services/baton
exec 9>/run/lock/baton-deploy.lock
flock -n 9 || { echo 'Another deployment is running.' >&2; exit 1; }
test -f "$staging/assets/update-manifest.json"
test -f compose.yaml
test -f .env
target="/opt/services/baton/release-versions/$version"
if test -e "$target"; then
  diff -qr "$target" "$staging/assets" >/dev/null || { echo 'Release assets differ from the staged version.' >&2; exit 1; }
fi
docker pull "$image"
image_version=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' "$image")
image_commit=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")
[[ "$image_version" = "$version" && "$image_commit" =~ ^[a-f0-9]{40,64}$ ]] || { echo 'Image release identity mismatch.' >&2; exit 1; }
if ! test -e "$target"; then
  install -d -m 0755 "$target"
  cp -R "$staging/assets/." "$target/"
fi
chown -R root:root "$target"
chmod -R a+rX,go-w "$target"

compose=(docker compose -f compose.yaml)
if test -f compose.release.json; then compose+=(-f compose.release.json); fi
backup="backups/deploy-$(date -u +%Y%m%dT%H%M%SZ)-$version"
install -d -m 0700 "$backup"
cp compose.yaml "$backup/"
cp .env "$backup/"
if test -f compose.release.json; then cp compose.release.json "$backup/"; fi
"${compose[@]}" stop baton-server
deployment_failed() {
  echo 'Deployment failed. Database may have migrated; service remains stopped. Inspect the backup before restoring.' >&2
  docker compose -f compose.yaml -f compose.release.json stop baton-server 2>/dev/null || true
}
trap deployment_failed ERR
"${compose[@]}" exec -T postgres pg_dump -U postgres -d baton -Fc > "$backup/database.dump"
if [[ "$reset_data" = true ]]; then
  "${compose[@]}" exec -T postgres pg_dump -U postgres -d baton --data-only --column-inserts --table public.employees > "$backup/employees.sql"
fi
tar -czf "$backup/server.tar.gz" -C data server
# JSON 是 Compose 支持的 YAML 子集；参数在上方限制为发布标识和摘要。
printf '{"services":{"baton-server":{"image":"%s","volumes":["%s:/opt/baton/releases:ro"]}}}\n' "$image" "$target" > compose.release.json.next
mv compose.release.json.next compose.release.json
if [[ "$reset_data" = true ]]; then
  docker compose -f compose.yaml exec -T postgres dropdb -U postgres --force baton
  docker compose -f compose.yaml exec -T postgres createdb -U postgres --owner=baton baton
  docker compose -f compose.yaml exec -T postgres psql -U postgres -d baton -v ON_ERROR_STOP=1 -c 'CREATE EXTENSION vector'
  docker compose -f compose.yaml -f compose.release.json run --rm --no-deps baton-server migrate
  docker compose -f compose.yaml exec -T postgres psql -U postgres -d baton -v ON_ERROR_STOP=1 < "$backup/employees.sql"
fi
docker compose -f compose.yaml -f compose.release.json up -d --no-build --no-deps --wait --wait-timeout 120 baton-server
docker compose -f compose.yaml -f compose.release.json exec -T baton-server node -e \
  'fetch("http://127.0.0.1:8080/api/v1/release").then(r=>r.json()).then(r=>{if(r.version!==process.argv[1]||r.commit!==process.argv[2])process.exit(1)}).catch(()=>process.exit(1))' "$version" "$image_commit"
curl --fail --silent --show-error http://127.0.0.1:18082/api/v1/release > "$backup/release.json"
docker compose -f compose.yaml -f compose.release.json exec -T baton-server node -e \
  'const r=JSON.parse(require("node:fs").readFileSync(0,"utf8"));if(r.version!==process.argv[1]||r.commit!==process.argv[2])process.exit(1)' "$version" "$image_commit" < "$backup/release.json"
trap - ERR
echo "Deployed $version; backup: /opt/services/baton/$backup"
