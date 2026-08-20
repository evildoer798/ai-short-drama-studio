#!/bin/sh
set -eu

archive_path="${1:?archive path is required}"
expected_archive_sha="${2:?archive sha256 is required}"
release="${3:?release id is required}"
expected_package_sha="${4:?package.json sha256 is required}"
expected_source_sha="${5:?source sha256 is required}"
expected_build_id="${6:?Next.js build id is required}"
verification_source_path="${7:-src/lib/video-reference-plan.ts}"

case "$verification_source_path" in
  /*|*..*) echo 'INVALID_VERIFICATION_SOURCE_PATH'; exit 1 ;;
esac

root=/opt/imaideo
current="$root/current"
stage="$root/deploy-staging/code-$release"
rollback_tag="imaideo-app:rollback-$release"
release_tag="imaideo-app:code-$release"
patch_container="imaideo-code-patch-$release"
verify_dir="$stage/.verify"
rollback_script="$root/rollback-code-$release.sh"
rollback_ready=0

mkdir -p "$stage"
exec 9>"$root/.deploy.lock"
flock -n 9 || { echo 'DEPLOY_LOCKED'; exit 1; }

wait_for_web() {
  attempt=0
  while [ "$attempt" -lt 120 ]; do
    status=$(docker inspect --format='{{.State.Health.Status}}' imaideo-web-1 2>/dev/null || true)
    [ "$status" = healthy ] && return 0
    attempt=$((attempt + 1))
    sleep 3
  done
  docker logs --tail 100 imaideo-web-1 2>&1 || true
  return 1
}

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
    cd "$current"
    docker compose --env-file .env.production -f docker-compose.production.yml -p imaideo up -d --no-build --force-recreate --no-deps web || true
    wait_for_web || true
    docker compose --env-file .env.production -f docker-compose.production.yml -p imaideo up -d --no-build --force-recreate --no-deps worker || true
    echo "ROLLBACK_DONE release=$release"
  fi
  cleanup
  exit "$exit_code"
}
trap rollback EXIT INT TERM

[ -f "$archive_path" ] || { echo "ARCHIVE_MISSING $archive_path"; exit 1; }
[ -f "$current/.env.production" ] || { echo 'PRODUCTION_ENV_MISSING'; exit 1; }
[ -f "$current/docker-compose.production.yml" ] || { echo 'PRODUCTION_COMPOSE_MISSING'; exit 1; }

actual_archive_sha=$(sha256sum "$archive_path" | awk '{print $1}')
[ "$actual_archive_sha" = "$expected_archive_sha" ] || { echo "ARCHIVE_SHA_MISMATCH actual=$actual_archive_sha"; exit 1; }

current_package_sha=$(sha256sum "$current/package.json" | awk '{print $1}')
container_package_sha=$(docker exec imaideo-web-1 sha256sum /app/package.json | awk '{print $1}')
[ "$current_package_sha" = "$expected_package_sha" ] || { echo "CURRENT_PACKAGE_SHA_MISMATCH actual=$current_package_sha"; exit 1; }
[ "$container_package_sha" = "$expected_package_sha" ] || { echo "CONTAINER_PACKAGE_SHA_MISMATCH actual=$container_package_sha"; exit 1; }

available_kb=$(df -Pk / | awk 'NR==2 {print $4}')
[ "$available_kb" -ge 600000 ] || { echo "DISK_TOO_LOW available_kb=$available_kb"; exit 1; }
available_mb=$(awk '/MemAvailable:/ {print int($2/1024)}' /proc/meminfo)
[ "$available_mb" -ge 120 ] || { echo "MEMORY_TOO_LOW available_mb=$available_mb"; exit 1; }

tar -xzf "$archive_path" -C "$stage"
[ "$(cat "$stage/.next/BUILD_ID")" = "$expected_build_id" ] || { echo 'STAGE_BUILD_ID_MISMATCH'; exit 1; }
stage_source_sha=$(sha256sum "$stage/$verification_source_path" | awk '{print $1}')
[ "$stage_source_sha" = "$expected_source_sha" ] || { echo "STAGE_SOURCE_SHA_MISMATCH actual=$stage_source_sha"; exit 1; }

docker tag imaideo-app:latest "$rollback_tag"
rollback_ready=1

cat > "$rollback_script" <<EOF
#!/bin/sh
set -eu
docker image inspect '$rollback_tag' >/dev/null
docker tag '$rollback_tag' imaideo-app:latest
cd '$current'
docker compose --env-file .env.production -f docker-compose.production.yml -p imaideo up -d --no-build --force-recreate --no-deps web
docker compose --env-file .env.production -f docker-compose.production.yml -p imaideo up -d --no-build --force-recreate --no-deps worker
EOF
chmod 700 "$rollback_script"

docker create --name "$patch_container" imaideo-app:latest >/dev/null
docker cp "$stage/." "$patch_container:/app"
mkdir -p "$verify_dir"
docker cp "$patch_container:/app/package.json" "$verify_dir/package.json"
docker cp "$patch_container:/app/$verification_source_path" "$verify_dir/verification-source"
docker cp "$patch_container:/app/.next/BUILD_ID" "$verify_dir/BUILD_ID"
[ "$(sha256sum "$verify_dir/package.json" | awk '{print $1}')" = "$expected_package_sha" ] || { echo 'PATCH_PACKAGE_SHA_MISMATCH'; exit 1; }
[ "$(sha256sum "$verify_dir/verification-source" | awk '{print $1}')" = "$expected_source_sha" ] || { echo 'PATCH_SOURCE_SHA_MISMATCH'; exit 1; }
[ "$(cat "$verify_dir/BUILD_ID")" = "$expected_build_id" ] || { echo 'PATCH_BUILD_ID_MISMATCH'; exit 1; }

docker commit "$patch_container" "$release_tag" >/dev/null
old_entrypoint=$(docker image inspect "$rollback_tag" --format '{{json .Config.Entrypoint}}')
old_cmd=$(docker image inspect "$rollback_tag" --format '{{json .Config.Cmd}}')
new_entrypoint=$(docker image inspect "$release_tag" --format '{{json .Config.Entrypoint}}')
new_cmd=$(docker image inspect "$release_tag" --format '{{json .Config.Cmd}}')
[ "$old_entrypoint" = "$new_entrypoint" ] || { echo 'IMAGE_ENTRYPOINT_CHANGED'; exit 1; }
[ "$old_cmd" = "$new_cmd" ] || { echo 'IMAGE_CMD_CHANGED'; exit 1; }

docker tag "$release_tag" imaideo-app:latest
cd "$current"
docker compose --env-file .env.production -f docker-compose.production.yml -p imaideo up -d --no-build --force-recreate --no-deps web
wait_for_web || { echo 'WEB_HEALTH_TIMEOUT'; exit 1; }
curl -fsS http://127.0.0.1:14000/login >/dev/null

docker compose --env-file .env.production -f docker-compose.production.yml -p imaideo up -d --no-build --force-recreate --no-deps worker
attempt=0
while [ "$attempt" -lt 60 ]; do
  status=$(docker inspect --format='{{.State.Status}}' imaideo-worker-1 2>/dev/null || true)
  if [ "$status" = running ] && docker logs --tail 80 imaideo-worker-1 2>&1 | grep -q 'Workers listening'; then
    break
  fi
  attempt=$((attempt + 1))
  [ "$attempt" -lt 60 ] || { docker logs --tail 100 imaideo-worker-1 2>&1 || true; echo 'WORKER_START_TIMEOUT'; exit 1; }
  sleep 3
done

rollback_ready=0
trap - EXIT INT TERM
cleanup
rm -f "$archive_path"
echo "DEPLOYMENT_OK release=$release rollback=$rollback_script"
