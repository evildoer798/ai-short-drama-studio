#!/usr/bin/env sh
set -eu

web_id="$(docker inspect imaideo-web-1 --format '{{.Image}}')"
worker_id="$(docker inspect imaideo-worker-1 --format '{{.Image}}')"
latest_id="$(docker image inspect imaideo-app:latest --format '{{.Id}}')"
rollback_id="$(docker image inspect imaideo-app:20260730-154100 --format '{{.Id}}')"
web_tag_id="$(docker image inspect imaideo-app:20260730-160200 --format '{{.Id}}')"

printf 'protected_web=%s\n' "$web_id"
printf 'protected_worker=%s\n' "$worker_id"
printf 'protected_latest=%s\n' "$latest_id"
printf 'protected_rollback=%s\n' "$rollback_id"

test "$web_id" = "$web_tag_id"
test "$worker_id" = "$latest_id"

echo 'before:'
df -h /

refs_file="/tmp/imaideo-app-refs.$$"
ids_file="/tmp/imaideo-app-old-ids.$$"
docker images imaideo-app --format '{{.Repository}}:{{.Tag}}' > "$refs_file"
: > "$ids_file"

while IFS= read -r ref; do
  [ -n "$ref" ] || continue
  full_id="$(docker image inspect "$ref" --format '{{.Id}}')"
  if [ "$full_id" = "$web_id" ] \
    || [ "$full_id" = "$worker_id" ] \
    || [ "$full_id" = "$latest_id" ] \
    || [ "$full_id" = "$rollback_id" ]; then
    printf 'keep %s %s\n' "$ref" "$full_id"
    continue
  fi

  printf '%s\n' "$full_id" >> "$ids_file"
  printf 'remove tag %s\n' "$ref"
  docker image rm "$ref" >/dev/null || true
done < "$refs_file"

sort -u "$ids_file" -o "$ids_file"
while IFS= read -r image_id; do
  [ -n "$image_id" ] || continue
  printf 'remove image %s\n' "$image_id"
  docker image rm "$image_id" >/dev/null 2>&1 || true
done < "$ids_file"

rm -f "$refs_file" "$ids_file"

echo 'after:'
df -h /
echo 'remaining app images:'
docker images imaideo-app --format '{{.Repository}}:{{.Tag}} {{.ID}} {{.Size}}'
echo 'containers:'
docker ps --filter name=imaideo --format '{{.Names}} {{.Status}}'
