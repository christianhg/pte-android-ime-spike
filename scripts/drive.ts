// Type through Gboard's own keys into a page in Android Chrome and read the result back over CDP.
//
// Usage: node scripts/drive.ts <page> <prefix> <outdir>
//   page:   plain.html | editor.html
//   prefix: existing text in the block ('' for the empty-block case)

import {mkdirSync, writeFileSync} from 'node:fs'
import {adb, adbOutput} from './lib/adb.ts'
import {cdpEval, CDP_PORT, setCurrentUrl, targets} from './lib/cdp.ts'
import {packageKeys} from './lib/hierarchy.ts'
import {Device} from './lib/u2.ts'
import {errorRepr, phase, pyLen, pyRepr, pySorted, pyStr, sleep, watchdog} from './lib/util.ts'

const GBOARD = 'com.google.android.inputmethod.latin'
const CHROME = 'com.android.chrome'
const PORT = 8765

type Keys = Map<string, [number, number]>
type PageEvent = {type: string; [key: string]: unknown}
type PageState = {text: string | null; events: PageEvent[]; [key: string]: unknown}
type Result = Record<string, unknown>

// Chrome's first-run and promo screens, in case the command-line flags are ignored on this build.
const FRE_BUTTONS = ['Use without an account', 'Accept & continue', 'No thanks', 'No, thanks', 'Got it', 'Continue', 'Skip']

async function dismissChromeScreens(d: Device): Promise<void> {
  for (let i = 0; i < 6; i++) {
    let hit: string | undefined
    for (const b of FRE_BUTTONS) {
      if (await d.find({packageName: CHROME, text: b}).exists()) {
        hit = b
        break
      }
    }
    if (!hit) return
    phase(`chrome screen: tapping ${pyRepr(hit)}`)
    await d.find({packageName: CHROME, text: hit}).click()
    await sleep(1.5)
  }
}

/** Tap Wait on any "isn't responding" dialog. It steals window focus, so the keyboard never shows. */
async function dismissAnr(d: Device): Promise<number> {
  let dismissed = 0
  for (let i = 0; i < 5; i++) {
    if (!(await d.find({textContains: "isn't responding"}).exists())) break
    const title = await d.find({textContains: "isn't responding"}).getText()
    await d.find({text: 'Wait'}).click()
    dismissed += 1
    phase(`dismissed ANR dialog: ${pyStr(title)}`)
    await sleep(1)
  }
  return dismissed
}

/**
 * Map of content-desc/text -> bounds center for every node in Gboard's window.
 *
 * The accessibility dump sometimes comes back without any Gboard nodes, so retry it a few times.
 */
async function gboardKeys(d: Device): Promise<Keys> {
  let keys: Keys = new Map()
  for (let attempt = 0; attempt < 8; attempt++) {
    keys = packageKeys(await d.dumpHierarchy(), GBOARD)
    // A dump taken mid-redraw can hold only part of the keyboard. A whole layout has its space key.
    if (['Space', 'space', 'スペース'].some((k) => keys.has(k))) return keys
    if (keys.size && attempt >= 3) return keys
    phase(`a11y dump incomplete, ${keys.size} Gboard nodes (attempt ${attempt + 1}), retrying`)
    await sleep(1.5)
  }
  return keys
}

async function tapKey(d: Device, label: string): Promise<void> {
  const keys = await gboardKeys(d)
  for (const candidate of [label, label.toUpperCase()]) {
    const at = keys.get(candidate)
    if (at) {
      await d.click(...at)
      await sleep(0.4)
      return
    }
  }
  throw new Error(`no Gboard node labelled ${pyRepr(label)}; labels: ${pyRepr(pySorted(keys.keys()).slice(0, 80))}`)
}

const JA_HINTS = ['あ', 'かな', '変換', '空白', '確定', 'ABC', '記号']

export function isJapanese(keys: Iterable<string>): boolean {
  for (const k of keys) if (JA_HINTS.some((h) => k.includes(h))) return true
  return false
}

/** Gboard opens on English. Tap its language key until the Japanese layout shows. */
async function ensureJapanese(d: Device, out: string, tag: string): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const keys = await gboardKeys(d)
    if (isJapanese(keys.keys())) {
      if (!keys.has('k') && !keys.has('K')) throw new Error(`japanese layout is not romaji QWERTY, labels ${pyRepr(pySorted(keys.keys()).slice(0, 60))}`)
      phase(`japanese layout active after ${attempt} switches`)
      return
    }
    writeFileSync(`${out}/${tag}-lang-${attempt}.xml`, await d.dumpHierarchy())
    // Gboard v15 shows a "Japanese is now installed" banner over the keyboard. Its text mentions the
    // globe key, so close it first and only ever tap the language key itself.
    const banner = [...keys.keys()].filter((k) => k.toLowerCase().startsWith('close the new language'))
    if (banner.length) {
      phase('closing the new language banner')
      await d.click(...keys.get(banner[0]!)!)
      await sleep(1)
      continue
    }
    const languageKeys = [...keys.keys()].filter((k) => /^(next language|switch to|globe)/i.test(k))
    phase(`not japanese yet, language keys ${pyRepr(languageKeys)}, labels ${pyRepr(pySorted(keys.keys()).slice(0, 60))}`)
    if (languageKeys.length) {
      await d.click(...keys.get(languageKeys[0]!)!)
    } else {
      // The space bar cycles languages on a long swipe, and long-press opens the picker.
      const sp = keys.get('Space') ?? keys.get('space')
      if (!sp) break
      await d.swipe(sp[0] - 150, sp[1], sp[0] + 150, sp[1], 0.3)
    }
    await sleep(1.5)
  }
  throw new Error('could not switch Gboard to Japanese')
}

function isAscii(value: string): boolean {
  return /^[\x00-\x7f]*$/.test(value)
}

async function typeWord(d: Device, out: string, tag: string, result: Result, n: string): Promise<void> {
  for (const key of 'kyou') await tapKey(d, key)
  phase(`typed kyou (${n})`)
  await d.screenshot(`${out}/${tag}-composing${n}`)
  result[`composing${n}`] = await cdpEval('window.__state()')
  // Gboard v15 sometimes shows only the kana candidate first and adds the kanji a moment later.
  let keys = await gboardKeys(d)
  if (process.env.IME_LANG === 'ja') {
    for (let i = 0; i < 6; i++) {
      if (keys.has('今日') || keys.has('用')) break
      await sleep(0.5)
      keys = await gboardKeys(d)
    }
  }
  result[`candidates${n}`] = [...keys.keys()].filter((k) => pyLen(k) <= 6 && !isAscii(k)).slice(0, 30)
  const kanji = keys.get('今日')
  if (kanji) {
    await d.click(...kanji)
    result[`picked${n}`] = '今日'
  } else {
    keys = await gboardKeys(d)
    await tapKey(d, keys.has('スペース') ? 'スペース' : 'Space') // the Japanese layout labels it スペース
    result[`picked${n}`] = 'space'
  }
  await sleep(1.5)
  await d.screenshot(`${out}/${tag}-after${n}`)
}

/** Count compositionstart events that arrive while an earlier composition is still open. */
export function nestedCompositionstart(events: PageEvent[]): number {
  let nested = 0
  let open = false
  for (const e of events) {
    if (e.type === 'compositionstart') {
      if (open) nested += 1
      open = true
    } else if (e.type === 'compositionend') {
      open = false
    }
  }
  return nested
}

export function resultLine(tag: string, text: string | null, picked: string, events: PageEvent[], nested: number, secondWord: number, lang: string): string {
  const starts = events.filter((e) => e.type === 'compositionstart').length
  return `RESULT ${tag}: text=${pyRepr(text)} picked=${picked} compositionstart=${starts} nested=${nested} second_word_compositionstart=${secondWord} lang=${lang}`
}

/** The driver only types the letters of "kyou". A digit means a tap landed as a long press on a key's number hint. */
export function hasDigit(text: string | null): boolean {
  return /[0-9０-９]/.test(text ?? '')
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2))
}

async function main(): Promise<void> {
  const [page, prefix, out] = process.argv.slice(2) as [string, string, string]
  mkdirSync(out, {recursive: true})
  const tag = `${page.split('.')[0]}-${prefix ? 'prefix' : 'empty'}`
  const result: Result = {page, prefix}
  // Say what the driver is blocked on shortly before the shell's timeout kills it.
  watchdog(165)
  phase(`start ${tag}`)

  try {
    await run(page, prefix, out, tag, result)
  } catch (error) {
    phase('FAILED, dumping screen')
    // A fresh connection, as the Python driver made: its run() never handed the device back on failure.
    let d: Device | undefined
    try {
      d = await Device.connect()
    } catch (e) {
      console.log(`u2 connect for dump failed: ${errorRepr(e)}`)
    }
    if (d !== undefined) {
      try {
        writeFileSync(`${out}/${tag}-fail.xml`, await d.dumpHierarchy())
        await d.screenshot(`${out}/${tag}-fail`)
      } catch (e) {
        console.log(`dump failed: ${errorRepr(e)}`)
      }
    }
    throw error
  }
}

async function run(page: string, prefix: string, out: string, tag: string, result: Result): Promise<void> {
  await adb(['reverse', `tcp:${PORT}`, `tcp:${PORT}`])
  await adb(['forward', `tcp:${CDP_PORT}`, 'localabstract:chrome_devtools_remote'])
  phase('adb reverse/forward set')

  let d = await Device.connect()
  d.waitTimeout = 10
  // Each case starts a fresh UiAutomator server, and its first call can land before it listens.
  let info: Record<string, unknown> | undefined
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      info = await d.info()
      break
    } catch (error) {
      phase(`uiautomator2 not ready (${attempt + 1}): ${errorRepr(error)}`)
      await sleep(2)
      d = await Device.connect()
    }
  }
  info ??= await d.info()
  phase(`uiautomator2 up: ${pyStr(info.productName)} ${pyRepr(await d.windowSize()).replace(/^\[(.*)\]$/, '($1)')}`)

  const url = `http://localhost:${PORT}/${page}?prefix=${prefix}`
  setCurrentUrl(url)
  await adb(['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', url, CHROME])
  phase('chrome launched')
  await sleep(4)
  await dismissChromeScreens(d)
  phase(`foreground: ${pyRepr(await d.appCurrent())}`)

  let last: unknown
  let loaded = false
  for (let i = 0; i < 20; i++) {
    try {
      if ((await cdpEval('document.readyState')) === 'complete' && (await cdpEval('typeof window.__state')) === 'function') {
        loaded = true
        break
      }
    } catch (error) {
      last = error
      phase(`cdp not ready: ${errorRepr(error)}`)
      try {
        const ts = await targets(5)
        phase('targets: ' + ts.map((t) => `${pyStr(t.type)} ${pyStr(t.url)} attached=${pyRepr(t.attached)}`).join('; '))
      } catch (e2) {
        phase(`targets unavailable: ${errorRepr(e2)}`)
      }
    }
    await sleep(1)
  }
  if (!loaded) throw new Error(`page never loaded over CDP: ${last === undefined ? 'None' : errorRepr(last)}`)
  phase(`page loaded: ${pyStr(await cdpEval('location.href'))}`)

  await dismissAnr(d)
  phase(`before field lookup: ${pyRepr(await d.appCurrent())}`)
  await d.screenshot(`${out}/${tag}-loaded`)
  if ((await d.appCurrent()).package !== CHROME) {
    await adb(['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', url, CHROME])
    await sleep(3)
    phase(`re-foregrounded: ${pyRepr(await d.appCurrent())}`)
  }
  // Chrome exposes the contenteditable as an EditText; tapping it focuses it and raises Gboard.
  // Web content is not reliably in the UiAutomator tree, so locate the field through the page and tap it on screen.
  const rect = (await cdpEval("(() => { const el = document.querySelector('[contenteditable]'); el.style.minHeight = '50vh'; const r = el.getBoundingClientRect(); return {x: r.left + r.width / 2, y: r.top + r.height / 2, dpr: devicePixelRatio, ih: innerHeight, sh: screen.height}; })()")) as {x: number; y: number; dpr: number; ih: number; sh: number}
  const [w, h] = await d.windowSize()
  // Chrome's content area starts below the status bar and toolbar; derive its offset from the screen/viewport difference.
  const offset = (rect.sh - rect.ih) * rect.dpr
  const x = Math.trunc(rect.x * rect.dpr)
  const y = Math.trunc(rect.y * rect.dpr + offset)
  phase(`field rect ${pyRepr(rect)}, tapping ${x},${y} on ${w}x${h}`)
  await d.click(x, y)
  await sleep(1)
  await cdpEval('(() => { const el = document.querySelector(\'[contenteditable]\'); el.focus(); const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); })()')
  phase(`field focused: activeElement=${pyRepr(await cdpEval('document.activeElement && document.activeElement.isContentEditable'))}`)
  let shown = false
  let ims = ''
  for (let attempt = 0; attempt < 4; attempt++) {
    for (let i = 0; i < 6; i++) {
      ims = await adb(['shell', 'dumpsys', 'input_method'])
      shown = ims.includes('mInputShown=true') || ims.includes('mIsInputViewShown=true')
      if (shown) break
      await sleep(1)
    }
    if (shown) break
    phase(`keyboard not shown after tap ${attempt + 1}, foreground ${pyRepr(await d.appCurrent())}, tapping again`)
    await dismissAnr(d)
    if ((await d.appCurrent()).package !== CHROME) {
      await adb(['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', url, CHROME])
      await sleep(3)
    }
    await d.click(x, y)
    await sleep(1)
  }
  const focus = (await adb(['shell', 'dumpsys', 'window'])).split(/\r?\n/).filter((l) => l.includes('mCurrentFocus') || l.includes('mInputMethodWindow')).map((l) => l.trim())
  phase(`ime shown=${pyRepr(shown)}, windows: ${pyRepr(focus)}`)
  phase(`gboard in a11y tree: ${pyRepr(await d.find({packageName: GBOARD}).exists())}, chrome in a11y tree: ${pyRepr(await d.find({packageName: CHROME}).exists())}`)
  if (!shown) {
    writeFileSync(`${out}/${tag}-ims.txt`, ims)
    throw new Error('Gboard window did not appear')
  }
  phase('keyboard visible')
  await sleep(1)

  writeFileSync(`${out}/${tag}-keyboard.xml`, await d.dumpHierarchy())
  await d.screenshot(`${out}/${tag}-keyboard`)
  if (process.env.IME_LANG === 'ja') await ensureJapanese(d, out, tag)
  const labels = pySorted((await gboardKeys(d)).keys())
  result.gboard_labels = labels
  phase(`keys found: ${labels.length} labels, sample ${pyRepr(labels.slice(0, 40))}`)

  // Romaji on the Japanese QWERTY layout and plain English on the English layout use the same keys.
  await typeWord(d, out, tag, result, '1')
  result.after_first = await cdpEval('window.__state()')
  const firstLen = (result.after_first as PageState).events.length
  await typeWord(d, out, tag, result, '2')
  const state = (await cdpEval('window.__state()')) as PageState
  result.state = state
  const second = state.events.slice(firstLen)
  result.second_word_compositionstart = second.filter((e) => e.type === 'compositionstart').length
  result.picked = `${pyStr(result.picked1)}/${pyStr(result.picked2)}`

  writeJson(`${out}/${tag}.json`, result)
  const events = state.events
  // The #3376 signal: a compositionstart that arrives while an earlier composition is still open.
  const nested = nestedCompositionstart(events)
  result.nested_compositionstart = nested
  writeJson(`${out}/${tag}.json`, result)
  // The driver only types the letters of "kyou". A digit means a tap landed as a long press on a key's
  // number hint, which is a driver fault and not an editor result, so fail the case and let it retry.
  if (hasDigit(state.text)) throw new Error(`mistap: digit in typed text ${pyRepr(state.text)}`)
  console.log(resultLine(tag, state.text, result.picked as string, events, nested, result.second_word_compositionstart as number, process.env.IME_LANG ?? 'en'))
}

if (import.meta.main) {
  main().then(
    () => process.exit(0),
    (error: unknown) => {
      console.error(error instanceof Error ? (error.stack ?? errorRepr(error)) : String(error))
      process.exit(1)
    },
  )
}
