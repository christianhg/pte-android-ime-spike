"""Type through Gboard's own keys into a page in Android Chrome and read the result back over CDP.

Usage: python drive.py <page> <prefix> <outdir>
  page:   plain.html | editor.html
  prefix: existing text in the block ('' for the empty-block case)
"""

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


def adb(*args):
    return subprocess.run(["adb", *args], check=True, capture_output=True, text=True).stdout


def cdp_eval(expression):
    targets = requests.get(f"http://localhost:{CDP_PORT}/json", timeout=10).json()
    page = next(t for t in targets if t.get("type") == "page" and f":{PORT}/" in t.get("url", ""))
    ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=10, suppress_origin=True)
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

    adb("reverse", f"tcp:{PORT}", f"tcp:{PORT}")
    adb("forward", f"tcp:{CDP_PORT}", "localabstract:chrome_devtools_remote")
    url = f"http://localhost:{PORT}/{page}?prefix={prefix}"
    adb("shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", url, CHROME)
    time.sleep(5)

    d = u2.connect()
    # Chrome exposes the contenteditable as an EditText; tapping it focuses it and raises Gboard.
    field = d(className="android.widget.EditText")
    field.wait(timeout=20)
    field.click()
    cdp_eval("(() => { const el = document.querySelector('[contenteditable]'); el.focus(); const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); })()")
    if not d(packageName=GBOARD).wait(timeout=15):
        raise RuntimeError("Gboard window did not appear")
    time.sleep(1)

    with open(f"{out}/{tag}-keyboard.xml", "w") as f:
        f.write(d.dump_hierarchy())
    d.screenshot(f"{out}/{tag}-keyboard.png")
    labels = sorted(gboard_keys(d))
    result["gboard_labels"] = labels

    # Romaji on the Japanese QWERTY layout and plain English on the English layout use the same keys.
    for key in "kyou":
        tap_key(d, key)
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
          f"compositionstart={sum(e['type'] == 'compositionstart' for e in result['state']['events'])}")


if __name__ == "__main__":
    main()
