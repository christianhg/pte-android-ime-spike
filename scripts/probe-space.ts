// Can the driver tell whether English Gboard received a Space tap, apart from the page's own beforeinput?
//
// In the editor repo's harness a Space tap sometimes never reaches the page, and a tap Gboard never got
// looks the same there as a Space Gboard got but the page never saw. Each repetition types kyou on the
// plain page, then taps, and records every candidate signal around that one tap:
//   getevent    kernel touch events (adb shell getevent -lt) during the tap, down and up inside the Space key
//   recent      InputDispatcher's RecentQueue from dumpsys input, the same question for injected events,
//               which never pass through the evdev device getevent reads
//   strip       the labels in Gboard's suggestion strip from an a11y dump right before and after
//   shift       the shift key's content-desc, selected and checked state before and after
//   logcat      lines from Gboard's process or an input method tag within 1s after the tap, with VERBOSE
//               set on the input method framework's tags first
//   ims         lines of dumpsys input_method that differ between before and after
//   page        the page's beforeinput and input events for the tap, the ground truth
// Three arms: space taps Space 20 times, outside taps 40 px above the keyboard 5 times, hidden hides the
// keyboard with Back and taps where Space was 5 times. A signal that fires on the last two is useless.
// Each tap logs a SPACE line and the run ends with one SPACE_SUMMARY line per arm.
//
// Usage: IME_LANG=en node scripts/probe-space.ts <outdir>

import {spawn} from 'node:child_process'
import {mkdirSync, writeFileSync} from 'node:fs'
import {adb, adbOutput} from './lib/adb.ts'
import {cdpEval} from './lib/cdp.ts'
import {parseXml} from './lib/hierarchy.ts'
import type {Device} from './lib/u2.ts'
import {errorRepr, phase, pyRepr, sleep, watchdog} from './lib/util.ts'
import {openKeyboard} from './drive.ts'
import {gboardNodes, type Node} from './probe-candidates.ts'

const GBOARD = 'com.google.android.inputmethod.latin'
const CHROME = 'com.android.chrome'
export const ARMS = [
  ['hidden', 5],
  ['outside', 5],
  ['space', 10],
] as const
type Arm = (typeof ARMS)[number][0]
const OUTSIDE = 40
const LOG_WINDOW = 1
const GETEVENT_SECONDS = 3
// Tags whose VERBOSE level the probe asks for. The InputDispatcher ones are read by system_server and may
// only take effect at its start, so the report says which of them produced lines.
export const TAGS = [
  'InputConnection',
  'RemoteInputConnection',
  'RemoteInputConnectionImpl',
  'IInputConnectionWrapper',
  'InputConnectionWrapper',
  'ImeTracker',
  'ImeFocusController',
  'InputMethodManager',
  'InputMethodService',
  'InputMethodManagerService',
  'InputDispatcherInboundEvent',
  'InputDispatcherOutboundEvent',
  'InputDispatcherDispatchCycle',
  'cr_Ime',
]
const RELEVANT_TAG = /input|^ime|ime(tracker|adapter|thread|focus)|imf|keyboard|latin|^cr_ime/i

type Box = [number, number, number, number]
type PageEvent = {type: string; inputType?: string; data?: string | null; text?: string | null}
type PageState = {text: string | null; events: PageEvent[]}
export type Shift = {desc: string; selected: boolean; checked: boolean} | null
export type Touch = {device: string; x: number; y: number; up: boolean}
export type Recent = {action: string; x: number; y: number; age: number; deviceId: string; line: string}
export type LogLine = {t: number; pid: number; level: string; tag: string; line: string}
type Record_ = {
  arm: Arm
  rep: number
  space: Box | null
  tap: [number, number]
  shownBefore: boolean
  page: {space: boolean; textBefore: string; textAfter: string; events: string[]}
  getevent: {fired: boolean; touches: Touch[]}
  recent: {fired: boolean; events: Recent[]}
  strip: {fired: boolean; before: string[]; after: string[]}
  shift: {fired: boolean; before: Shift; after: Shift}
  logcat: {fired: boolean; lines: string[]}
  ims: {fired: boolean; added: string[]; removed: string[]}
  error?: string
}

const records: Record_[] = []
let out = 'out'

const center = (b: Box): [number, number] => [Math.floor((b[0] + b[2]) / 2), Math.floor((b[1] + b[3]) / 2)]
const within = (x: number, y: number, b: Box): boolean => x >= b[0] && x < b[2] && y >= b[1] && y < b[3]
const pad = (n: number): string => String(n).padStart(2, '0')

/** The Space key's bounds in a dump, or null when the keyboard is not showing. */
export function spaceKey(nodes: Node[]): Box | null {
  return nodes.find((n) => n.rid === 'key_pos_space' || n.label === 'Space')?.bounds ?? null
}

/** The top edge of Gboard's window: the highest Gboard node. */
export function keyboardTop(nodes: Node[]): number | null {
  const tops = nodes.map((n) => n.bounds[1]).filter((t) => t > 0)
  return tops.length ? Math.min(...tops) : null
}

/** Labels inside the strip above the keys, in screen order. Idle, that is the access points, typing, the suggestions. */
export function stripLabels(nodes: Node[]): string[] {
  const holder = nodes.find((n) => n.rid === 'keyboard_header_view_holder')
  if (!holder) return []
  const h = holder.bounds
  return nodes
    .filter((n) => n.label && n.bounds[2] > n.bounds[0] && n.bounds[3] > n.bounds[1] && n.bounds[0] >= h[0] && n.bounds[2] <= h[2] && n.bounds[1] >= h[1] && n.bounds[3] <= h[3])
    .sort((a, b) => a.bounds[0] - b.bounds[0])
    .map((n) => n.label)
}

/** The shift key's state, read from the raw dump since gboardNodes drops checked. */
export function shiftState(xml: string): Shift {
  for (const n of parseXml(xml)) {
    if (n.tag !== 'node' || n.attrs.package !== GBOARD || !n.attrs['resource-id']?.endsWith(':id/key_pos_shift')) continue
    return {desc: n.attrs['content-desc'] ?? '', selected: n.attrs.selected === 'true', checked: n.attrs.checked === 'true'}
  }
  return null
}

/** Max ABS_MT_POSITION_X and _Y per device from `getevent -pl`, so raw values can be scaled to pixels. */
export function touchDevices(caps: string): Map<string, {maxX: number; maxY: number}> {
  const devices = new Map<string, {maxX: number; maxY: number}>()
  let device = ''
  for (const line of caps.split(/\r?\n/)) {
    const add = line.match(/^add device \d+: (\S+)/)
    if (add) device = add[1]!
    const abs = line.match(/ABS_MT_POSITION_([XY])\s*:.*\bmax (\d+)/)
    if (abs && device) {
      const d = devices.get(device) ?? {maxX: 0, maxY: 0}
      if (abs[1] === 'X') d.maxX = Number(abs[2])
      else d.maxY = Number(abs[2])
      devices.set(device, d)
    }
  }
  return devices
}

/**
 * Touches in `getevent -lt` output, one per finger down, in screen pixels. A finger is down from BTN_TOUCH DOWN or
 * a tracking id other than ffffffff, and up at BTN_TOUCH UP or tracking id ffffffff.
 */
export function parseGetevent(text: string, devices: Map<string, {maxX: number; maxY: number}>, screen: [number, number]): Touch[] {
  const touches: Touch[] = []
  const open = new Map<string, Touch>()
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\[\s*[\d.]+\]\s+(\S+):\s+(\w+)\s+(\w+)\s+(\w+)/)
    if (!m) continue
    const [, device, , code, value] = m as unknown as [string, string, string, string, string]
    const caps = devices.get(device)
    if (!caps) continue
    let t = open.get(device)
    const down = (code === 'BTN_TOUCH' && value === 'DOWN') || (code === 'ABS_MT_TRACKING_ID' && value !== 'ffffffff')
    const up = (code === 'BTN_TOUCH' && value === 'UP') || (code === 'ABS_MT_TRACKING_ID' && value === 'ffffffff')
    if (down && !t) {
      t = {device, x: -1, y: -1, up: false}
      open.set(device, t)
      touches.push(t)
    }
    if (t && code === 'ABS_MT_POSITION_X' && t.x < 0) t.x = Math.round((parseInt(value, 16) * screen[0]) / (caps.maxX + 1))
    if (t && code === 'ABS_MT_POSITION_Y' && t.y < 0) t.y = Math.round((parseInt(value, 16) * screen[1]) / (caps.maxY + 1))
    if (t && up) {
      t.up = true
      open.delete(device)
    }
  }
  return touches
}

/** Motion events in InputDispatcher's RecentQueue section of `dumpsys input`. */
export function parseRecentQueue(dump: string): Recent[] {
  const lines = dump.split(/\r?\n/)
  const start = lines.findIndex((l) => /RecentQueue: length=/.test(l))
  if (start < 0) return []
  const indent = lines[start]!.search(/\S/)
  const events: Recent[] = []
  for (const line of lines.slice(start + 1)) {
    if (line.trim() && line.search(/\S/) <= indent) break
    const m = line.match(/MotionEvent\((.*)/)
    if (!m) continue
    const action = line.match(/action=(\w+)/)?.[1] ?? '?'
    const p = line.match(/pointers=\[0: \((-?[\d.]+), (-?[\d.]+)\)/)
    events.push({
      action,
      x: p ? Number(p[1]) : NaN,
      y: p ? Number(p[2]) : NaN,
      age: Number(line.match(/age=([\d.]+)ms/)?.[1] ?? NaN),
      deviceId: line.match(/deviceId=(-?\d+)/)?.[1] ?? '?',
      line: line.trim(),
    })
  }
  return events
}

/** A logcat line in `-v epoch` format. */
export function parseLogLine(line: string): LogLine | undefined {
  const m = line.match(/^\s*(\d+\.\d+)\s+(\d+)\s+\d+\s+([VDIWEFA])\s+(.*?)\s*:\s/)
  if (!m) return undefined
  return {t: Number(m[1]), pid: Number(m[2]), level: m[3]!, tag: m[4]!, line: line.trim()}
}

export function relevant(l: LogLine, gboardPids: Set<number>): boolean {
  return gboardPids.has(l.pid) || RELEVANT_TAG.test(l.tag) || l.line.includes(GBOARD)
}

/** Lines only in `after` and lines only in `before`. */
export function diffLines(before: string, after: string): {added: string[]; removed: string[]} {
  const b = new Set(before.split(/\r?\n/).map((l) => l.trimEnd()))
  const a = new Set(after.split(/\r?\n/).map((l) => l.trimEnd()))
  return {added: [...a].filter((l) => l && !b.has(l)), removed: [...b].filter((l) => l && !a.has(l))}
}

/** Did this tap's events carry a space into the page? */
export function pageGotSpace(events: PageEvent[], textBefore: string, textAfter: string): boolean {
  const space = /[  ]/
  if (events.some((e) => e.type === 'beforeinput' && space.test(e.data ?? ''))) return true
  return space.test(textAfter.slice(-1)) && !space.test(textBefore.slice(-1))
}

const eventsRepr = (events: PageEvent[]): string[] => events.map((e) => `${e.type}${e.inputType ? `:${e.inputType}` : ''}${e.data != null ? `:${pyRepr(e.data)}` : ''}`)

/** logcat -v epoch from now on, held in memory, so each tap can take the lines in its own window. */
class LogStream {
  lines: LogLine[] = []
  #rest = ''
  constructor() {
    const child = spawn('adb', ['logcat', '-v', 'epoch', '-b', 'main,system,events', '-T', '1'], {stdio: ['ignore', 'pipe', 'ignore']})
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      const parts = (this.#rest + chunk).split(/\r?\n/)
      this.#rest = parts.pop() ?? ''
      for (const p of parts) {
        const l = parseLogLine(p)
        if (l) this.lines.push(l)
      }
    })
    child.unref()
    process.on('exit', () => child.kill())
  }
  between(from: number, to: number): LogLine[] {
    return this.lines.filter((l) => l.t >= from && l.t <= to)
  }
}

/**
 * getevent -lt for `seconds`. It writes through stdio, so a pty (adb shell -tt) keeps its lines from sitting in a
 * buffer that a kill would drop. The host kills adb, which hangs up the remote shell.
 */
function getevent(seconds: number): Promise<string> {
  return new Promise((resolve) => {
    let text = ''
    const child = spawn('adb', ['shell', '-tt', 'getevent', '-lt'], {stdio: ['ignore', 'pipe', 'pipe']})
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => (text += chunk))
    child.stderr.on('data', () => {})
    const timer = setTimeout(() => child.kill(), seconds * 1000)
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve(`ERROR ${errorRepr(error)}\n`)
    })
    child.on('close', () => {
      clearTimeout(timer)
      resolve(text)
    })
  })
}

async function state(): Promise<PageState> {
  return (await cdpEval('window.__state()')) as PageState
}

async function shown(): Promise<boolean> {
  const ims = await adb(['shell', 'dumpsys', 'input_method'])
  return ims.includes('mInputShown=true') || ims.includes('mIsInputViewShown=true')
}

/** The device clock minus the host clock in seconds, from the midpoint of one `date` call. */
async function clockOffset(): Promise<number> {
  const t0 = Date.now() / 1000
  const device = Number((await adb(['shell', 'date', '+%s.%N'])).trim())
  const t1 = Date.now() / 1000
  return device - (t0 + t1) / 2
}

async function gboardPids(): Promise<Set<number>> {
  const pids = (await adbOutput(['shell', 'pidof', GBOARD])).trim().split(/\s+/).filter(Boolean).map(Number)
  return new Set(pids)
}

/** Dump until two dumps in a row give the same strip and shift, or 6 tries. */
async function settled(d: Device): Promise<{xml: string; nodes: Node[]}> {
  let xml = ''
  let nodes: Node[] = []
  let previous: string | undefined
  for (let i = 0; i < 6; i++) {
    xml = await d.dumpHierarchy()
    nodes = gboardNodes(xml)
    const sig = JSON.stringify([stripLabels(nodes), shiftState(xml)])
    if (sig === previous) break
    previous = sig
    await sleep(0.4)
  }
  return {xml, nodes}
}

/** Tap the field and wait for Gboard, as openKeyboard does. */
async function showKeyboard(d: Device): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = (await cdpEval("(() => { const r = document.getElementById('ed').getBoundingClientRect(); return {x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 40), dpr: devicePixelRatio, ih: innerHeight, sh: screen.height}; })()")) as {x: number; y: number; dpr: number; ih: number; sh: number}
    await d.click(Math.trunc(r.x * r.dpr), Math.trunc(r.y * r.dpr + (r.sh - r.ih) * r.dpr))
    await cdpEval("(() => { const el = document.getElementById('ed'); el.focus(); const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); })()")
    for (let i = 0; i < 6; i++) {
      if (await shown()) return
      await sleep(0.5)
    }
    phase(`keyboard not back after tap ${attempt + 1}`)
  }
  throw new Error('keyboard did not come back')
}

/** Empty the field with Gboard's Delete key, then over CDP for anything left. */
async function clear(d: Device): Promise<void> {
  let s = await state()
  if (!s.text) return
  const del = gboardNodes(await d.dumpHierarchy()).find((n) => n.rid === 'key_pos_del')
  for (let i = 0; i < [...s.text].length + 1 && del; i++) {
    await d.click(...center(del.bounds))
    await sleep(0.2)
  }
  await sleep(0.4)
  s = await state()
  if (s.text) {
    phase(`delete key left ${pyRepr(s.text)}, clearing over CDP`)
    await cdpEval("(() => { const el = document.getElementById('ed'); el.textContent = ''; const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); })()")
    await sleep(0.5)
  }
}

/** Type kyou from one dump. Shift changes the letters' labels after the first, not their places. */
async function typeKyou(d: Device): Promise<void> {
  const nodes = gboardNodes(await d.dumpHierarchy())
  for (const key of 'kyou') {
    const k = nodes.find((n) => n.rid.startsWith('key_pos_') && n.label.toLowerCase() === key)
    if (!k) throw new Error(`no Gboard key ${pyRepr(key)}`)
    await d.click(...center(k.bounds))
    await sleep(0.4)
  }
}

type Context = {logs: LogStream; offset: number; devices: Map<string, {maxX: number; maxY: number}>; screen: [number, number]; pids: Set<number>}

async function rep(d: Device, ctx: Context, arm: Arm, n: number): Promise<void> {
  const base = `${out}/space-${arm}-${pad(n)}`
  const rec: Record_ = {
    arm,
    rep: n,
    space: null,
    tap: [0, 0],
    shownBefore: false,
    page: {space: false, textBefore: '', textAfter: '', events: []},
    getevent: {fired: false, touches: []},
    recent: {fired: false, events: []},
    strip: {fired: false, before: [], after: []},
    shift: {fired: false, before: null, after: null},
    logcat: {fired: false, lines: []},
    ims: {fired: false, added: [], removed: []},
  }
  records.push(rec)
  try {
    if (!(await shown())) await showKeyboard(d)
    await clear(d)
    await typeKyou(d)
    const typed = gboardNodes(await d.dumpHierarchy())
    const space = spaceKey(typed)
    const top = keyboardTop(typed)
    if (!space || top === null) throw new Error('no Space key in the dump after typing')
    rec.space = space
    rec.tap = arm === 'outside' ? [center(space)[0], top - OUTSIDE] : center(space)
    if (arm === 'hidden') {
      await adb(['shell', 'input', 'keyevent', 'KEYCODE_BACK'])
      for (let i = 0; i < 6 && (await shown()); i++) await sleep(0.5)
    }

    const before = await settled(d)
    writeFileSync(`${base}-before.xml`, before.xml)
    rec.strip.before = stripLabels(before.nodes)
    rec.shift.before = shiftState(before.xml)
    const imsBefore = await adb(['shell', 'dumpsys', 'input_method'])
    writeFileSync(`${base}-ims-before.txt`, imsBefore)
    rec.shownBefore = imsBefore.includes('mInputShown=true') || imsBefore.includes('mIsInputViewShown=true')
    const s0 = await state()

    const touches = getevent(GETEVENT_SECONDS)
    await sleep(1)
    const tapAt = Date.now() / 1000
    await d.click(...rec.tap)
    await sleep(LOG_WINDOW + 0.5)

    const after = await settled(d)
    writeFileSync(`${base}-after.xml`, after.xml)
    await d.screenshot(`${base}-after`)
    rec.strip.after = stripLabels(after.nodes)
    rec.shift.after = shiftState(after.xml)
    rec.strip.fired = rec.strip.after.join('|') !== rec.strip.before.join('|')
    rec.shift.fired = JSON.stringify(rec.shift.after) !== JSON.stringify(rec.shift.before)

    const inputAt = Date.now() / 1000
    const input = await adb(['shell', 'dumpsys', 'input'])
    writeFileSync(`${base}-input.txt`, input)
    const ageLimit = (inputAt - tapAt) * 1000 + 300
    rec.recent.events = parseRecentQueue(input).filter((e) => e.age <= ageLimit)
    const hits = (es: Array<{x: number; y: number}>) => es.some((e) => within(e.x, e.y, space))
    rec.recent.fired = hits(rec.recent.events.filter((e) => e.action === 'DOWN')) && hits(rec.recent.events.filter((e) => e.action === 'UP'))

    const imsAfter = await adb(['shell', 'dumpsys', 'input_method'])
    writeFileSync(`${base}-ims-after.txt`, imsAfter)
    const diff = diffLines(imsBefore, imsAfter)
    rec.ims = {fired: diff.added.length + diff.removed.length > 0, added: diff.added.slice(0, 60), removed: diff.removed.slice(0, 60)}

    const s1 = await state()
    const events = s1.events.slice(s0.events.length)
    rec.page = {space: pageGotSpace(events, s0.text ?? '', s1.text ?? ''), textBefore: s0.text ?? '', textAfter: s1.text ?? '', events: eventsRepr(events)}

    const from = tapAt + ctx.offset - 0.1
    const logLines = ctx.logs.between(from, tapAt + ctx.offset + LOG_WINDOW)
    writeFileSync(`${base}-logcat.txt`, logLines.map((l) => l.line).join('\n') + '\n')
    rec.logcat.lines = logLines.filter((l) => relevant(l, ctx.pids)).map((l) => l.line)
    rec.logcat.fired = rec.logcat.lines.length > 0

    const raw = await touches
    writeFileSync(`${base}-getevent.txt`, raw)
    rec.getevent.touches = parseGetevent(raw, ctx.devices, ctx.screen)
    rec.getevent.fired = rec.getevent.touches.some((t) => t.up && within(t.x, t.y, space))
  } catch (error) {
    rec.error = errorRepr(error)
    try {
      writeFileSync(`${base}-fail.xml`, await d.dumpHierarchy())
      await d.screenshot(`${base}-fail`)
    } catch {}
  }
  const f = (b: boolean): string => (b ? 'Y' : 'n')
  console.log(
    `SPACE arm=${arm} rep=${n} tap=${rec.tap.join(',')} shown_before=${rec.shownBefore} page=${f(rec.page.space)} getevent=${f(rec.getevent.fired)} recent=${f(rec.recent.fired)} strip=${f(rec.strip.fired)} shift=${f(rec.shift.fired)} logcat=${f(rec.logcat.fired)} ims=${f(rec.ims.fired)}${rec.error ? ` ERROR ${rec.error}` : ''}`,
  )
  console.log(`SPACE_PAGE arm=${arm} rep=${n} before=${pyRepr(rec.page.textBefore)} after=${pyRepr(rec.page.textAfter)} events=${pyRepr(rec.page.events)}`)
  console.log(`SPACE_STRIP arm=${arm} rep=${n} before=${pyRepr(rec.strip.before)} after=${pyRepr(rec.strip.after)}`)
  console.log(`SPACE_SHIFT arm=${arm} rep=${n} before=${pyRepr(rec.shift.before)} after=${pyRepr(rec.shift.after)}`)
  console.log(`SPACE_TOUCH arm=${arm} rep=${n} getevent=${pyRepr(rec.getevent.touches.map((t) => `${t.device}@${t.x},${t.y}${t.up ? '' : ' no-up'}`))} recent=${pyRepr(rec.recent.events.map((e) => `${e.action}@${e.x},${e.y} dev=${e.deviceId} age=${e.age}`))}`)
  rec.logcat.lines.slice(0, 20).forEach((l) => console.log(`SPACE_LOG arm=${arm} rep=${n} ${l}`))
  for (const [sign, ls] of [['+', rec.ims.added], ['-', rec.ims.removed]] as const) ls.slice(0, 20).forEach((l) => console.log(`SPACE_IMS arm=${arm} rep=${n} ${sign} ${l.trim()}`))
  writeFileSync(`${out}/space-probe.json`, JSON.stringify(records, null, 2))
}

export function summary(recs: Record_[], arm: Arm): string {
  const rs = recs.filter((r) => r.arm === arm)
  const count = (k: 'getevent' | 'recent' | 'strip' | 'shift' | 'logcat' | 'ims') => rs.filter((r) => r[k].fired).length
  return `SPACE_SUMMARY arm=${arm} n=${rs.length} errors=${rs.filter((r) => r.error).length} page=${rs.filter((r) => r.page.space).length} getevent=${count('getevent')} recent=${count('recent')} strip=${count('strip')} shift=${count('shift')} logcat=${count('logcat')} ims=${count('ims')}`
}

async function main(): Promise<void> {
  out = process.argv[2] ?? 'out'
  mkdirSync(out, {recursive: true})
  watchdog(1080)
  phase('start space probe')
  for (const tag of TAGS) await adbOutput(['shell', 'setprop', `log.tag.${tag}`, 'VERBOSE'])
  const props = await Promise.all(TAGS.map(async (t) => `${t}=${(await adbOutput(['shell', 'getprop', `log.tag.${t}`])).trim() || '(unset)'}`))
  phase(`log tags ${pyRepr(props)}`)
  const logs = new LogStream()
  const d = await openKeyboard('plain.html', '', out, 'space')
  const caps = await adbOutput(['shell', 'getevent', '-pl'])
  writeFileSync(`${out}/space-getevent-caps.txt`, caps)
  const devices = touchDevices(caps)
  const ctx: Context = {logs, offset: await clockOffset(), devices, screen: await d.windowSize(), pids: await gboardPids()}
  phase(`touch devices ${pyRepr([...devices].map(([k, v]) => `${k} ${v.maxX}x${v.maxY}`))}, screen ${ctx.screen.join('x')}, device clock offset ${ctx.offset.toFixed(3)}s, gboard pids ${pyRepr([...ctx.pids])}, chrome pid ${(await adbOutput(['shell', 'pidof', CHROME])).trim()}`)
  const idle = gboardNodes(await d.dumpHierarchy())
  phase(`idle strip ${pyRepr(stripLabels(idle))}`)
  for (const [arm, n] of ARMS) {
    for (let i = 1; i <= n; i++) await rep(d, ctx, arm, i)
  }
  writeFileSync(`${out}/space-logcat-all.txt`, logs.lines.map((l) => l.line).join('\n') + '\n')
  for (const [arm] of ARMS) console.log(summary(records, arm))
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
