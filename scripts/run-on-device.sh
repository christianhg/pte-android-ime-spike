#!/usr/bin/env bash
# Runs inside android-emulator-runner's script block, emulator already booted.
# Every device call is bounded so a hang shows up as a logged timeout, not silence.
set -u
out=out
mkdir -p "$out"
log() { echo "PHASE $(date +%H:%M:%S) $*" | tee -a "$out/phases.log"; }
a() { timeout 60 adb "$@"; local rc=$?; [ $rc -eq 124 ] && log "TIMEOUT adb $*"; return $rc; }

echo "BOOTED at $(date +%s)" | tee -a "$out/timing.txt"
# Play services runs a startup storm after boot. Chrome depends on its font provider and gets killed
# when it ANRs, so wait until the system has been free of ANRs for 30s (max 4 min).
# Late ANRs (system, launcher) still pop a dialog that takes window focus. Suppress the dialogs.
timeout 60 adb shell settings put global hide_error_dialogs 1 || log "TIMEOUT adb hide_error_dialogs"
log "settle start"
quiet=0
for i in $(seq 1 48); do
  if timeout 20 adb logcat -d -b events 2>/dev/null | grep -q "am_anr"; then quiet=0; timeout 10 adb logcat -b events -c; else quiet=$((quiet + 5)); fi
  [ $quiet -ge 30 ] && break
  sleep 5
done
log "settle done after $((i * 5))s quiet=$quiet"
log "diagnose start"
timeout 120 scripts/diagnose.sh "$out" || log "diagnose rc=$?"

# Make Chrome skip its first-run screens. Non-root Chrome reads this file only when it is the debug app.
log "chrome flags"
a shell am set-debug-app --persistent com.android.chrome
a shell 'echo "_ --disable-fre --no-default-browser-check --no-first-run --disable-features=SigninPromo" > /data/local/tmp/chrome-command-line'
a shell cat /data/local/tmp/chrome-command-line

log "soft keyboard"
a shell settings put secure show_ime_with_hard_keyboard 1
a shell settings get secure show_ime_with_hard_keyboard

if [ "${IME_LANG:-en}" = ja ]; then
  log "japanese setup"
  timeout -k 10 240 node scripts/setup-ja.ts "$out" 2>&1 | tee -a "$out/ja-setup.log"
  log "japanese setup rc=${PIPESTATUS[0]}"
fi

log "logcat"
a logcat -c
(timeout 3000 adb logcat -v time > "$out/logcat.txt" 2>&1 &)

log "http server"
node scripts/serve.ts page/dist 8765 < /dev/null > "$out/http.log" 2>&1 &
server=$!
trap 'kill $server 2>/dev/null' EXIT
sleep 1
curl -sf -o /dev/null http://localhost:8765/plain.html && log "http ok" || log "http FAILED"
a reverse tcp:8765 tcp:8765
a reverse --list

# Probe mode: add one Gboard language, then run the keyboard action probe instead of the typing cases.
if [ -n "${PROBE_LANG:-}" ]; then
  log "probe setup $PROBE_LANG"
  timeout -k 10 360 node scripts/setup-lang.ts "$PROBE_LANG" "$out" 2>&1 | tee -a "$out/setup.log"
  log "probe setup rc=${PIPESTATUS[0]}"
  # Play services updates its Dynamite modules a few minutes after boot and force-restarts every process
  # that loaded one, Chrome included ("Module config changed, forcing restart due to module
  # googlecertificates"). Wait until none has come for 60s (max 4 min). probe.ts relaunches Chrome if a
  # late one still lands.
  log "dynamite settle start"
  # Count the restarts in the background capture rather than clearing the device log under it.
  quiet=0
  seen=$(grep -c "forcing restart due to module" "$out/logcat.txt")
  for i in $(seq 1 48); do
    now=$(grep -c "forcing restart due to module" "$out/logcat.txt")
    if [ "$now" -gt "$seen" ]; then quiet=0; seen=$now; else quiet=$((quiet + 5)); fi
    [ $quiet -ge 60 ] && break
    sleep 5
  done
  log "dynamite settle done after $((i * 5))s quiet=$quiet restarts=$seen"
  log "probe $PROBE_LANG"
  timeout -k 10 1500 node scripts/probe.ts "$PROBE_LANG" "$out" 2>&1 | tee -a "$out/probe.log"
  rc=${PIPESTATUS[0]}
  log "probe rc=$rc"
  a logcat -d -b crash > "$out/logcat-crash.txt"
  a exec-out screencap -p > "$out/final.png"
  echo "DONE at $(date +%s)" | tee -a "$out/timing.txt"
  exit $rc
fi

status=0
for args in "plain.html ''" "editor.html ''" "editor.html x"; do
  eval "set -- $args"
  log "case $1 prefix='$2' start"
  timeout -k 10 180 node scripts/drive.ts "$1" "$2" "$out" 2>&1 | tee -a "$out/drive.log"
  rc=${PIPESTATUS[0]}
  log "case $1 prefix='$2' rc=$rc"
  if [ "$rc" -ne 0 ]; then
    # Retry once from a fresh Chrome. The retry is logged, so the flake rate counts first attempts too.
    log "RETRY case $1 prefix='$2'"
    a shell am force-stop com.android.chrome
    timeout -k 10 180 node scripts/drive.ts "$1" "$2" "$out" 2>&1 | tee -a "$out/drive.log"
    rc=${PIPESTATUS[0]}
    log "case $1 prefix='$2' retry rc=$rc"
  fi
  [ "$rc" -ne 0 ] && status=1
  a shell am force-stop com.android.chrome
  a shell rm -rf /data/data/com.android.chrome/app_tabs 2>/dev/null || true
done
a logcat -d -b crash > "$out/logcat-crash.txt"
a shell dumpsys activity exit-info com.android.chrome > "$out/chrome-exit-info.txt"
a exec-out screencap -p > "$out/final.png"
echo "DONE at $(date +%s)" | tee -a "$out/timing.txt"
exit $status
