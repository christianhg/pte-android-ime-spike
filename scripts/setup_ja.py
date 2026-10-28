"""Add the Japanese QWERTY (romaji) layout to Gboard through its settings UI.

Play images have no root, so the locale route is closed. Every step dumps the screen to out/ja-setup-*.
"""
import re
import subprocess
import sys
import time

import uiautomator2 as u2

GBOARD = "com.google.android.inputmethod.latin"
out = sys.argv[1]
step = 0


def snap(d, name):
    global step
    step += 1
    with open(f"{out}/ja-setup-{step:02d}-{name}.xml", "w") as f:
        f.write(d.dump_hierarchy())
    d.screenshot(f"{out}/ja-setup-{step:02d}-{name}.png")
    print(f"JA_SETUP step {step} {name}", flush=True)


def tap_text(d, pattern, name, scroll=False):
    sel = d(textMatches=f"(?i){pattern}")
    if not sel.exists and scroll and d(scrollable=True).exists:
        for _ in range(12):
            d(scrollable=True).scroll.forward(steps=30)
            if sel.exists:
                break
    if not sel.wait(timeout=15):
        snap(d, f"missing-{name}")
        raise RuntimeError(f"no node matching {pattern!r} for {name}")
    sel.click()
    time.sleep(1.5)
    snap(d, name)


d = u2.connect()
subprocess.run(["adb", "shell", "am", "start", "-n",
                f"{GBOARD}/com.google.android.apps.inputmethod.latin.preference.SettingsActivity"], timeout=60)
time.sleep(4)
snap(d, "settings")
tap_text(d, r"^Languages$", "languages")
tap_text(d, r"^Add keyboard$", "add-keyboard")
# The list holds hundreds of languages. Use its search instead of scrolling.
d(description="Search for a language").click()
time.sleep(1.5)
# The field is an AutoCompleteTextView, not an EditText.
search = d(resourceId=f"{GBOARD}:id/search_src_text")
if not search.wait(timeout=8):
    snap(d, "missing-search-field")
    raise RuntimeError("no search field after tapping Search for a language")
search.click()
subprocess.run(["adb", "shell", "input", "text", "Japanese"], timeout=60)
time.sleep(2)
snap(d, "search-typed")
# Gboard v12 keeps the query when Back hides the keyboard. Gboard v15 closes the search on Back and
# shows the full list again, so only press Back when the result row is hidden under the keyboard.
if not d(resourceId="android:id/title", textMatches=r"^(Japanese|日本語)$").exists:
    subprocess.run(["adb", "shell", "input", "keyevent", "KEYCODE_BACK"], timeout=60)
    time.sleep(1)
snap(d, "search")
# The search field also reads "Japanese", so tap the result row (android:id/title) instead.
row = d(resourceId="android:id/title", textMatches=r"^(Japanese|日本語)$")
if not row.exists and d(scrollable=True).exists:
    # Fall back to the alphabetical All languages list.
    for _ in range(60):
        if row.exists:
            break
        d(scrollable=True).scroll.forward(steps=20)
if not row.wait(timeout=15):
    snap(d, "missing-japanese-row")
    raise RuntimeError("no Japanese row in the search results")
row.click()
time.sleep(2)
snap(d, "japanese")
# Gboard preselects 12 keys (kana flick) and opens on it, so keep QWERTY (romaji) as the only layout.
# Gboard v12 labels the tiles in English, v15 in Japanese (12 キー, 手書き).
TWELVE = r"^12 (keys|キー)$"
QWERTY = r"^QWERTY$"
HANDWRITING = r"^(Handwriting|手書き)$"


def layout_selected(pattern):
    row = d(descriptionMatches=pattern)
    return row.exists and row.info.get("selected", False)

for pattern, want in ((QWERTY, True), (TWELVE, False), (HANDWRITING, False)):
    if d(descriptionMatches=pattern).exists and layout_selected(pattern) != want:
        d(descriptionMatches=pattern).click()
        time.sleep(1)
if not d(descriptionMatches=TWELVE).exists:
    snap(d, "layouts-unknown")
    raise RuntimeError("no 12 keys tile, the layout labels changed")
if not layout_selected(QWERTY) or layout_selected(TWELVE):
    snap(d, "layouts-wrong")
    raise RuntimeError("could not leave QWERTY as the only Japanese layout")
snap(d, "layouts")
tap_text(d, r"^(Done|Add)$", "done")
subtypes = subprocess.run(["adb", "shell", "dumpsys", "input_method"], capture_output=True, text=True, timeout=60).stdout
print("JA_SETUP subtypes: " + " | ".join(sorted({m for m in re.findall(r"mSubtypeName=[^ }]+|locale=\w+", subtypes)})), flush=True)
subprocess.run(["adb", "shell", "input", "keyevent", "KEYCODE_HOME"], timeout=60)
print("JA_SETUP done", flush=True)
