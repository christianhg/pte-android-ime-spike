"""Type through Gboard's own keys into a page in Android Chrome and read the result back over CDP.

Usage: python drive.py <page> <prefix> <outdir>
  page:   plain.html | editor.html
  prefix: existing text in the block ('' for the empty-block case)
"""

import faulthandler
import json
import os
import re
import subprocess
import sys
import time

import requests
import uiautomator2 as u2
import websocket

GBOARD = "com.google.android.inputmethod.latin"
CHROME = "com.android.chrome"
PORT = 8765
CDP_PORT = 9222
CURRENT_URL = ""


T0 = time.time()


def phase(msg):
    print(f"PHASE +{time.time() - T0:5.1f}s {msg}", flush=True)


def adb(*args):
    return subprocess.run(["adb", *args], check=True, capture_output=True, text=True, timeout=30).stdout


# Chrome's first-run and promo screens, in case the command-line flags are ignored on this build.
FRE_BUTTONS = ["Use without an account", "Accept & continue", "No thanks", "No, thanks", "Got it", "Continue", "Skip"]


def dismiss_chrome_screens(d):
    for _ in range(6):
        hit = next((b for b in FRE_BUTTONS if d(packageName=CHROME, text=b).exists), None)
        if not hit:
            return
        phase(f"chrome screen: tapping {hit!r}")
        d(packageName=CHROME, text=hit).click()
        time.sleep(1.5)


def cdp_eval(expression):
    targets = requests.get(f"http://localhost:{CDP_PORT}/json", timeout=10).json()
    page = next(t for t in targets if t.get("type") == "page" and t.get("url", "").startswith(CURRENT_URL))
    ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=10, suppress_origin=True)
    ws.settimeout(10)
    ws.send(json.dumps({"id": 1, "method": "Runtime.evaluate", "params": {"expression": expression, "returnByValue": True}}))
    while True:
        msg = json.loads(ws.recv())
        if msg.get("id") == 1:
            ws.close()
            return msg["result"]["result"].get("value")


def dismiss_anr(d):
    """Tap Wait on any "isn't responding" dialog. It steals window focus, so the keyboard never shows."""
    dismissed = 0
    for _ in range(5):
        if not d(textContains="isn't responding").exists:
            break
        title = d(textContains="isn't responding").get_text()
        d(text="Wait").click()
        dismissed += 1
        phase(f"dismissed ANR dialog: {title}")
        time.sleep(1)
    return dismissed


def gboard_keys(d):
    """Map of content-desc/text -> bounds center for every node in Gboard's window.

    The accessibility dump sometimes comes back without any Gboard nodes, so retry it a few times.
    """
    keys = {}
    for attempt in range(4):
        keys = _gboard_keys_once(d)
        if keys:
            return keys
        phase(f"a11y dump had no Gboard nodes (attempt {attempt + 1}), retrying")
        time.sleep(1.5)
    return keys


def _gboard_keys_once(d):
    import xml.etree.ElementTree as ET

    keys = {}
    for node in ET.fromstring(d.dump_hierarchy()).iter("node"):
        if node.get("package") != GBOARD:
            continue
        label = node.get("content-desc") or node.get("text")
        if not label:
            continue
        l, t, r, b = map(int, node.get("bounds").replace("][", ",").strip("[]").split(","))
        keys.setdefault(label, ((l + r) // 2, (t + b) // 2))
    return keys


def tap_key(d, label):
    keys = gboard_keys(d)
    for candidate in (label, label.upper()):
        if candidate in keys:
            d.click(*keys[candidate])
            time.sleep(0.4)
            return
    raise RuntimeError(f"no Gboard node labelled {label!r}; labels: {sorted(keys)[:80]}")


JA_HINTS = ("あ", "かな", "変換", "空白", "確定", "ABC", "記号")


def is_japanese(keys):
    return any(h in k for k in keys for h in JA_HINTS)


def ensure_japanese(d, out, tag):
    """Gboard opens on English. Tap its language key until the Japanese layout shows."""
    for attempt in range(6):
        keys = gboard_keys(d)
        if is_japanese(keys):
            if "k" not in keys and "K" not in keys:
                raise RuntimeError(f"japanese layout is not romaji QWERTY, labels {sorted(keys)[:60]}")
            phase(f"japanese layout active after {attempt} switches")
            return
        with open(f"{out}/{tag}-lang-{attempt}.xml", "w") as f:
            f.write(d.dump_hierarchy())
        # Gboard v15 shows a "Japanese is now installed" banner over the keyboard. Its text mentions the
        # globe key, so close it first and only ever tap the language key itself.
        banner = [k for k in keys if k.lower().startswith("close the new language")]
        if banner:
            phase("closing the new language banner")
            d.click(*keys[banner[0]])
            time.sleep(1)
            continue
        switch = [k for k in keys if re.search(r"(?i)^(next language|switch to|globe)", k)]
        phase(f"not japanese yet, language keys {switch}, labels {sorted(keys)[:60]}")
        if switch:
            d.click(*keys[switch[0]])
        else:
            # The space bar cycles languages on a long swipe, and long-press opens the picker.
            sp = keys.get("Space") or keys.get("space")
            if not sp:
                break
            d.swipe(sp[0] - 150, sp[1], sp[0] + 150, sp[1], 0.3)
        time.sleep(1.5)
    raise RuntimeError("could not switch Gboard to Japanese")


def type_word(d, out, tag, result, n):
    for key in "kyou":
        tap_key(d, key)
    phase(f"typed kyou ({n})")
    d.screenshot(f"{out}/{tag}-composing{n}.png")
    result[f"composing{n}"] = cdp_eval("window.__state()")
    keys = gboard_keys(d)
    result[f"candidates{n}"] = [k for k in keys if len(k) <= 6 and not k.isascii()][:30]
    if "今日" in keys:
        d.click(*keys["今日"])
        result[f"picked{n}"] = "今日"
    else:
        keys = gboard_keys(d)
        tap_key(d, "スペース" if "スペース" in keys else "Space")  # the Japanese layout labels it スペース
        result[f"picked{n}"] = "space"
    time.sleep(1.5)
    d.screenshot(f"{out}/{tag}-after{n}.png")


def main():
    page, prefix, out = sys.argv[1], sys.argv[2], sys.argv[3]
    os.makedirs(out, exist_ok=True)
    tag = f"{page.split('.')[0]}-{'empty' if not prefix else 'prefix'}"
    result = {"page": page, "prefix": prefix}
    # Print every thread's stack shortly before the shell's timeout kills us.
    faulthandler.dump_traceback_later(165, exit=False)
    phase(f"start {tag}")

    d = None
    try:
        d = run(page, prefix, out, tag, result)
    except Exception:
        phase("FAILED, dumping screen")
        if d is None:
            try:
                d = u2.connect()
            except Exception as e:
                print(f"u2 connect for dump failed: {e!r}", flush=True)
        if d is not None:
            try:
                with open(f"{out}/{tag}-fail.xml", "w") as f:
                    f.write(d.dump_hierarchy())
                d.screenshot(f"{out}/{tag}-fail.png")
            except Exception as e:
                print(f"dump failed: {e!r}", flush=True)
        raise


def run(page, prefix, out, tag, result):
    adb("reverse", f"tcp:{PORT}", f"tcp:{PORT}")
    adb("forward", f"tcp:{CDP_PORT}", "localabstract:chrome_devtools_remote")
    phase("adb reverse/forward set")

    d = u2.connect()
    d.settings["wait_timeout"] = 10
    phase(f"uiautomator2 up: {d.info.get('productName')} {d.window_size()}")

    global CURRENT_URL
    url = f"http://localhost:{PORT}/{page}?prefix={prefix}"
    CURRENT_URL = url
    adb("shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", url, CHROME)
    phase("chrome launched")
    time.sleep(4)
    dismiss_chrome_screens(d)
    phase(f"foreground: {d.app_current()}")

    last = None
    for _ in range(20):
        try:
            if cdp_eval("document.readyState") == "complete" and cdp_eval("typeof window.__state") == "function":
                break
        except Exception as e:
            last = e
            phase(f"cdp not ready: {e!r}")
            try:
                ts = requests.get(f"http://localhost:{CDP_PORT}/json", timeout=5).json()
                phase("targets: " + "; ".join(f"{t.get('type')} {t.get('url')} attached={t.get('attached')}" for t in ts))
            except Exception as e2:
                phase(f"targets unavailable: {e2!r}")
        time.sleep(1)
    else:
        raise RuntimeError(f"page never loaded over CDP: {last!r}")
    phase(f"page loaded: {cdp_eval('location.href')}")

    dismiss_anr(d)
    phase(f"before field lookup: {d.app_current()}")
    d.screenshot(f"{out}/{tag}-loaded.png")
    if d.app_current().get("package") != CHROME:
        adb("shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", url, CHROME)
        time.sleep(3)
        phase(f"re-foregrounded: {d.app_current()}")
    # Chrome exposes the contenteditable as an EditText; tapping it focuses it and raises Gboard.
    # Web content is not reliably in the UiAutomator tree, so locate the field through the page and tap it on screen.
    rect = cdp_eval("(() => { const el = document.querySelector('[contenteditable]'); el.style.minHeight = '50vh'; const r = el.getBoundingClientRect(); return {x: r.left + r.width / 2, y: r.top + r.height / 2, dpr: devicePixelRatio, ih: innerHeight, sh: screen.height}; })()")
    w, h = d.window_size()
    # Chrome's content area starts below the status bar and toolbar; derive its offset from the screen/viewport difference.
    offset = (rect["sh"] - rect["ih"]) * rect["dpr"]
    x, y = int(rect["x"] * rect["dpr"]), int(rect["y"] * rect["dpr"] + offset)
    phase(f"field rect {rect}, tapping {x},{y} on {w}x{h}")
    d.click(x, y)
    time.sleep(1)
    cdp_eval("(() => { const el = document.querySelector('[contenteditable]'); el.focus(); const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); })()")
    phase(f"field focused: activeElement={cdp_eval('document.activeElement && document.activeElement.isContentEditable')}")
    shown = False
    for attempt in range(4):
        for i in range(6):
            ims = adb("shell", "dumpsys", "input_method")
            shown = "mInputShown=true" in ims or "mIsInputViewShown=true" in ims
            if shown:
                break
            time.sleep(1)
        if shown:
            break
        phase(f"keyboard not shown after tap {attempt + 1}, foreground {d.app_current()}, tapping again")
        dismiss_anr(d)
        if d.app_current().get("package") != CHROME:
            adb("shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", url, CHROME)
            time.sleep(3)
        d.click(x, y)
        time.sleep(1)
    focus = [l.strip() for l in adb("shell", "dumpsys", "window").splitlines() if "mCurrentFocus" in l or "mInputMethodWindow" in l]
    phase(f"ime shown={shown}, windows: {focus}")
    phase(f"gboard in a11y tree: {d(packageName=GBOARD).exists}, chrome in a11y tree: {d(packageName=CHROME).exists}")
    if not shown:
        with open(f"{out}/{tag}-ims.txt", "w") as f:
            f.write(ims)
        raise RuntimeError("Gboard window did not appear")
    phase("keyboard visible")
    time.sleep(1)

    with open(f"{out}/{tag}-keyboard.xml", "w") as f:
        f.write(d.dump_hierarchy())
    d.screenshot(f"{out}/{tag}-keyboard.png")
    if os.environ.get("IME_LANG") == "ja":
        ensure_japanese(d, out, tag)
    labels = sorted(gboard_keys(d))
    result["gboard_labels"] = labels
    phase(f"keys found: {len(labels)} labels, sample {labels[:40]}")

    # Romaji on the Japanese QWERTY layout and plain English on the English layout use the same keys.
    type_word(d, out, tag, result, "1")
    result["after_first"] = cdp_eval("window.__state()")
    first_len = len(result["after_first"]["events"])
    type_word(d, out, tag, result, "2")
    result["state"] = cdp_eval("window.__state()")
    second = result["state"]["events"][first_len:]
    result["second_word_compositionstart"] = sum(e["type"] == "compositionstart" for e in second)
    result["picked"] = result["picked1"] + "/" + result["picked2"]

    with open(f"{out}/{tag}.json", "w") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    events = result['state']['events']
    # The #3376 signal: a compositionstart that arrives while an earlier composition is still open.
    nested, open_ = 0, False
    for e in events:
        if e['type'] == 'compositionstart':
            nested += open_
            open_ = True
        elif e['type'] == 'compositionend':
            open_ = False
    result['nested_compositionstart'] = nested
    with open(f"{out}/{tag}.json", "w") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    print(f"RESULT {tag}: text={result['state']['text']!r} picked={result['picked']} "
          f"compositionstart={sum(e['type'] == 'compositionstart' for e in events)} nested={nested} "
          f"second_word_compositionstart={result['second_word_compositionstart']} lang={os.environ.get('IME_LANG', 'en')}", flush=True)
    return d


if __name__ == "__main__":
    main()
