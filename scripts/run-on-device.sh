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
# Probe jobs: stop the Play Store before its auto-update job runs. In every round 2 job it updated Google
# Play services 1.5 to 4 min after this point, and the new container made Play services restart every
# process with a Dynamite module loaded, Chrome included, which killed Chrome mid-probe. It had Chrome and
# Gboard queued as well. Gboard's language packs come through its own downloader, not the Play Store.
if [ -n "${PROBE_LANG:-}" ]; then
  a shell am force-stop com.android.vending
  log "play store disable: $(timeout 30 adb shell pm disable-user --user 0 com.android.vending 2>&1 | tr '\n' ' ')"
  vending_disabled=$(timeout 30 adb shell pm list packages -d 2>/dev/null | tr -d '\r' | grep -c '^package:com.android.vending$')
  log "play store disabled=$vending_disabled"
fi
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
  # If the Play Store could not be disabled, or had already scheduled the Play services update, wait for
  # that update to land before Chrome starts: the restart follows its INSTALLED line within ~1s
  # (round 2: 0.2 to 1.1s in all 10 jobs). Max 6 min, then go on and let probe.ts relaunch Chrome.
  gms_update='Package:com.google.android.gms.*state:'
  # The capture in $out/logcat.txt started after a clear, so count from it and from the device log both.
  gms() { { cat "$out/logcat.txt"; timeout 20 adb logcat -d 2>/dev/null; } | grep -c "${gms_update}$1"; }
  log "gms update wait start: scheduled=$(gms SCHEDULED) installed=$(gms INSTALLED)"
  # With the Play Store disabled, nothing new gets scheduled, so only an update already under way counts.
  # Otherwise one is still coming (round 2 scheduled it 1.5 to 4 min after boot), so wait for it too.
  for i in $(seq 1 72); do
    if [ "${vending_disabled:-0}" -ge 1 ] && [ "$(gms SCHEDULED)" -eq 0 ]; then break; fi
    if [ "$(gms INSTALLED)" -gt 0 ]; then
      # The restart lines follow the install within ~1s. Give the second split install and its restarts 20s.
      sleep 20
      break
    fi
    sleep 5
  done
  log "gms update wait done after $((i * 5))s: scheduled=$(gms SCHEDULED) installed=$(gms INSTALLED) restarts=$(grep -c 'forcing restart due to module' "$out/logcat.txt")"
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
for args in "editor.html?merge=1 bare" "editor.html?merge=1 ime" "plain-two.html bare" "plain-two.html ime"; do
  eval "set -- $args"
  export MERGE="$2"
  set -- "$1" ''
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
