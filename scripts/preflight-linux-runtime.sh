#!/usr/bin/env bash
set -euo pipefail
base=$(mktemp -d "$RUNNER_TEMP/linux-smoke.XXXXXX")
dist="$(pwd)/dist-electron"
asset="repo-radar-1.4.0-$ASSET_ARCH.AppImage"
old="$base/$asset"
incoming="repo-radar-1.4.1-$ASSET_ARCH.AppImage"
export REPO_RADAR_CONFIG="$base/config.json" REPO_RADAR_PORT=19426
export APPIMAGE_EXTRACT_AND_RUN=1
export LC_ALL=C.UTF-8
api="http://127.0.0.1:$REPO_RADAR_PORT"
old_pid=''
feed_pid=''
curl_pid=''
new_pid=''
cleanup() {
  status=$?
  set +e
  curl -fsS --max-time 3 -X POST -H 'X-Repo-Radar: shutdown' "$api/api/shutdown" >/dev/null 2>&1
  for pid in "$curl_pid" "$old_pid" "$new_pid" "$feed_pid"; do
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then kill "$pid" 2>/dev/null; fi
  done
  if [ "$status" != 0 ]; then
    for log in "$base/app.log" "$base/new.log" "$base/feed.log" "$base/update.json"; do
      if [ -f "$log" ]; then echo "== $log =="; tail -n 65 "$log"; fi
    done
  fi
  return "$status"
}
trap cleanup EXIT

gh release download v1.4.0 --repo rockbenben/repo-radar --pattern "$asset" --dir "$base"
unset GH_TOKEN
chmod +x "$old"
(cd "$base" && "$old" --appimage-extract >/dev/null)
appdir="$base/squashfs-root"
cat > "$appdir/resources/app-update.yml" <<'FEED'
provider: generic
url: http://127.0.0.1:19427/
updaterCacheDirName: repo-radar-preflight-updater
useMultipleRangeRequest: false
FEED

node scripts/preflight-feed.cjs "$dist" "$MANIFEST" "$incoming" >"$base/feed.log" 2>&1 &
feed_pid=$!
for i in {1..30}; do
  if curl -fsS "http://127.0.0.1:19427/$MANIFEST" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS "http://127.0.0.1:19427/$MANIFEST" >/dev/null
git init -q "$base/fixture"
jq -n --arg path "$base/fixture" '{manualRepos:[$path],autoScanMinutes:0,checkUpdates:false}' > "$REPO_RADAR_CONFIG"

APPIMAGE="$old" APPDIR="$appdir" "$appdir/AppRun" --tray --no-sandbox > "$base/app.log" 2>&1 &
old_pid=$!
wait_version() {
  attempts="$2"
  for i in $(seq "$attempts"); do
    if curl -fsS --max-time 2 "$api/api/version" 2>/dev/null | jq -e --arg version "$1" '.version == $version' >/dev/null; then return 0; fi
    sleep 1
  done
  return 1
}
wait_version 1.4.0 45
id=''
for i in {1..30}; do
  id=$(curl -fsS "$api/api/repos" | jq -r '.[0].id // ""')
  if [ -n "$id" ]; then break; fi
  sleep 1
done
test -n "$id"
curl -fsS "$api/api/repos/$id/meta" -X PATCH -H 'Content-Type: application/json' -d '{"tags":["upgrade-fixture"]}' | jq -e '.tags==["upgrade-fixture"]'

curl -fsS --max-time 180 "$api/api/update/check" -X POST -H 'X-Repo-Radar: update' -H 'Content-Type: application/json' -d '{"lang":"en"}' > "$base/update.json" &
curl_pid=$!
find_dialog() {
  for i in $(seq 120); do
    window=$(xdotool search --onlyvisible --name 'repo-radar|[Uu]pdate|1.4.1' 2>/dev/null | tail -n 1 || :)
    if [ -z "$window" ]; then window=$(xdotool search --onlyvisible --pid "$old_pid" 2>/dev/null | tail -n 1 || :); fi
    if [ -n "$window" ] && [ "$window" != "${1:-}" ]; then printf '%s' "$window"; return 0; fi
    sleep 0.5
  done
  return 1
}
download=$(find_dialog)
xdotool windowfocus --sync "$download"
xdotool key --clearmodifiers Return
install=$(find_dialog "$download")
xdotool windowfocus --sync "$install"
xdotool key --clearmodifiers Return

for i in {1..40}; do
  if [ ! -e "$old" ] && test -x "$base/$incoming"; then break; fi
  sleep 1
done
test ! -e "$old"
test -x "$base/$incoming"
cmp "$dist/$incoming" "$base/$incoming"
printf 'Published %s AppImage was downloaded and replaced byte-for-byte on %s\n' "$asset" "$(uname -m)"

if wait_version 1.4.1 40; then
  mode='automatic relaunch'
else
  env -u APPIMAGE -u APPDIR "$base/$incoming" --tray --no-sandbox > "$base/new.log" 2>&1 &
  new_pid=$!
  wait_version 1.4.1 45
  mode='manual relaunch under virtual display'
fi
for i in {1..20}; do
  if curl -fsS "$api/api/repos" | jq -e --arg id "$id" '.[] | select(.id==$id and .tags==["upgrade-fixture"])' >/dev/null; then
    printf 'AppImage 1.4.0 -> 1.4.1 passed via %s, with repository ID and tags preserved\n' "$mode"
    exit 0
  fi
  sleep 1
done
exit 1
