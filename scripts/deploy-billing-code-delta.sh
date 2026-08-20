#!/bin/sh
set -eu

archive_path="${1:?archive path is required}"
expected_sha="${2:?sha256 is required}"
release="${3:?release id is required}"
root=/opt/imaideo
current="$root/current"
stage="$root/deploy-staging/billing-$release"
backup_dir="$root/backups"
rollback_tag="imaideo-app:rollback-$release"
release_tag="imaideo-app:billing-$release"
patch_container="imaideo-billing-patch-$release"
compose_backup="$backup_dir/docker-compose.production.$release.yml"
rollback_override="$backup_dir/docker-compose.rollback.$release.yml"
rollback_ready=0

mkdir -p "$stage" "$backup_dir"
exec 9>"$root/.deploy.lock"
flock -n 9 || { echo 'DEPLOY_LOCKED'; exit 1; }

cleanup() {
  docker rm -f "$patch_container" >/dev/null 2>&1 || true
  rm -rf "$stage"
}

rollback() {
  exit_code=$?
  trap - EXIT INT TERM
  if [ "$rollback_ready" = 1 ]; then
    echo "ROLLBACK_START release=$release"
    docker tag "$rollback_tag" imaideo-app:latest || true
    [ ! -f "$compose_backup" ] || cp "$compose_backup" "$current/docker-compose.production.yml"
    cd "$current"
    docker compose --env-file .env.production -f docker-compose.production.yml -f "$rollback_override" -p imaideo up -d --no-build --force-recreate --no-deps web || true
    health_attempt=0
    while [ "$health_attempt" -lt 60 ]; do
      health_status=$(docker inspect --format='{{.State.Health.Status}}' imaideo-web-1 2>/dev/null || true)
      [ "$health_status" = healthy ] && break
      health_attempt=$((health_attempt + 1))
      sleep 3
    done
    docker compose --env-file .env.production -f docker-compose.production.yml -f "$rollback_override" -p imaideo up -d --no-build --force-recreate --no-deps worker || true
    echo "ROLLBACK_DONE release=$release"
  fi
  cleanup
  exit "$exit_code"
}
trap rollback EXIT INT TERM

[ -f "$archive_path" ] || { echo "ARCHIVE_MISSING $archive_path"; exit 1; }
actual_sha=$(sha256sum "$archive_path" | awk '{print $1}')
[ "$actual_sha" = "$expected_sha" ] || { echo "ARCHIVE_SHA_MISMATCH actual=$actual_sha"; exit 1; }
[ -f "$current/.env.production" ] || { echo 'PRODUCTION_ENV_MISSING'; exit 1; }
[ -f "$current/docker-compose.production.yml" ] || { echo 'PRODUCTION_COMPOSE_MISSING'; exit 1; }

available_kb=$(df -Pk / | awk 'NR==2 {print $4}')
[ "$available_kb" -ge 600000 ] || { echo "DISK_TOO_LOW available_kb=$available_kb"; exit 1; }
available_mb=$(awk '/MemAvailable:/ {print int($2/1024)}' /proc/meminfo)
[ "$available_mb" -ge 120 ] || { echo "MEMORY_TOO_LOW available_mb=$available_mb"; exit 1; }

cp "$current/docker-compose.production.yml" "$compose_backup"
cat > "$rollback_override" <<'YAML'
services:
  web:
    command: ["npm", "run", "start"]
YAML
docker tag imaideo-app:latest "$rollback_tag"
rollback_ready=1

db_container=$(docker ps --format '{{.Names}}' | awk '/^imaideo-postgres-1$/ {print; exit}')
[ -n "$db_container" ] || { echo 'POSTGRES_CONTAINER_MISSING'; exit 1; }
docker exec "$db_container" pg_dump -U shortdrama -d shortdrama | gzip -1 > "$backup_dir/billing-$release.sql.gz"

tar -xzf "$archive_path" -C "$stage"
docker create --name "$patch_container" imaideo-app:latest >/dev/null
docker cp "$stage/." "$patch_container:/app"
docker commit "$patch_container" "$release_tag" >/dev/null

old_entrypoint=$(docker image inspect "$rollback_tag" --format '{{json .Config.Entrypoint}}')
old_cmd=$(docker image inspect "$rollback_tag" --format '{{json .Config.Cmd}}')
new_entrypoint=$(docker image inspect "$release_tag" --format '{{json .Config.Entrypoint}}')
new_cmd=$(docker image inspect "$release_tag" --format '{{json .Config.Cmd}}')
[ "$old_entrypoint" = "$new_entrypoint" ] || { echo 'IMAGE_ENTRYPOINT_CHANGED'; exit 1; }
[ "$old_cmd" = "$new_cmd" ] || { echo 'IMAGE_CMD_CHANGED'; exit 1; }

cp "$stage/docker-compose.production.yml" "$current/docker-compose.production.yml"
install -m 700 "$stage/scripts/rollback-billing-code-delta.sh" "$root/rollback-billing-$release.sh"
docker tag "$release_tag" imaideo-app:latest

cd "$current"
docker compose --env-file .env.production -f docker-compose.production.yml -p imaideo up -d --no-build --force-recreate --no-deps web
health_attempt=0
while [ "$health_attempt" -lt 120 ]; do
  health_status=$(docker inspect --format='{{.State.Health.Status}}' imaideo-web-1 2>/dev/null || true)
  [ "$health_status" = healthy ] && break
  health_attempt=$((health_attempt + 1))
  if [ "$health_attempt" -eq 120 ]; then
    docker logs --tail 100 imaideo-web-1 2>&1 || true
    echo 'WEB_HEALTH_TIMEOUT'
    exit 1
  fi
  sleep 3
done

docker compose --env-file .env.production -f docker-compose.production.yml -p imaideo up -d --no-build --force-recreate --no-deps worker
worker_attempt=0
while [ "$worker_attempt" -lt 60 ]; do
  worker_status=$(docker inspect --format='{{.State.Status}}' imaideo-worker-1 2>/dev/null || true)
  if [ "$worker_status" = running ] && docker logs --tail 80 imaideo-worker-1 2>&1 | grep -q 'Workers listening'; then
    break
  fi
  worker_attempt=$((worker_attempt + 1))
  if [ "$worker_attempt" -eq 60 ]; then
    docker logs --tail 100 imaideo-worker-1 2>&1 || true
    echo 'WORKER_START_TIMEOUT'
    exit 1
  fi
  sleep 3
done

curl -fsS http://127.0.0.1:14000/login >/dev/null
docker exec imaideo-web-1 npx tsx scripts/verify-billing.ts
docker compose --env-file .env.production -f docker-compose.production.yml -p imaideo ps

rollback_ready=0
trap - EXIT INT TERM
cleanup
rm -f "$archive_path"
echo "DEPLOYMENT_OK release=$release rollback=$root/rollback-billing-$release.sh db_backup=$backup_dir/billing-$release.sql.gz"
