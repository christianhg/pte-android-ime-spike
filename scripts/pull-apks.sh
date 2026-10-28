#!/usr/bin/env bash
# Runs on the API 36 image. Pulls the installed Gboard and Chrome APKs (with any split and Trichrome library) for the swap probe.
set -u
mkdir -p apks/gboard apks/chrome out
for pkg in com.google.android.inputmethod.latin com.android.chrome com.google.android.trichromelibrary; do
  dir=apks/chrome; [ $pkg = com.google.android.inputmethod.latin ] && dir=apks/gboard
  [ $pkg = com.google.android.trichromelibrary ] && dir=apks/trichrome && mkdir -p $dir
  echo "== $pkg" | tee -a out/pull.txt
  timeout 60 adb shell dumpsys package $pkg | grep -E "versionName|versionCode|minSdk|codePath|static library" | head -8 | tee -a out/pull.txt
  for p in $(timeout 60 adb shell pm path $pkg | sed 's/^package://' | tr -d '\r'); do
    echo "pull $p" | tee -a out/pull.txt
    timeout 120 adb pull "$p" "$dir/$(echo "$p" | tr '/' '_')" 2>&1 | tail -1 | tee -a out/pull.txt
  done
done
# Trichrome library is a static shared library: pm path does not list it, so find it on disk.
for f in $(timeout 60 adb shell 'ls -d /product/app/TrichromeLibrary*/*.apk /data/app/*/com.google.android.trichromelibrary*/base.apk 2>/dev/null' | tr -d '\r'); do
  mkdir -p apks/trichrome; echo "pull $f" | tee -a out/pull.txt
  timeout 120 adb pull "$f" "apks/trichrome/$(echo "$f" | tr '/' '_')" 2>&1 | tail -1 | tee -a out/pull.txt
done
timeout 60 adb shell 'ls -la /product/app/ | grep -iE "chrome|trichrome|latin|gboard"' | tee -a out/pull.txt
find apks -type f -exec ls -la {} \; | tee -a out/pull.txt
