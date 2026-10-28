"""Turn on every Gboard text correction switch through its settings UI, then record the result.

Probe for the hypothesis that a fresh accountless image composes nothing because suggestions or the
language model are off. Every step dumps the screen to out/sugg-*.
"""
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
    with open(f"{out}/sugg-{step:02d}-{name}.xml", "w") as f:
        f.write(d.dump_hierarchy())
    d.screenshot(f"{out}/sugg-{step:02d}-{name}.png")
    print(f"SUGG step {step} {name}", flush=True)


def switches(d, name):
    """Print every switch on screen with its label and state, scrolling through the list."""
    seen = {}
    for _ in range(8):
        for sw in d(className="android.widget.Switch"):

            info = sw.info
            # The label is the title of the preference row that holds the switch.
            label = "?"
            try:
                bounds = info["bounds"]
                y = (bounds["top"] + bounds["bottom"]) // 2
                for t in d(resourceId="android:id/title"):
                    b = t.info["bounds"]
                    if b["top"] - 60 <= y <= b["bottom"] + 120:
                        label = t.info["text"]
                        break
            except Exception as e:  # keep probing, the dump has the truth
                label = f"? ({e})"
            seen[label] = info.get("checked")
        if not d(scrollable=True).exists or not d(scrollable=True).scroll.forward(steps=30):
            break
    for label, checked in seen.items():
        print(f"SUGG {name} switch {label!r} checked={checked}", flush=True)
    return seen


def turn_on_all(d, name):
    for _ in range(8):
        for sw in d(className="android.widget.Switch", checked=False):
            sw.click()
            time.sleep(0.5)
        if not d(scrollable=True).exists or not d(scrollable=True).scroll.forward(steps=30):
            break
    if d(scrollable=True).exists:
        d(scrollable=True).scroll.toBeginning()
    snap(d, f"{name}-after")


d = u2.connect()
subprocess.run(["adb", "shell", "am", "start", "-n",
                f"{GBOARD}/com.google.android.apps.inputmethod.latin.preference.SettingsActivity"], timeout=60)
time.sleep(4)
snap(d, "settings")
tc = d(textMatches=r"(?i)^Text correction$")
if not tc.wait(timeout=15):
    snap(d, "missing-text-correction")
    raise RuntimeError("no Text correction entry")
tc.click()
time.sleep(2)
snap(d, "text-correction")
switches(d, "before")
d(scrollable=True).exists and d(scrollable=True).scroll.toBeginning()
turn_on_all(d, "text-correction")
switches(d, "after")
d.press("back")
time.sleep(1)
# Language model state: the English entry under Languages shows a download row when the model is missing.
lang = d(textMatches=r"(?i)^Languages$")
if lang.wait(timeout=10):
    lang.click()
    time.sleep(2)
    snap(d, "languages")
    en = d(textMatches=r"(?i)^English.*")
    if en.exists:
        en.click()
        time.sleep(2)
        snap(d, "english")
        for t in d(textMatches=r"(?i).*(download|model|dictionar|suggest).*"):
            print(f"SUGG english row {t.info.get('text')!r}", flush=True)
subprocess.run(["adb", "shell", "input", "keyevent", "KEYCODE_HOME"], timeout=60)
print("SUGG done", flush=True)
