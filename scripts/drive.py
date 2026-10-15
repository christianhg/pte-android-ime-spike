"""Type through Gboard's own keys into a page in Android Chrome and read the result back over CDP.

Usage: python drive.py <page> <prefix> <outdir>
  page:   plain.html | editor.html
  prefix: existing text in the block ('' for the empty-block case)
"""

import faulthandler
import json
import os
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
    page = next(t for t in targets if t.get("type") == "page" and f":{PORT}/" in t.get("url", ""))
    ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=10, suppress_origin=True)
    ws.settimeout(10)
    ws.send(json.dumps({"id": 1, "method": "Runtime.evaluate", "params": {"expression": expression, "returnByValue": True}}))
    while True:
        msg = json.loads(ws.recv())
        if msg.get("id") == 1:
            ws.close()
            return msg["result"]["result"].get("value")


def gboard_keys(d):
    """Map of content-desc/text -> bounds center for every node in Gboard's window."""
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

    url = f"http://localhost:{PORT}/{page}?prefix={prefix}"
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
        time.sleep(1)
    else:
        raise RuntimeError(f"page never loaded over CDP: {last!r}")
    phase(f"page loaded: {cdp_eval('location.href')}")

    phase(f"before field lookup: {d.app_current()}")
    d.screenshot(f"{out}/{tag}-loaded.png")
    if d.app_current().get("package") != CHROME:
        adb("shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", url, CHROME)
        time.sleep(3)
        phase(f"re-foregrounded: {d.app_current()}")
    # Chrome exposes the contenteditable as an EditText; tapping it focuses it and raises Gboard.
    field = d(className="android.widget.EditText")
    for i in range(10):
        if field.exists:
            break
        phase(f"waiting for EditText {i}: {d.app_current()}")
        time.sleep(2)
    else:
        raise RuntimeError("no EditText in Chrome")
    field.click()
    cdp_eval("(() => { const el = document.querySelector('[contenteditable]'); el.focus(); const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); })()")
    phase(f"field focused: activeElement={cdp_eval('document.activeElement && document.activeElement.isContentEditable')}")
    if not d(packageName=GBOARD).wait(timeout=15):
        raise RuntimeError("Gboard window did not appear")
    phase("keyboard visible")
    time.sleep(1)

    with open(f"{out}/{tag}-keyboard.xml", "w") as f:
        f.write(d.dump_hierarchy())
    d.screenshot(f"{out}/{tag}-keyboard.png")
    labels = sorted(gboard_keys(d))
    result["gboard_labels"] = labels
    phase(f"keys found: {len(labels)} labels, sample {labels[:40]}")

    # Romaji on the Japanese QWERTY layout and plain English on the English layout use the same keys.
    for key in "kyou":
        tap_key(d, key)
    phase("typed kyou")
    d.screenshot(f"{out}/{tag}-composing.png")
    result["composing"] = cdp_eval("window.__state()")

    keys = gboard_keys(d)
    result["candidates"] = [k for k in keys if len(k) <= 6 and not k.isascii()][:30]
    if "今日" in keys:
        d.click(*keys["今日"])
        result["picked"] = "今日"
    else:
        result["picked"] = None
    time.sleep(1.5)
    d.screenshot(f"{out}/{tag}-after.png")
    result["state"] = cdp_eval("window.__state()")

    with open(f"{out}/{tag}.json", "w") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    print(f"RESULT {tag}: text={result['state']['text']!r} picked={result['picked']} "
          f"compositionstart={sum(e['type'] == 'compositionstart' for e in result['state']['events'])}", flush=True)
    return d


if __name__ == "__main__":
    main()
