#!/usr/bin/env bash
# Runs inside android-emulator-runner's script block, emulator already booted.
set -u
out=out
mkdir -p "$out"
echo "BOOTED at $(date +%s)" | tee -a "$out/timing.txt"
scripts/diagnose.sh "$out"

# Make Chrome skip its first-run screens.
adb shell am set-debug-app --persistent com.android.chrome
adb shell 'echo "chrome --disable-fre --no-default-browser-check --no-first-run" > /data/local/tmp/chrome-command-line'

(cd page/dist && python3 -m http.server 8765 > ../../out/http.log 2>&1 &)
sleep 1

status=0
for args in "plain.html ''" "editor.html ''" "editor.html x"; do
  eval "set -- $args"
  python3 scripts/drive.py "$1" "$2" "$out" 2>&1 | tee -a "$out/drive.log" || status=1
  adb shell am force-stop com.android.chrome
done
adb shell screencap -p /sdcard/final.png && adb pull /sdcard/final.png "$out/final.png"
echo "DONE at $(date +%s)" | tee -a "$out/timing.txt"
exit $status
