#!/usr/bin/env bash
set -euo pipefail
base=$(mktemp -d "$RUNNER_TEMP/mac-smoke.XXXXXX")
export REPO_RADAR_CONFIG="$base/config.json" REPO_RADAR_PORT=19426
printf '%s\n' '{"checkUpdates":true,"autoScanMinutes":0}' > "$REPO_RADAR_CONFIG"
api="http://127.0.0.1:$REPO_RADAR_PORT"
mounted=''
pid=''
cleanup() {
  if [ -n "$pid" ]; then
    curl -fsS --max-time 4 -X POST -H 'X-Repo-Radar: shutdown' "$api/api/shutdown" >/dev/null 2>&1 || :
    for i in {1..20}; do
      if ! kill -0 "$pid" 2>/dev/null; then break; fi
      sleep 0.2
    done
    if kill -0 "$pid" 2>/dev/null; then kill "$pid" 2>/dev/null || :; fi
    wait "$pid" 2>/dev/null || :
  fi
  if [ -n "$mounted" ]; then hdiutil detach "$mounted" >/dev/null; fi
}
trap cleanup EXIT

for arch in arm64 x64; do
  dmg="$RUNNER_TEMP/dmgs/repo-radar-1.4.0-$arch.dmg"
  hdiutil verify "$dmg"
  mount="$base/mount-$arch"
  mkdir "$mount"
  hdiutil attach "$dmg" -nobrowse -readonly -mountpoint "$mount"
  mounted="$mount"
  app="$mount/repo-radar.app/Contents/MacOS/repo-radar"
  macho=$(lipo -archs "$app")
  case "$arch" in
    arm64) test "$macho" = arm64 ;;
    x64) test "$macho" = x86_64 ;;
  esac
  printf 'DMG %s validated, Mach-O %s\n' "$arch" "$macho"
  if [ "$(uname -m)" = "$macho" ]; then
    "$app" --tray >"$base/app.log" 2>&1 &
    pid=$!
    for i in {1..45}; do
      if curl -fsS "$api/api/version" 2>/dev/null | jq -e '.version=="1.4.0" and .manualUpdates==true' >/dev/null; then break; fi
      sleep 1
    done
    curl -fsS "$api/api/version" | jq -e '.version=="1.4.0" and .manualUpdates==true'
    sleep 6
    ! grep -F 'Checking for update' "$base/app.log"
    curl -fsS --max-time 12 "$api/api/update/check" -X POST -H 'X-Repo-Radar: update' -H 'Content-Type: application/json' -d '{"lang":"en"}' | jq -e '.outcome=="openedReleasePage"'
    jq -e '.checkUpdates==true' "$REPO_RADAR_CONFIG"
    printf 'Packaged %s native update API opened Releases with auto-check preference preserved\n' "$macho"
    cleanup
    mounted=''
    pid=''
  else
    hdiutil detach "$mount" >/dev/null
    mounted=''
  fi
done
