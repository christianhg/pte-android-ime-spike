// Probe which Gboard keyboard actions reach the editor, in English and in one other language.
//
// Each action starts from a reloaded editor with one empty block, so actions do not depend on each other.
// After every step it records the editor value, the DOM text, the DOM selection and the full
// composition/beforeinput/input event log. An action ends ok, failed or unsupported, with a reason, and the
// probe moves on either way.
//
// Prints one line per action:
//   PROBE lang=ko layout=ko action=word status=ok text='한국 ' reason=''
// and writes everything to <outdir>/probe-<lang>.json.
//
// Usage: node scripts/probe.ts <lang> <outdir>

import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs'
import {adb, adbOutput} from './lib/adb.ts'
import {cdpEval, CDP_PORT, setCurrentUrl} from './lib/cdp.ts'
import {dismissAnr, dismissChromeScreens} from './drive.ts'
import {
  charKey,
  classifyLayout,
  cssToScreen,
  firstCandidate,
  GBOARD,
  gboardNodes,
  LANGS,
  onLayout,
  pickEmoji,
  roleKey,
  subtypeLocale,
  webViewBounds,
  type GNode,
  type Lang,
  type Role,
  type Viewport,
} from './lib/gboard.ts'
import {Device} from './lib/u2.ts'
import {errorRepr, phase, pyRepr, sleep} from './lib/util.ts'

const CHROME = 'com.android.chrome'
const PORT = 8765
const URL_ = `http://localhost:${PORT}/editor.html?prefix=`
const ACTION_TIMEOUT = 75

type PageEvent = {type: string; inputType?: string; data?: string | null}
type Selection = {inEditor: boolean; anchor?: number; focus?: number; selected?: string; collapsed?: boolean}
type Step = {step: string; text: string | null; dom: string | null; selection: Selection; events: PageEvent[]; [key: string]: unknown}
export type Status = 'ok' | 'failed' | 'unsupported'
type ActionResult = {action: string; layout: string; status: Status; reason: string; steps: Step[]; [key: string]: unknown}

export class Unsupported extends Error {
  override name = 'Unsupported'
}

// An action that timed out keeps running until its next key lookup or page read, which then throws.
let deadline = Infinity

function checkDeadline(): void {
  if (Date.now() > deadline) throw new Error('action deadline passed')
}

// --- page --------------------------------------------------------------------------------------------

// Offsets count UTF-16 units of the editable's text from its start, as Range.toString() gives them.
const OFFSET_JS = `const root = document.querySelector('[contenteditable]');
const offsetOf = (node, off) => { const r = document.createRange(); r.setStart(root, 0); r.setEnd(node, off); return r.toString().length };`

const SELECTION_JS = `(() => { ${OFFSET_JS}
  const s = getSelection();
  if (!s.rangeCount || !root.contains(s.anchorNode)) return {inEditor: false};
  return {inEditor: true, anchor: offsetOf(s.anchorNode, s.anchorOffset), focus: offsetOf(s.focusNode, s.focusOffset), selected: s.toString(), collapsed: s.isCollapsed};
})()`

/**
 * Geometry of the grapheme nearest the middle of the editable's text: its client rect, the offset where it
 * starts, the offset Chrome itself would place the caret at for a point on its leading edge, and the
 * viewport needed to convert to screen pixels.
 */
const MIDDLE_GRAPHEME_JS = `(() => { ${OFFSET_JS}
  const text = root.textContent;
  const bounds = [...new Intl.Segmenter().segment(text)].map((g) => g.index).filter((i) => i > 0);
  if (!bounds.length) return null;
  const k = bounds.reduce((a, b) => Math.abs(b - text.length / 2) < Math.abs(a - text.length / 2) ? b : a);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let seen = 0, node;
  while ((node = walker.nextNode())) { if (seen + node.length > k) break; seen += node.length }
  if (!node) return null;
  const r = document.createRange(); r.setStart(node, k - seen); r.setEnd(node, k - seen + 1);
  const b = r.getBoundingClientRect();
  const rtl = getComputedStyle(node.parentElement).direction === 'rtl' || /[\\u0590-\\u08ff]/.test(text);
  const edge = rtl ? b.right - 1 : b.left + 1;
  const caret = document.caretRangeFromPoint(edge, (b.top + b.bottom) / 2);
  const vv = visualViewport;
  return {k, rect: {left: b.left, right: b.right, top: b.top, bottom: b.bottom}, edge, rtl,
    caretAtEdge: caret && root.contains(caret.startContainer) ? offsetOf(caret.startContainer, caret.startOffset) : null,
    word: text.slice(0, text.trimEnd().length),
    viewport: {dpr: devicePixelRatio, offsetLeft: vv.offsetLeft, offsetTop: vv.offsetTop, scale: vv.scale}};
})()`

const FIELD_JS = `(() => { const el = document.querySelector('[contenteditable]'); el.style.minHeight = '30vh'; const b = el.getBoundingClientRect(); const vv = visualViewport;
  return {x: b.left + b.width / 2, y: b.top + Math.min(b.height / 2, 40), viewport: {dpr: devicePixelRatio, offsetLeft: vv.offsetLeft, offsetTop: vv.offsetTop, scale: vv.scale}} })()`

async function pageStep(step: string, extra: Record<string, unknown> = {}): Promise<Step> {
  checkDeadline()
  const state = (await cdpEval('window.__state()')) as {text: string | null; dom?: string | null; events: PageEvent[]}
  const selection = (await cdpEval(SELECTION_JS)) as Selection
  return {step, text: state.text, dom: state.dom ?? null, selection, events: state.events, ...extra}
}

async function waitForPage(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    try {
      if ((await cdpEval('document.readyState')) === 'complete' && (await cdpEval('typeof window.__state')) === 'function') return
    } catch (error) {
      phase(`cdp not ready: ${errorRepr(error)}`)
    }
    await sleep(1)
  }
  throw new Error('page never loaded over CDP')
}

async function toScreen(d: Device, x: number, y: number, viewport: Viewport): Promise<[number, number]> {
  const webView = webViewBounds(await d.dumpHierarchy())
  if (!webView) throw new Error('no WebView in the hierarchy')
  return cssToScreen(x, y, webView, viewport)
}

async function imeShown(): Promise<boolean> {
  const ims = await adb(['shell', 'dumpsys', 'input_method'])
  return ims.includes('mInputShown=true') || ims.includes('mIsInputViewShown=true')
}

/** Reload the editor to one empty block, tap it and wait for Gboard. */
async function freshEditor(d: Device): Promise<void> {
  await cdpEval('location.reload()').catch(() => undefined)
  await sleep(1.5)
  await waitForPage()
  await dismissAnr(d)
  if ((await d.appCurrent()).package !== CHROME) {
    await adb(['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', URL_, CHROME])
    await sleep(3)
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    const field = (await cdpEval(FIELD_JS)) as {x: number; y: number; viewport: Viewport}
    await d.click(...(await toScreen(d, field.x, field.y, field.viewport)))
    for (let i = 0; i < 6; i++) {
      // The keyboard can linger from before the reload, so the editor must hold focus too.
      if ((await imeShown()) && (await cdpEval('!!document.activeElement?.isContentEditable'))) {
        await sleep(0.8)
        return
      }
      await sleep(1)
    }
    phase(`keyboard not shown or editor not focused after tap ${attempt + 1}`)
  }
  throw new Error('Gboard did not appear over the editor')
}

// --- keyboard ----------------------------------------------------------------------------------------

/** Gboard's nodes. A dump taken mid-redraw can miss half the keyboard, so retry until Space is there. */
async function keys(d: Device): Promise<GNode[]> {
  let nodes: GNode[] = []
  for (let attempt = 0; attempt < 6; attempt++) {
    checkDeadline()
    nodes = gboardNodes(await d.dumpHierarchy())
    if (roleKey(nodes, 'space')) return nodes
    await sleep(1)
  }
  return nodes
}

async function tapRole(d: Device, role: Role): Promise<GNode> {
  const key = roleKey(await keys(d), role)
  if (!key) throw new Error(`no ${role} key`)
  await d.click(key.x, key.y)
  await sleep(0.4)
  return key
}

const labels = (nodes: GNode[]) => nodes.map((n) => n.label).slice(0, 80)

/** Tap the key for `ch`: on the base layer, under Shift, or in the long-press popup of a base key. */
async function typeChar(d: Device, lang: Lang, ch: string): Promise<void> {
  let nodes = await keys(d)
  const direct = charKey(nodes, ch)
  if (direct) {
    await d.click(direct.x, direct.y)
    await sleep(0.4)
    return
  }
  const base = lang.longPress?.[ch]
  const holder = base ? charKey(nodes, base) : undefined
  if (holder) {
    await d.touch('down', holder.x, holder.y)
    await sleep(0.9)
    const popup = charKey(gboardNodes(await d.dumpHierarchy()).filter((n) => n !== holder && n.y < holder.y), ch)
    if (popup) {
      await d.touch('move', popup.x, popup.y)
      await sleep(0.2)
      await d.touch('up', popup.x, popup.y)
    } else {
      await d.touch('up', holder.x, holder.y)
      throw new Error(`no ${pyRepr(ch)} in the long-press popup of ${pyRepr(base)}`)
    }
    await sleep(0.4)
    return
  }
  const shift = roleKey(nodes, 'shift')
  if (shift) {
    await d.click(shift.x, shift.y)
    await sleep(0.6)
    nodes = await keys(d)
    const shifted = charKey(nodes, ch)
    if (shifted) {
      await d.click(shifted.x, shifted.y)
      await sleep(0.4)
      return
    }
    // Leave the shifted layer again before failing.
    const back = roleKey(nodes, 'shift')
    if (back) await d.click(back.x, back.y)
  }
  throw new Error(`no key for ${pyRepr(ch)}; labels ${pyRepr(labels(nodes))}`)
}

async function typeKeys(d: Device, lang: Lang, chars: string[]): Promise<void> {
  for (const ch of chars) await typeChar(d, lang, ch)
}

/** Type the probe word and commit it the way the language does. Returns what was picked. */
async function typeWord(d: Device, lang: Lang): Promise<string> {
  await typeKeys(d, lang, lang.keys)
  if (lang.commit === 'space') return 'space'
  let candidate: GNode | undefined
  for (let i = 0; i < 6 && !candidate; i++) {
    candidate = firstCandidate(await keys(d))
    if (!candidate) await sleep(0.5)
  }
  if (!candidate) throw new Error(`no candidate after ${lang.keys.join('')}`)
  await d.click(candidate.x, candidate.y)
  await sleep(0.6)
  return candidate.label
}

/** Switch Gboard until it shows `target`, by the active subtype and the key labels. */
async function ensureLayout(d: Device, out: string, target: string): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const nodes = await keys(d)
    const ims = await adbOutput(['shell', 'dumpsys', 'input_method'])
    const hash = await adbOutput(['shell', 'settings', 'get', 'secure', 'selected_input_method_subtype'])
    const locale = subtypeLocale(ims, hash)
    const layout = classifyLayout(nodes)
    if (onLayout(target, locale, layout)) {
      phase(`layout ${target} active after ${attempt} switches (subtype ${locale}, keys ${layout})`)
      writeFileSync(`${out}/keyboard-${target}.xml`, await d.dumpHierarchy())
      await d.screenshot(`${out}/keyboard-${target}`)
      return
    }
    const banner = nodes.find((n) => n.label.toLowerCase().startsWith('close the new language'))
    const language = roleKey(nodes, 'language')
    // An earlier action can leave the emoji or symbol panel up, which has no Space or language key.
    const letters = roleKey(nodes, 'space') ? undefined : roleKey(nodes, 'letters')
    phase(`not on ${target}: subtype ${locale} hash ${hash.trim()}, keys ${layout}, language key ${pyRepr(language?.label)}`)
    if (banner) await d.click(banner.x, banner.y)
    else if (letters) await d.click(letters.x, letters.y)
    else if (language) await d.click(language.x, language.y)
    else {
      const space = roleKey(nodes, 'space')
      if (!space) break
      await d.swipe(space.x - 150, space.y, space.x + 150, space.y, 0.3)
    }
    await sleep(1.5)
  }
  writeFileSync(`${out}/keyboard-${target}-missing.xml`, await d.dumpHierarchy())
  throw new Error(`could not switch Gboard to ${target}`)
}

// --- actions -----------------------------------------------------------------------------------------

type Ctx = {d: Device; lang: Lang; steps: Step[]; notes: Record<string, unknown>; cursorControl: boolean | undefined}

async function record(ctx: Ctx, step: string, extra: Record<string, unknown> = {}): Promise<Step> {
  const s = await pageStep(step, extra)
  ctx.steps.push(s)
  return s
}

const half = (lang: Lang) => lang.keys.slice(0, Math.max(2, Math.ceil(lang.keys.length / 2)))

export function hasWord(text: string | null, expect: string): boolean {
  return (text ?? '').normalize('NFC').includes(expect.normalize('NFC'))
}

async function wordAndSpace(ctx: Ctx): Promise<void> {
  const picked = await typeWord(ctx.d, ctx.lang)
  await record(ctx, 'typed', {picked})
  await tapRole(ctx.d, 'space')
  const s = await record(ctx, 'space')
  ctx.notes.expect = ctx.lang.expect
  ctx.notes.word_ok = hasWord(s.text, ctx.lang.expect)
}

const ACTIONS: Record<string, (ctx: Ctx) => Promise<void>> = {
  async word(ctx) {
    await wordAndSpace(ctx)
    if (!ctx.notes.word_ok) throw new Error(`expected ${pyRepr(ctx.lang.expect)} in ${pyRepr(ctx.steps.at(-1)?.text)}`)
  },

  async 'backspace-composing'(ctx) {
    await typeKeys(ctx.d, ctx.lang, half(ctx.lang))
    await record(ctx, 'partial')
    await tapRole(ctx.d, 'delete')
    await record(ctx, 'delete')
  },

  async 'backspace-committed'(ctx) {
    await wordAndSpace(ctx)
    await tapRole(ctx.d, 'delete')
    await record(ctx, 'delete')
  },

  async 'enter-mid-word'(ctx) {
    await typeKeys(ctx.d, ctx.lang, half(ctx.lang))
    await record(ctx, 'partial')
    await tapRole(ctx.d, 'enter')
    await record(ctx, 'enter')
  },

  async 'backspace-hold'(ctx) {
    await wordAndSpace(ctx)
    const del = roleKey(await keys(ctx.d), 'delete')
    if (!del) throw new Error('no delete key')
    await ctx.d.longClick(del.x, del.y, 0.8)
    await sleep(0.5)
    await record(ctx, 'hold-0.8s')
  },

  async 'space-drag'(ctx) {
    if (ctx.cursorControl === false) throw new Unsupported('gesture cursor control setting not found in Gboard settings')
    await wordAndSpace(ctx)
    const nodes = await keys(ctx.d)
    const space = roleKey(nodes, 'space')
    const letter = nodes.find((n) => n.id === 'key_pos_0_0')
    if (!space) throw new Error('no space key')
    // Gboard moves the cursor about one character per key width of drag, so drag three key widths.
    const distance = 3 * (letter ? letter.bounds.right - letter.bounds.left : 107)
    const before = ctx.steps.at(-1)!.selection
    await ctx.d.touch('down', space.x, space.y)
    await sleep(0.15)
    for (let i = 1; i <= 12; i++) {
      await ctx.d.touch('move', space.x - (distance * i) / 12, space.y)
      await sleep(0.04)
    }
    await sleep(0.2)
    await ctx.d.touch('up', space.x - distance, space.y)
    await sleep(0.5)
    const after = (await record(ctx, 'drag', {distance_px: distance})).selection
    ctx.notes.moved = before.focus !== undefined && after.focus !== undefined ? before.focus - after.focus : null
    if (!ctx.notes.moved) throw new Error(`cursor did not move left: focus ${before.focus} -> ${after.focus}`)
  },

  async 'tap-to-place'(ctx) {
    await wordAndSpace(ctx)
    const g = (await cdpEval(MIDDLE_GRAPHEME_JS)) as {k: number; rect: {top: number; bottom: number}; edge: number; caretAtEdge: number | null; viewport: Viewport} | null
    if (!g) throw new Error('no text to tap into')
    const [x, y] = await toScreen(ctx.d, g.edge, (g.rect.top + g.rect.bottom) / 2, g.viewport)
    await ctx.d.click(x, y)
    await sleep(0.8)
    const s = await record(ctx, 'tap', {geometry: g, screen: [x, y]})
    ctx.notes.target_offset = g.k
    ctx.notes.chrome_offset_at_point = g.caretAtEdge
    ctx.notes.placed_offset = s.selection.focus ?? null
    ctx.notes.placed_ok = s.selection.collapsed === true && s.selection.focus === (g.caretAtEdge ?? g.k)
    if (!ctx.notes.placed_ok) throw new Error(`caret at ${pyRepr(s.selection)}, expected collapsed at ${g.caretAtEdge ?? g.k}`)
  },

  async 'long-press-word'(ctx) {
    await wordAndSpace(ctx)
    const g = (await cdpEval(MIDDLE_GRAPHEME_JS)) as {rect: {left: number; right: number; top: number; bottom: number}; word: string; viewport: Viewport} | null
    if (!g) throw new Error('no text to long-press')
    const [x, y] = await toScreen(ctx.d, (g.rect.left + g.rect.right) / 2, (g.rect.top + g.rect.bottom) / 2, g.viewport)
    await ctx.d.longClick(x, y, 1.0)
    await sleep(1)
    const s = await record(ctx, 'long-press', {screen: [x, y]})
    await ctx.d.screenshot(`${ctx.notes.base}-selected`)
    ctx.notes.selected = s.selection.selected ?? null
    ctx.notes.selected_word = (s.selection.selected ?? '').trim() === g.word.trim()
    if (!ctx.notes.selected_word) throw new Error(`selected ${pyRepr(s.selection.selected)}, expected ${pyRepr(g.word)}`)
  },

  async emoji(ctx) {
    const opened = await openEmoji(ctx.d)
    ctx.notes.opened_via = opened
    let nodes = await emojiPanel(ctx.d)
    // Prefer a ZWJ sequence or a flag, which the Flags or People tab holds.
    for (const tab of [/^flags?$/i, /people|smileys/i]) {
      if (pickEmoji(nodes)?.label.match(/\u200d|[\u{1f1e6}-\u{1f1ff}]{2}/u)) break
      const t = nodes.find((n) => tab.test(n.label))
      if (t) {
        await ctx.d.click(t.x, t.y)
        await sleep(1)
        nodes = await emojiPanel(ctx.d)
      }
    }
    writeFileSync(`${ctx.notes.base}-emoji.xml`, await ctx.d.dumpHierarchy())
    const pick = pickEmoji(nodes)
    if (!pick) throw new Error(`no emoji cell in the panel; labels ${pyRepr(labels(nodes))}`)
    await record(ctx, 'panel', {labels: labels(nodes)})
    await ctx.d.click(pick.x, pick.y)
    await sleep(0.8)
    await record(ctx, 'emoji', {picked: pick.label})
    const del = roleKey(gboardNodes(await ctx.d.dumpHierarchy()), 'delete')
    if (!del) throw new Error('no delete key on the emoji panel')
    await ctx.d.click(del.x, del.y)
    await sleep(0.8)
    await record(ctx, 'delete')
  },
}

/** Open the emoji panel by its key, from the comma key's long-press popup, or from the features menu. */
async function openEmoji(d: Device): Promise<string> {
  const nodes = await keys(d)
  const key = roleKey(nodes, 'emoji')
  if (key) {
    await d.click(key.x, key.y)
    await sleep(1.2)
    return `key ${key.label}`
  }
  const comma = nodes.find((n) => n.id === 'key_pos_bottom_symbol_1')
  if (comma) {
    await d.touch('down', comma.x, comma.y)
    await sleep(0.9)
    const popup = roleKey(gboardNodes(await d.dumpHierarchy()), 'emoji')
    await d.touch('move', (popup ?? comma).x, (popup ?? comma).y)
    await d.touch('up', (popup ?? comma).x, (popup ?? comma).y)
    await sleep(1.2)
    if (popup) return `comma popup ${popup.label}`
  }
  const menu = nodes.find((n) => n.id === 'key_pos_header_access_points_menu')
  if (menu) {
    await d.click(menu.x, menu.y)
    await sleep(1.2)
    const item = roleKey(gboardNodes(await d.dumpHierarchy()), 'emoji')
    if (item) {
      await d.click(item.x, item.y)
      await sleep(1.2)
      return `features menu ${item.label}`
    }
  }
  throw new Unsupported(`no emoji entry point; labels ${pyRepr(labels(nodes))}`)
}

/** The emoji panel's nodes. It has no space key, so do not wait for one. */
async function emojiPanel(d: Device): Promise<GNode[]> {
  for (let i = 0; i < 4; i++) {
    const nodes = gboardNodes(await d.dumpHierarchy())
    if (pickEmoji(nodes)) return nodes
    await sleep(1)
  }
  return gboardNodes(await d.dumpHierarchy())
}

function withTimeout<T>(promise: Promise<T>, seconds: number): Promise<T> {
  let timer: NodeJS.Timeout
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${seconds}s`)), seconds * 1000)
    }),
  ])
}

/** Whether setup-lang found the cursor control setting, from its log. Undefined when it did not say. */
export function cursorControlFromLog(log: string): boolean | undefined {
  const m = /CURSOR_CONTROL setting=(present|absent)/.exec(log)
  return m ? m[1] === 'present' : undefined
}

export function probeLine(lang: string, r: ActionResult): string {
  const text = r.steps.at(-1)?.text ?? null
  return `PROBE lang=${lang} layout=${r.layout} action=${r.action} status=${r.status} text=${pyRepr(text)} reason=${pyRepr(r.reason)}`
}

async function runAction(d: Device, out: string, langCode: string, layout: string, action: string, cursorControl: boolean | undefined): Promise<ActionResult> {
  const lang = LANGS[layout]!
  const base = `${out}/probe-${langCode}-${layout}-${action}`
  const ctx: Ctx = {d, lang, steps: [], notes: {base}, cursorControl}
  let status: Status = 'ok'
  let reason = ''
  phase(`action ${layout}/${action}`)
  deadline = Date.now() + ACTION_TIMEOUT * 1000
  try {
    await withTimeout(
      (async () => {
        await freshEditor(d)
        await ensureLayout(d, out, layout)
        await record(ctx, 'start')
        await ACTIONS[action]!(ctx)
      })(),
      ACTION_TIMEOUT,
    )
  } catch (error) {
    status = error instanceof Unsupported ? 'unsupported' : 'failed'
    reason = errorRepr(error)
    // Let a timed-out action's leftover calls fail at their next check, then give the device a moment.
    await sleep(2)
    deadline = Infinity
    try {
      writeFileSync(`${base}-fail.xml`, await d.dumpHierarchy())
    } catch {}
  }
  try {
    await d.screenshot(base)
  } catch {}
  delete ctx.notes.base
  const result: ActionResult = {action, layout, status, reason, steps: ctx.steps, ...ctx.notes}
  console.log(probeLine(langCode, result))
  return result
}

async function main(): Promise<void> {
  const [langCode, out] = process.argv.slice(2) as [string, string]
  if (!LANGS[langCode]) throw new Error(`unknown language ${langCode}`)
  mkdirSync(out, {recursive: true})
  const setupLog = `${out}/setup.log`
  const cursorControl = existsSync(setupLog) ? cursorControlFromLog(readFileSync(setupLog, 'utf8')) : undefined
  const layouts = langCode === 'en' ? ['en'] : ['en', langCode]

  await adb(['reverse', `tcp:${PORT}`, `tcp:${PORT}`])
  await adb(['forward', `tcp:${CDP_PORT}`, 'localabstract:chrome_devtools_remote'])
  const d = await Device.connect()
  d.waitTimeout = 10
  setCurrentUrl(URL_)
  await adb(['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', URL_, CHROME])
  await sleep(4)
  await dismissChromeScreens(d)
  await waitForPage()
  phase(`page loaded, cursor control ${cursorControl}, layouts ${layouts.join(' ')}`)

  const results: ActionResult[] = []
  for (const layout of layouts) {
    for (const action of Object.keys(ACTIONS)) {
      results.push(await runAction(d, out, langCode, layout, action, cursorControl))
      writeFileSync(`${out}/probe-${langCode}.json`, JSON.stringify({lang: langCode, gboard: GBOARD, cursorControl, results}, null, 2))
    }
  }
  const counts = results.reduce<Record<string, number>>((c, r) => ({...c, [r.status]: (c[r.status] ?? 0) + 1}), {})
  console.log(`PROBE_SUMMARY lang=${langCode} ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ')}`)
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
