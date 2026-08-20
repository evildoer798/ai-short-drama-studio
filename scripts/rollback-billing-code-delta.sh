#!/bin/sh
set -eu

release="${1:?release id is required}"
root=/opt/imaideo
current="$root/current"
rollback_tag="imaideo-app:rollback-$release"
compose_backup="$root/backups/docker-compose.production.$release.yml"
rollback_override="$root/backups/docker-compose.rollback.$release.yml"

docker image inspect "$rollback_tag" >/dev/null
[ -f "$compose_backup" ]
cat > "$rollback_override" <<'YAML'
services:
  web:
    command: ["npm", "run", "start"]
YAML
docker tag "$rollback_tag" imaideo-app:latest
cp "$compose_backup" "$current/docker-compose.production.yml"
cd "$current"
docker compose --env-file .env.production -f docker-compose.production.yml -f "$rollback_override" -p imaideo up -d --no-build --force-recreate --no-deps web
health_attempt=0
while [ "$health_attempt" -lt 120 ]; do
  health_status=$(docker inspect --format='{{.State.Health.Status}}' imaideo-web-1 2>/dev/null || true)
  [ "$health_status" = healthy ] && break
  health_attempt=$((health_attempt + 1))
  [ "$health_attempt" -lt 120 ] || { docker logs --tail 100 imaideo-web-1 2>&1 || true; exit 1; }
  sleep 3
done
docker compose --env-file .env.production -f docker-compose.production.yml -f "$rollback_override" -p imaideo up -d --no-build --force-recreate --no-deps worker
echo "ROLLBACK_OK release=$release"
