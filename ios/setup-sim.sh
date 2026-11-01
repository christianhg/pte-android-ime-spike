#!/usr/bin/env bash
# Pick the newest iOS runtime and an iPhone on it, set keyboard preferences, boot it.
# Usage: ios/setup-sim.sh <en|ja> <out>. Writes UDID and IOS_VERSION to $GITHUB_ENV.
set -u
lang=$1; out=$2; mkdir -p "$out"
rt=$(xcrun simctl list runtimes available -j | jq -r '[.runtimes[]|select(.platform=="iOS")]|sort_by(.version|split(".")|map(tonumber))|last|.identifier')
ver=$(xcrun simctl list runtimes available -j | jq -r --arg rt "$rt" '.runtimes[]|select(.identifier==$rt)|.version')
udid=$(xcrun simctl list devices available -j | jq -r --arg rt "$rt" '.devices[$rt][]|select(.name|test("^iPhone"))|.udid' | head -1)
name=$(xcrun simctl list devices available -j | jq -r --arg rt "$rt" --arg u "$udid" '.devices[$rt][]|select(.udid==$u)|.name')
echo "SIM runtime=$rt version=$ver device=$name udid=$udid" | tee "$out/sim.txt"
echo "UDID=$udid" >> "$GITHUB_ENV"
echo "IOS_VERSION=$ver" >> "$GITHUB_ENV"
# No hardware keyboard: the Simulator app reads this when it attaches.
defaults write com.apple.iphonesimulator ConnectHardwareKeyboard -bool false
xcrun simctl boot "$udid"
xcrun simctl bootstatus "$udid" -b > /dev/null
sp() { xcrun simctl spawn "$udid" "$@"; }
if [ "$lang" = ja ]; then
  sp defaults write -g AppleKeyboards -array 'ja_JP-Romaji@sw=QWERTY-Japanese;hw=Automatic' 'en_US@sw=QWERTY;hw=Automatic'
else
  sp defaults write -g AppleKeyboards -array 'en_US@sw=QWERTY;hw=Automatic'
fi
sp defaults write -g AppleKeyboardsExpanded -int 1
for k in KeyboardAutocorrection KeyboardPrediction KeyboardAutocapitalization KeyboardCheckSpelling DidShowContinuousPathIntroduction KeyboardDidShowProductivityTutorial; do
  sp defaults write com.apple.Preferences "$k" -bool true
done
sp defaults write com.apple.Preferences KeyboardContinuousPathEnabled -bool false
sp defaults read -g AppleKeyboards | tee -a "$out/sim.txt"
sp defaults read com.apple.Preferences | tee "$out/preferences.txt" > /dev/null
# Reboot so keyboard daemons pick the preferences up.
xcrun simctl shutdown "$udid"
xcrun simctl boot "$udid"
xcrun simctl bootstatus "$udid" -b > /dev/null
echo "SIM booted at $(date +%s)" | tee -a "$out/sim.txt"
