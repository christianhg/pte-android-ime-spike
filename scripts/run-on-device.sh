#!/usr/bin/env bash
# Runs inside android-emulator-runner's script block, emulator already booted.
# Every device call is bounded so a hang shows up as a logged timeout, not silence.
set -u
out=out
mkdir -p "$out"
log() { echo "PHASE $(date +%H:%M:%S) $*" | tee -a "$out/phases.log"; }
a() { timeout 60 adb "$@"; local rc=$?; [ $rc -eq 124 ] && log "TIMEOUT adb $*"; return $rc; }

echo "BOOTED at $(date +%s)" | tee -a "$out/timing.txt"
log "diagnose start"
timeout 120 scripts/diagnose.sh "$out" || log "diagnose rc=$?"

# Make Chrome skip its first-run screens. Non-root Chrome reads this file only when it is the debug app.
log "chrome flags"
a shell am set-debug-app --persistent com.android.chrome
a shell 'echo "_ --disable-fre --no-default-browser-check --no-first-run --disable-features=SigninPromo" > /data/local/tmp/chrome-command-line'
a shell cat /data/local/tmp/chrome-command-line

log "http server"
(cd page/dist && exec python3 -u -m http.server 8765 < /dev/null > ../../out/http.log 2>&1) &
server=$!
trap 'kill $server 2>/dev/null' EXIT
sleep 1
curl -sf -o /dev/null http://localhost:8765/plain.html && log "http ok" || log "http FAILED"
a reverse tcp:8765 tcp:8765
a reverse --list

status=0
for args in "plain.html ''" "editor.html ''" "editor.html x"; do
  eval "set -- $args"
  log "case $1 prefix='$2' start"
  timeout -k 10 180 python3 -u scripts/drive.py "$1" "$2" "$out" 2>&1 | tee -a "$out/drive.log"
  rc=${PIPESTATUS[0]}
  log "case $1 prefix='$2' rc=$rc"
  [ "$rc" -ne 0 ] && status=1
  a shell am force-stop com.android.chrome
done
a exec-out screencap -p > "$out/final.png"
echo "DONE at $(date +%s)" | tee -a "$out/timing.txt"
exit $status
