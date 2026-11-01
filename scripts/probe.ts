// Probe which Gboard keyboard actions reach the editor, in English and in one other language.
//
// Each action starts from a reloaded editor with one empty block, so actions do not depend on each other.
// After every step it records the editor value, the DOM text, the DOM selection and the full
// composition/beforeinput/input event log, and each action gets an evidence summary of those. An action
// ends ok, failed or unsupported, with a reason, and the probe moves on either way.
//
// Prints one line per action:
//   PROBE lang=ko layout=ko action=word status=ok text='한국 ' reason=''
// and writes everything to <outdir>/probe-<lang>.json.
//
// Usage: node scripts/probe.ts <lang> <outdir>

import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs'
import {adb, adbOutput} from './lib/adb.ts'
import {cdpEval, CDP_PORT, setCurrentUrl} from './lib/cdp.ts'
import {dismissAnr} from './drive.ts'
import {
  charKey,
  classifyLayout,
  cssToScreen,
  emojiPanelOpen,
  firstCandidate,
  GBOARD,
  gboardNodes,
  LANGS,
  LATIN_IME,
  onLayout,
  currentInputType,
  isUrlField,
  omniboxOpen,
  originFromScreen,
  originFromTap,
  pickEmoji,
  roleKey,
  subtypeHashFromLog,
  subtypeLocale,
  type GNode,
  type Lang,
  type Origin,
  type Role,
  type Viewport,
} from './lib/gboard.ts'
import {charsPerPixel, chromePid, cursorControlFromLog, dragSign, evidence, hasWord, type DragSample, type Selection, type Step} from './lib/probe-logic.ts'
import {Device} from './lib/u2.ts'
import {errorRepr, phase, pyRepr, safePath, sleep} from './lib/util.ts'

/** writeFileSync with the file name made safe for artifact upload. */
function writeFile(path: string, data: string): void {
  writeFileSync(safePath(path), data)
}

const CHROME = 'com.android.chrome'
const PORT = 8765
const URL_ = `http://localhost:${PORT}/editor.html?prefix=`
const ACTION_TIMEOUT = 75

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

// --- chrome ------------------------------------------------------------------------------------------

// Chrome's first-run and promo screens. Decline first: run 1 tapped Continue on the notifications promo,
// which opened the system permission dialog, and left the promo over the page when it came up later.
const CHROME_SCREENS = ['No thanks', 'No, thanks', 'Use without an account', 'Accept & continue', 'Got it', 'Skip', 'Continue']

async function dismissChromeScreens(d: Device): Promise<string[]> {
  const tapped: string[] = []
  for (let i = 0; i < 6; i++) {
    let hit: string | undefined
    for (const b of CHROME_SCREENS) {
      if (await d.find({packageName: CHROME, text: b}).exists()) {
        hit = b
        break
      }
    }
    // The permission dialog belongs to the permission controller, not Chrome.
    if (!hit && (await d.find({text: "Don’t allow"}).exists())) hit = "Don’t allow"
    if (!hit) return tapped
    phase(`chrome screen: tapping ${pyRepr(hit)}`)
    await d.find({text: hit}).click()
    tapped.push(hit)
    await sleep(1.5)
  }
  return tapped
}

let lastPid: number | undefined

async function launchChrome(d: Device, fresh = false): Promise<void> {
  // A relaunch starts from a stopped Chrome, so no half-restored tab or open omnibox carries over.
  if (fresh) await adbOutput(['shell', 'am', 'force-stop', CHROME])
  await adb(['forward', `tcp:${CDP_PORT}`, 'localabstract:chrome_devtools_remote'])
  await adb(['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', URL_, CHROME])
  await sleep(4)
  await dismissChromeScreens(d)
  await waitForPage()
  lastPid = chromePid(await adbOutput(['shell', 'pidof', CHROME]))
  origin = undefined
  phase(`chrome up, pid ${lastPid}`)
}

/**
 * Relaunch Chrome when its process changed or vanished since the last action. Play services force-restarts
 * Chrome when it updates a Dynamite module ("forcing restart due to module googlecertificates"), which
 * killed Chrome in 13 of 18 round 1 jobs and left every later action talking to a dead page.
 */
async function ensureChrome(d: Device): Promise<number | undefined> {
  const pid = chromePid(await adbOutput(['shell', 'pidof', CHROME]))
  if (pid !== undefined && pid === lastPid) return undefined
  phase(`chrome pid ${lastPid} -> ${pid}, relaunching`)
  const before = lastPid
  await launchChrome(d, true)
  return before
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

const VIEWPORT_JS = `({dpr: devicePixelRatio, offsetLeft: visualViewport.offsetLeft, offsetTop: visualViewport.offsetTop, scale: visualViewport.scale})`

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
  return {k, rect: {left: b.left, right: b.right, top: b.top, bottom: b.bottom}, edge, rtl,
    caretAtEdge: caret && root.contains(caret.startContainer) ? offsetOf(caret.startContainer, caret.startOffset) : null,
    word: text.slice(0, text.trimEnd().length), viewport: ${VIEWPORT_JS}};
})()`

const FIELD_JS = `(() => { const el = document.querySelector('[contenteditable]'); el.style.minHeight = '30vh'; const b = el.getBoundingClientRect();
  return {x: b.left + b.width / 2, y: b.top + b.height * 0.6, viewport: ${VIEWPORT_JS}} })()`

// Records where the page saw the last pointer land, for the calibration tap. Capture phase, so the editor
// cannot stop it.
const POINTER_HOOK_JS = `(() => { if (!window.__pointer) { window.__pointer = null;
  document.addEventListener('pointerdown', (e) => { window.__pointer = {x: e.clientX, y: e.clientY, sx: e.screenX, sy: e.screenY} }, true) }
  window.__pointer = null; return true })()`

async function pageStep(step: string, extra: Record<string, unknown> = {}): Promise<Step> {
  checkDeadline()
  const state = (await cdpEval('window.__state()')) as {text: string | null; dom?: string | null; events: Step['events']}
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

// Where the page's CSS (0, 0) sits on screen, and how it was found. Reset on every Chrome launch.
let origin: Origin | undefined
let originSource = ''

/** The origin to tap with: the confirmed one, or a fresh estimate from the screen. */
async function currentOrigin(d: Device): Promise<Origin> {
  if (origin) return origin
  const dpr = (await cdpEval('devicePixelRatio')) as number
  const estimate = originFromScreen(await d.dumpHierarchy(), dpr)
  phase(`origin estimate ${pyRepr(estimate.origin)} from ${estimate.source}`)
  return estimate.origin
}

async function toScreen(d: Device, x: number, y: number, viewport: Viewport): Promise<[number, number]> {
  return cssToScreen(x, y, await currentOrigin(d), viewport)
}

/**
 * Tap the editor and read back where the page saw the pointer, which confirms (or corrects) the origin
 * without the accessibility tree. Returns whether the tap reached the page at all.
 */
async function tapEditor(d: Device): Promise<boolean> {
  await cdpEval(POINTER_HOOK_JS)
  const field = (await cdpEval(FIELD_JS)) as {x: number; y: number; viewport: Viewport}
  const at = await toScreen(d, field.x, field.y, field.viewport)
  await d.click(...at)
  await sleep(0.6)
  const seen = (await cdpEval('window.__pointer')) as {x: number; y: number} | null
  if (seen) {
    const measured = originFromTap(at, seen, field.viewport)
    if (!origin || measured.top !== origin.top || measured.left !== origin.left) phase(`origin ${pyRepr(measured)} from tap at ${at} (page saw ${pyRepr(seen)})`)
    origin = measured
    originSource = 'tap'
  } else {
    phase(`tap at ${at} did not reach the page`)
  }
  return seen !== null
}

/** Reload the editor to one empty block, tap it and wait for Gboard. Returns notes on what it had to fix. */
async function freshEditor(d: Device): Promise<Record<string, unknown>> {
  const notes: Record<string, unknown> = {}
  const restartedFrom = await ensureChrome(d)
  if (restartedFrom !== undefined) notes.chrome_restarted = {from: restartedFrom ?? null, to: lastPid ?? null}
  await cdpEval('location.reload()').catch(() => undefined)
  await sleep(1.5)
  await waitForPage()
  await dismissAnr(d)
  const screens = await dismissChromeScreens(d)
  if (screens.length) notes.chrome_screens = screens
  if ((await d.appCurrent()).package !== CHROME) {
    await adb(['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', URL_, CHROME])
    await sleep(3)
  }
  if (omniboxOpen(await d.dumpHierarchy())) {
    phase('omnibox open before the editor tap, closing it')
    notes.omnibox_closed = 1
    await adbOutput(['shell', 'input', 'keyevent', 'KEYCODE_BACK'])
    await sleep(0.8)
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    const reached = await tapEditor(d)
    for (let i = 0; i < 6; i++) {
      const ims = await adb(['shell', 'dumpsys', 'input_method'])
      const shown = ims.includes('mInputShown=true') || ims.includes('mIsInputViewShown=true')
      // The keyboard can linger from before the reload, so the editor must hold focus too.
      if (shown && (await cdpEval('!!document.activeElement?.isContentEditable'))) {
        await sleep(0.8)
        if (attempt) notes.editor_taps = attempt + 1
        return notes
      }
      // Round 2: after a relaunch the tap opened Chrome's URL bar, Gboard came up for it, and every later
      // tap went into the omnibox. Close it and tap again.
      if (isUrlField(currentInputType(ims)) || omniboxOpen(await d.dumpHierarchy())) {
        phase('the tap opened the omnibox, closing it')
        notes.omnibox_closed = ((notes.omnibox_closed as number | undefined) ?? 0) + 1
        await adbOutput(['shell', 'input', 'keyevent', 'KEYCODE_BACK'])
        await sleep(0.5)
        if (omniboxOpen(await d.dumpHierarchy())) await adbOutput(['shell', 'input', 'keyevent', 'KEYCODE_BACK'])
        await sleep(0.8)
        // Its estimate was wrong, so measure again from the next tap.
        if (!reached) origin = undefined
        break
      }
      await sleep(1)
    }
    phase(`keyboard not shown or editor not focused after tap ${attempt + 1} (reached page ${reached})`)
    // A dialog that came up since may be covering the page.
    await dismissChromeScreens(d)
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
/** Tap the key for `ch`: on the base layer, under Shift, or by long-pressing a base key. */
async function typeChar(d: Device, lang: Lang, ch: string, prev?: string): Promise<void> {
  let nodes = await keys(d)
  const direct = charKey(nodes, ch, prev)
  if (direct) {
    await d.click(direct.x, direct.y)
    await sleep(0.4)
    return
  }
  const base = lang.longPress?.[ch]
  const holder = base ? charKey(nodes, base) : undefined
  if (holder) {
    // Gboard's long-press popup is a window of its own that the dump does not show (round 3: no ü node,
    // yet hold and release on u typed ü). Release in place to take the preselected entry, then check the
    // page got `ch`, and take back anything else.
    const before = ((await pageStep('long-press-before')).text ?? '').length
    await d.touch('down', holder.x, holder.y)
    await sleep(0.9)
    await d.touch('up', holder.x, holder.y)
    await sleep(0.4)
    const text = (await pageStep('long-press-after')).text ?? ''
    if (!text.normalize('NFC').endsWith(ch.normalize('NFC'))) {
      for (let i = text.length; i > before; i--) await tapRole(d, 'delete')
      throw new Error(`long-press on ${pyRepr(base)} typed ${pyRepr(text.slice(before))}, not ${pyRepr(ch)}`)
    }
    return
  }
  const shift = roleKey(nodes, 'shift')
  if (shift) {
    await d.click(shift.x, shift.y)
    await sleep(0.6)
    nodes = await keys(d)
    const shifted = charKey(nodes, ch, prev)
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
  for (let i = 0; i < chars.length; i++) await typeChar(d, lang, chars[i]!, chars[i - 1])
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

type LayoutState = {locale: string | undefined; hash: string; layout: string; nodes: GNode[]}

async function layoutState(d: Device): Promise<LayoutState> {
  const nodes = await keys(d)
  const ims = await adbOutput(['shell', 'dumpsys', 'input_method'])
  const hash = (await adbOutput(['shell', 'settings', 'get', 'secure', 'selected_input_method_subtype'])).trim()
  return {locale: subtypeLocale(ims, hash), hash, layout: classifyLayout(nodes), nodes}
}

// Subtype hashes from setup-lang's SUBTYPES line, keyed by language code.
let subtypeHashes: Record<string, string> = {}

/**
 * Switch Gboard to `target` and check the keyboard dump agrees. First select the subtype directly: make
 * Gboard the input method and write the subtype hash setup logged, then reopen the keyboard so Gboard
 * reads it. Fall back to the globe key, logging what each tap showed. Round 1 only tapped keys, but its
 * timeouts there came from Chrome being dead, not from the switch.
 */
async function ensureLayout(d: Device, out: string, target: string): Promise<Record<string, unknown>> {
  const tried: string[] = []
  let state = await layoutState(d)
  if (onLayout(target, state.locale, state.layout)) return {switched_by: 'already', subtype: state.locale}
  const hash = subtypeHashes[target]
  if (hash) {
    await adbOutput(['shell', 'ime', 'set', LATIN_IME])
    await adbOutput(['shell', 'settings', 'put', 'secure', 'selected_input_method_subtype', hash])
    // Gboard reads the subtype when the input view starts. Hide the keyboard and tap the field again.
    await adbOutput(['shell', 'input', 'keyevent', 'KEYCODE_BACK'])
    await sleep(1)
    const field = (await cdpEval(FIELD_JS)) as {x: number; y: number; viewport: Viewport}
    await d.click(...(await toScreen(d, field.x, field.y, field.viewport)))
    await sleep(1.5)
    state = await layoutState(d)
    tried.push(`settings ${hash}: subtype ${state.locale} keys ${state.layout}`)
    phase(`layout via settings put ${hash}: subtype ${state.locale}, keys ${state.layout}`)
    if (onLayout(target, state.locale, state.layout)) return done('settings', state)
  }
  for (let attempt = 0; attempt < 6; attempt++) {
    const nodes = state.nodes
    const banner = nodes.find((n) => n.label.toLowerCase().startsWith('close the new language'))
    const language = roleKey(nodes, 'language')
    // An earlier action can leave the emoji or symbol panel up, which has no Space or language key.
    const letters = roleKey(nodes, 'space') ? undefined : roleKey(nodes, 'letters')
    const tap = banner ?? letters ?? language
    if (!tap) {
      tried.push(`no language key; labels ${labels(nodes).slice(0, 30).join(',')}`)
      break
    }
    await d.click(tap.x, tap.y)
    await sleep(1.5)
    state = await layoutState(d)
    tried.push(`tapped ${tap.label}: subtype ${state.locale} keys ${state.layout}`)
    phase(`layout via ${pyRepr(tap.label)}: subtype ${state.locale} hash ${state.hash}, keys ${state.layout}`)
    if (onLayout(target, state.locale, state.layout)) return done('globe', state)
  }
  writeFile(`${out}/keyboard-${target}-missing.xml`, await d.dumpHierarchy())
  throw new Error(`could not switch Gboard to ${target}: ${tried.join(' | ')}`)

  async function done(by: string, s: LayoutState): Promise<Record<string, unknown>> {
    phase(`layout ${target} active via ${by} (subtype ${s.locale}, keys ${s.layout})`)
    if (!existsSync(`${out}/keyboard-${target}.xml`)) {
      writeFile(`${out}/keyboard-${target}.xml`, await d.dumpHierarchy())
      await d.screenshot(`${out}/keyboard-${target}`)
    }
    return {switched_by: by, subtype: s.locale, tried}
  }
}

// --- actions -----------------------------------------------------------------------------------------

type Ctx = {d: Device; out: string; lang: Lang; steps: Step[]; notes: Record<string, unknown>; base: string; cursorControl: boolean | undefined}

async function record(ctx: Ctx, step: string, extra: Record<string, unknown> = {}): Promise<Step> {
  const s = await pageStep(step, extra)
  ctx.steps.push(s)
  return s
}

const half = (lang: Lang) => lang.keys.slice(0, Math.max(2, Math.ceil(lang.keys.length / 2)))

async function wordAndSpace(ctx: Ctx): Promise<void> {
  const picked = await typeWord(ctx.d, ctx.lang)
  await record(ctx, 'typed', {picked})
  await tapRole(ctx.d, 'space')
  const s = await record(ctx, 'space')
  ctx.notes.expect = ctx.lang.expect
  ctx.notes.word_ok = hasWord(s.text, ctx.lang.expect)
}

/** The word the later actions build on. Without it they would test something else, so stop there. */
async function word(ctx: Ctx): Promise<void> {
  await wordAndSpace(ctx)
  if (!ctx.notes.word_ok) throw new Error(`expected ${pyRepr(ctx.lang.expect)} in ${pyRepr(ctx.steps.at(-1)?.text)}`)
}

/** Space bar drag: stop once the caret moved this many characters. */
const DRAG_CHARS = 3
const DRAG_STEP_PX = 6
const DRAG_MAX_PX = 600

const ACTIONS: Record<string, (ctx: Ctx) => Promise<void>> = {
  word,

  async 'backspace-composing'(ctx) {
    await typeKeys(ctx.d, ctx.lang, half(ctx.lang))
    await record(ctx, 'partial')
    await tapRole(ctx.d, 'delete')
    await record(ctx, 'delete')
  },

  async 'backspace-committed'(ctx) {
    await word(ctx)
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
    await word(ctx)
    const del = roleKey(await keys(ctx.d), 'delete')
    if (!del) throw new Error('no delete key')
    await ctx.d.longClick(del.x, del.y, 0.8)
    await sleep(0.5)
    await record(ctx, 'hold-0.8s')
  },

  /**
   * Drag left along the space bar in small steps with the finger held down, reading the caret after each
   * step. That calibrates characters per pixel, and stopping at DRAG_CHARS moves by a requested number of
   * characters. Round 1 dragged three key widths in one go and the caret ran to offset 0.
   */
  async 'space-drag'(ctx) {
    if (ctx.cursorControl === false) throw new Unsupported('gesture cursor control setting not found in Gboard settings')
    await word(ctx)
    const space = roleKey(await keys(ctx.d), 'space')
    if (!space) throw new Error('no space key')
    const start = ctx.steps.at(-1)!.selection.focus
    if (start === undefined || start < DRAG_CHARS) throw new Error(`caret at ${start}, too close to the start to move ${DRAG_CHARS}`)
    // Back through the text is left in ltr and right in rtl. Round 3 dragged Hebrew left, which moves the
    // caret towards the end it already sat at, so it never moved, and the selection then left the editor.
    let sign = dragSign(ctx.steps.at(-1)!.text ?? '')
    ctx.notes.drag_direction = sign < 0 ? 'left' : 'right'
    const samples: DragSample[] = []
    let px = 0
    let reversed = false
    await ctx.d.touch('down', space.x, space.y)
    try {
      // Gboard waits for a short move before it treats the touch as a cursor drag.
      await sleep(0.1)
      while (px < DRAG_MAX_PX) {
        px += DRAG_STEP_PX
        await ctx.d.touch('move', space.x + sign * px, space.y)
        const sel = (await cdpEval(SELECTION_JS)) as Selection
        if (!sel.inEditor || sel.focus === undefined) {
          ctx.notes.selection_left_editor_at_px = px
          break
        }
        samples.push({px, focus: sel.focus})
        if (start - sel.focus >= DRAG_CHARS) break
        // Moving forward means this build maps the drag the other way. Turn round once, from where we are.
        if (sel.focus > start && !reversed) {
          reversed = true
          sign = -sign as -1 | 1
          ctx.notes.drag_direction = `${ctx.notes.drag_direction} then reversed`
        }
      }
    } finally {
      await ctx.d.touch('up', space.x + sign * px, space.y)
    }
    await sleep(0.5)
    const after = (await record(ctx, 'drag')).selection
    const k = charsPerPixel(start, samples)
    ctx.notes.drag = {start, samples, chars_per_px: k, px_per_char: k ? 1 / k : null, released_at_px: px}
    ctx.notes.moved = after.focus === undefined ? null : start - after.focus
    if (ctx.notes.moved !== DRAG_CHARS) throw new Error(`caret moved ${ctx.notes.moved} characters, wanted ${DRAG_CHARS}, after ${px}px`)
  },

  async 'tap-to-place'(ctx) {
    await word(ctx)
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
    await word(ctx)
    const g = (await cdpEval(MIDDLE_GRAPHEME_JS)) as {rect: {left: number; right: number; top: number; bottom: number}; word: string; viewport: Viewport} | null
    if (!g) throw new Error('no text to long-press')
    const [x, y] = await toScreen(ctx.d, (g.rect.left + g.rect.right) / 2, (g.rect.top + g.rect.bottom) / 2, g.viewport)
    await ctx.d.longClick(x, y, 1.0)
    await sleep(1)
    const s = await record(ctx, 'long-press', {screen: [x, y]})
    await ctx.d.screenshot(`${ctx.base}-selected`)
    ctx.notes.selected = s.selection.selected ?? null
    ctx.notes.selected_word = (s.selection.selected ?? '').trim() === g.word.trim()
    // Close Chrome's selection toolbar, so it cannot cover the next action's field.
    await adbOutput(['shell', 'input', 'keyevent', 'KEYCODE_BACK'])
    if (!ctx.notes.selected_word) throw new Error(`selected ${pyRepr(s.selection.selected)}, expected ${pyRepr(g.word)}`)
  },

  async emoji(ctx) {
    ctx.notes.opened_via = await openEmoji(ctx)
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
    writeFile(`${ctx.base}-emoji.xml`, await ctx.d.dumpHierarchy())
    const pick = pickEmoji(nodes)
    if (!pick) throw new Error(`no emoji cell in the panel; labels ${pyRepr(labels(nodes))}`)
    await record(ctx, 'panel', {labels: labels(nodes)})
    await ctx.d.click(pick.x, pick.y)
    await sleep(0.8)
    const before = ctx.steps.at(-1)!.text ?? ''
    const after = (await record(ctx, 'emoji', {picked: pick.label})).text ?? ''
    // The label may be mangled (".."), so the inserted text is what the page got.
    ctx.notes.inserted = after.startsWith(before) ? after.slice(before.length) : after
    const del = roleKey(gboardNodes(await ctx.d.dumpHierarchy()), 'delete')
    if (!del) throw new Error('no delete key on the emoji panel')
    await ctx.d.click(del.x, del.y)
    await sleep(0.8)
    const left = (await record(ctx, 'delete')).text ?? ''
    ctx.notes.one_backspace_removed_it = left === before
    if (!ctx.notes.inserted) throw new Error('tapping the emoji cell inserted nothing')
    if (left !== before) throw new Error(`one Backspace left ${pyRepr(left)}, expected ${pyRepr(before)}`)
  },
}

/**
 * Open the emoji panel. A one-language keyboard has an emoji key left of Space. With two languages that
 * slot is the globe key, so hold the comma key, then try the features menu and the symbols layer. Every screen tried is dumped to <base>-emoji-<n>-<how>.xml so a miss shows what
 * was offered.
 */
async function openEmoji(ctx: Ctx): Promise<string> {
  const d = ctx.d
  let n = 0
  const dump = async (how: string): Promise<GNode[]> => {
    const xml = await d.dumpHierarchy()
    writeFile(`${ctx.base}-emoji-${++n}-${how}.xml`, xml)
    return gboardNodes(xml)
  }
  const opened = async (): Promise<boolean> => emojiPanelOpen(await dump('panel-check'))
  const nodes = await keys(d)
  const key = roleKey(nodes, 'emoji')
  if (key) {
    await d.click(key.x, key.y)
    await sleep(1.2)
    if (await opened()) return `key ${key.label}`
  }
  const comma = nodes.find((x) => x.id === 'key_pos_bottom_symbol_1')
  if (comma) {
    // With two languages the emoji key gives way to the globe key, and the comma key carries a ☺ hint:
    // holding it opens the panel. Round 3 did open it on every layout (dump 2 of each emoji run is the
    // panel), but looked for an emoji item in a popup the dump does not show, took the panel for a typed
    // comma, and tapped delete and the menu inside it. Release in place and look for the panel.
    const before = ((await pageStep('comma-before')).text ?? '').length
    await d.touch('down', comma.x, comma.y)
    await sleep(1.0)
    await d.touch('up', comma.x, comma.y)
    await sleep(1.2)
    if (emojiPanelOpen(await dump('comma-hold'))) return 'comma long-press'
    // No panel: the hold typed a comma or an alternate. Take it back.
    const typed = ((await pageStep('comma-after')).text ?? '').length - before
    for (let i = 0; i < typed; i++) await tapRole(d, 'delete')
  }
  const menu = nodes.find((x) => x.id === 'key_pos_header_access_points_menu')
  if (menu) {
    await d.click(menu.x, menu.y)
    await sleep(1.2)
    const item = roleKey(await dump('features-menu'), 'emoji')
    if (item) {
      await d.click(item.x, item.y)
      await sleep(1.2)
      if (await opened()) return `features menu ${item.label}`
    } else {
      // Close the menu again by its own toggle.
      await d.click(menu.x, menu.y)
      await sleep(0.8)
    }
  }
  const symbols = roleKey(await keys(d), 'symbols')
  if (symbols) {
    await d.click(symbols.x, symbols.y)
    await sleep(1)
    const item = roleKey(await dump('symbols'), 'emoji')
    if (item) {
      await d.click(item.x, item.y)
      await sleep(1.2)
      if (await opened()) return `symbols layer ${item.label}`
    }
  }
  throw new Unsupported(`no emoji entry point (key, comma popup, features menu, symbols layer); see ${ctx.base.split('/').at(-1)}-emoji-*.xml`)
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

export function probeLine(lang: string, r: ActionResult): string {
  const text = r.steps.at(-1)?.text ?? null
  return `PROBE lang=${lang} layout=${r.layout} action=${r.action} status=${r.status} text=${pyRepr(text)} reason=${pyRepr(r.reason)}`
}

async function runAction(d: Device, out: string, langCode: string, layout: string, action: string, cursorControl: boolean | undefined): Promise<ActionResult> {
  const lang = LANGS[layout]!
  const base = `${out}/probe-${langCode}-${layout}-${action}`
  const ctx: Ctx = {d, out, lang, steps: [], notes: {}, base, cursorControl}
  let status: Status = 'ok'
  let reason = ''
  phase(`action ${layout}/${action}`)
  deadline = Date.now() + ACTION_TIMEOUT * 1000
  try {
    await withTimeout(
      (async () => {
        Object.assign(ctx.notes, await freshEditor(d))
        ctx.notes.layout_switch = await ensureLayout(d, out, layout)
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
      writeFile(`${base}-fail.xml`, await d.dumpHierarchy())
    } catch {}
  }
  try {
    await d.screenshot(base)
  } catch {}
  const result: ActionResult = {action, layout, status, reason, evidence: evidence(ctx.steps), steps: ctx.steps, ...ctx.notes}
  console.log(probeLine(langCode, result))
  return result
}

async function main(): Promise<void> {
  const [langCode, out] = process.argv.slice(2) as [string, string]
  if (!LANGS[langCode]) throw new Error(`unknown language ${langCode}`)
  mkdirSync(out, {recursive: true})
  const setupLog = `${out}/setup.log`
  const log = existsSync(setupLog) ? readFileSync(setupLog, 'utf8') : ''
  const cursorControl = cursorControlFromLog(log)
  const layouts = langCode === 'en' ? ['en'] : ['en', langCode]
  for (const code of layouts) {
    const hash = subtypeHashFromLog(log, code)
    if (hash) subtypeHashes[code] = hash
  }

  await adb(['reverse', `tcp:${PORT}`, `tcp:${PORT}`])
  const d = await Device.connect()
  d.waitTimeout = 10
  setCurrentUrl(URL_)
  await launchChrome(d)
  phase(`page loaded, cursor control ${cursorControl}, layouts ${layouts.join(' ')}, subtypes ${pyRepr(subtypeHashes)}`)

  const results: ActionResult[] = []
  for (const layout of layouts) {
    for (const action of Object.keys(ACTIONS)) {
      results.push(await runAction(d, out, langCode, layout, action, cursorControl))
      writeFile(`${out}/probe-${langCode}.json`, JSON.stringify({lang: langCode, gboard: GBOARD, cursorControl, origin, originSource, subtypeHashes, results}, null, 2))
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
