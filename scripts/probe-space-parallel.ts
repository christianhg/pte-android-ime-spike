// Can the editor harness's Space diagnostics run alongside typing instead of inline?
//
// The editor repo's driver reads Gboard's suggestion strip and logcat around each English Space inside the
// typing sequence, which moves every later tap and read. The alternative is to start those reads at the tap
// on a connection of their own and join them after the final page read. Three things decide whether that
// works, and none of them can be read from source:
//   tap       does a dump in flight on the uiautomator2 server delay a tap or drop it
//   strip     what the strip shows once the next word's letters land: does it switch before them, and does a
//             dump after them show completions of the new letters, which a switch check could misread
//   marks     what an `adb shell log` marker per tap costs, and whether one logcat read after the last tap
//             finds every marker in order
// Each repetition types "kyou kyou " on the plain page the way the driver does: a dump before every tap, a
// 0.4s pace after it, and 1.5s after each Space. Two arms alternate so drift hits both alike:
//   serial    that sequence and nothing else, the control
//   parallel  the same sequence, plus from each Space tap a sampler that dumps back to back on its own
//             connection for SAMPLE_SECONDS, overlapping the next word's taps, and a marker logged at every
//             tap without waiting for it. After the final page read the sampler is stopped, joined with a
//             bound, and logcat is read once for every marker of the repetition.
// The probe's own logcat stream gives each tap's uiautomator2 request and Gboard's handling of the key, so
// the delay a tap took inside the device can be compared between the arms.
//
// Usage: IME_LANG=en node scripts/probe-space-parallel.ts <outdir>

import {randomUUID} from 'node:crypto'
import {mkdirSync, writeFileSync} from 'node:fs'
import {adb} from './lib/adb.ts'
import {packageKeys} from './lib/hierarchy.ts'
import type {Device} from './lib/u2.ts'
import {errorRepr, phase, pyRepr, sleep, watchdog} from './lib/util.ts'
import {openKeyboard} from './drive.ts'
import {gboardNodes} from './probe-candidates.ts'
import {clear, clockOffset, LogStream, showKeyboard, state, stripLabels} from './probe-space.ts'

const GBOARD = 'com.google.android.inputmethod.latin'
export const ARMS = ['serial', 'parallel'] as const
type Arm = (typeof ARMS)[number]
const REPS = 8
const WORDS = ['kyou', 'kyou']
// Gboard capitalises the first letter, and Chrome may give the trailing space as a no-break space.
const EXPECTED = 'Kyou kyou '
// The driver's pacing, see tapKey and typeWord in the editor repo's scripts/lib/typing.ts.
const TAP_PACE = 0.4
const AFTER_SPACE = 1.5
// Long enough to cover the next word's four letters at the driver's pace.
const SAMPLE_SECONDS = 6
const JOIN_SECONDS = 3

// `strip` is the strip in the dump the tap's key was found in, which the driver takes anyway before every tap.
type Tap = {word: number; key: string; dumpAt: number; strip: string[]; requestAt: number; respondedAt: number; dumpsInFlight: number; mark?: Mark}
type Mark = {marker: string; startedAt: number; endedAt?: number; ok?: boolean; error?: string}
type Sample = {space: number; startedAt: number; endedAt: number; strip: string[]; error?: string}
type Record_ = {
  arm: Arm
  rep: number
  text: string
  ok: boolean
  taps: Tap[]
  samples: Sample[]
  join?: {waitedMs: number; cut: boolean}
  logcat?: {markers: number; found: number; inOrder: boolean; restarts: number; readMs: number; error?: string}
  fault?: string
}

const records: Record_[] = []
let out = 'out'
let inFlight = 0

/** Completions of `letters`: a suggestion that begins with them, whatever the case. The driver's own rule. */
export function completes(strip: string[], letters: string): boolean {
  return strip.some((label) => label.toLowerCase().startsWith(letters.toLowerCase()))
}

/** The strip without Gboard's fixed access points, so only suggestions are left. */
export function suggestions(strip: string[]): string[] {
  return strip.filter((label) => !/^(Open features menu|Use voice typing|Sticker Keyboard|GIF Keyboard|Clipboard|Settings|Theme settings)$/.test(label))
}

/**
 * What a strip sampled after word `space`'s Space shows, with `typed` the next word's letters Gboard had
 * already handled when the dump started: `completions` of the word just committed, `predictions` (none of
 * them completes it, nor the next word's letters), `next` (completions of the next word's letters), or
 * `empty`. `next` is the case a switch check could misread, since it is no completion of the old word.
 */
export function classify(strip: string[], word: string, typed: string): 'completions' | 'predictions' | 'next' | 'empty' {
  const s = suggestions(strip)
  if (s.length === 0) return 'empty'
  if (completes(s, word)) return 'completions'
  if (typed !== '' && completes(s, typed)) return 'next'
  return 'predictions'
}

async function dump(d: Device): Promise<string> {
  inFlight++
  try {
    return await d.dumpHierarchy()
  } finally {
    inFlight--
  }
}

/** Log a marker to `main` without waiting for it. `adb shell log` alone, so a failure is the marker's own. */
function mark(): Mark {
  const m: Mark = {marker: `ime-par-${randomUUID()}`, startedAt: Date.now() / 1000}
  adb(['shell', 'log', '-t', 'ime-driver', m.marker], 5).then(
    () => Object.assign(m, {ok: true, endedAt: Date.now() / 1000}),
    (error: unknown) => Object.assign(m, {ok: false, endedAt: Date.now() / 1000, error: errorRepr(error)}),
  )
  return m
}

/** Dump back to back for `seconds` or until `stop` is set, recording each dump's strip and times. */
async function sampler(d: Device, space: number, seconds: number, samples: Sample[], stop: {set: boolean}): Promise<void> {
  const end = Date.now() / 1000 + seconds
  while (!stop.set && Date.now() / 1000 < end) {
    const startedAt = Date.now() / 1000
    try {
      const xml = await dump(d)
      samples.push({space, startedAt, endedAt: Date.now() / 1000, strip: stripLabels(gboardNodes(xml))})
    } catch (error) {
      samples.push({space, startedAt, endedAt: Date.now() / 1000, strip: [], error: errorRepr(error)})
      await sleep(0.2)
    }
  }
}

/** One tap the way the driver taps a key: a dump for the key's place, the tap, then the pace. */
async function tapKey(d: Device, label: string, word: number, rec: Record_, marks: boolean): Promise<void> {
  const dumpAt = Date.now() / 1000
  const xml = await dump(d)
  const keys = packageKeys(xml, GBOARD)
  const center = keys.get(label) ?? keys.get(label.toUpperCase())
  if (!center) throw new Error(`no Gboard key ${pyRepr(label)}`)
  const tap: Tap = {word, key: label, dumpAt, strip: suggestions(stripLabels(gboardNodes(xml))), requestAt: 0, respondedAt: 0, dumpsInFlight: inFlight}
  if (marks) tap.mark = mark()
  tap.requestAt = Date.now() / 1000
  await d.click(...center)
  tap.respondedAt = Date.now() / 1000
  rec.taps.push(tap)
  await sleep(TAP_PACE)
}

async function rep(d: Device, arm: Arm, n: number): Promise<void> {
  const rec: Record_ = {arm, rep: n, text: '', ok: false, taps: [], samples: []}
  records.push(rec)
  const parallel = arm === 'parallel'
  const stop = {set: false}
  const samplers: Promise<void>[] = []
  try {
    await showKeyboard(d)
    await clear(d)
    if ((await state()).text) throw new Error('field not empty after clearing')
    for (const [index, word] of WORDS.entries()) {
      for (const key of word) await tapKey(d, key, index + 1, rec, parallel)
      await tapKey(d, 'Space', index + 1, rec, parallel)
      if (parallel) samplers.push(sampler(d, index + 1, SAMPLE_SECONDS, rec.samples, stop))
      await sleep(AFTER_SPACE)
    }
    // The final read, which the diagnostics must not move.
    rec.text = (await state()).text ?? ''
    rec.ok = rec.text.replace(/ /g, ' ') === EXPECTED
  } catch (error) {
    rec.fault = errorRepr(error)
  }
  if (parallel) {
    stop.set = true
    const t0 = Date.now()
    const joined = await Promise.race([Promise.allSettled(samplers).then(() => true), sleep(JOIN_SECONDS).then(() => false)])
    rec.join = {waitedMs: Date.now() - t0, cut: !joined}
    await readMarks(rec)
  }
  report(rec)
  writeFileSync(`${out}/space-parallel.json`, JSON.stringify(records, null, 2))
}

/** One logcat read for every marker of the repetition, as the driver would after its final read. */
async function readMarks(rec: Record_): Promise<void> {
  const marks = rec.taps.flatMap((t) => (t.mark ? [t.mark] : []))
  if (marks.length === 0) return
  const t0 = Date.now()
  try {
    const offset = await clockOffset()
    const since = (marks[0]!.startedAt + offset - 1).toFixed(3)
    const log = await adb(['logcat', '-d', '-v', 'epoch', '-b', 'main', '-T', since], 10)
    const lines = log.split(/\r?\n/)
    const at = marks.map((m) => lines.findIndex((l) => l.includes(m.marker)))
    const found = at.filter((i) => i >= 0)
    const first = Math.min(...found)
    const last = Math.max(...found)
    rec.logcat = {
      markers: marks.length,
      found: found.length,
      inOrder: found.every((i, k) => k === 0 || i > found[k - 1]!),
      restarts: found.length ? lines.slice(first, last + 1).filter((l) => l.includes('GoogleInputMethodService.onStartInput(')).length : 0,
      readMs: Date.now() - t0,
    }
  } catch (error) {
    rec.logcat = {markers: marks.length, found: 0, inOrder: false, restarts: 0, readMs: Date.now() - t0, error: errorRepr(error)}
  }
}

function report(r: Record_): void {
  const ms = (s: number) => Math.round(s * 1000)
  const rpc = r.taps.map((t) => ms(t.respondedAt - t.requestAt))
  console.log(
    `PAR arm=${r.arm} rep=${r.rep} text=${pyRepr(r.text)} ok=${r.ok} taps=${r.taps.length} overlapped=${r.taps.filter((t) => t.dumpsInFlight > 0).length} click_ms_max=${Math.max(0, ...rpc)}${r.fault ? ` FAULT ${r.fault}` : ''}`,
  )
  for (const t of r.taps)
    console.log(
      `PAR_TAP arm=${r.arm} rep=${r.rep} word=${t.word} key=${t.key} strip_before_tap=${pyRepr(t.strip)} click_ms=${ms(t.respondedAt - t.requestAt)} dumps_in_flight=${t.dumpsInFlight}${t.mark ? ` mark_ms=${t.mark.endedAt ? ms(t.mark.endedAt - t.mark.startedAt) : 'pending'} mark_ok=${t.mark.ok}` : ''}`,
    )
  for (const space of [1, 2]) {
    const spaceTap = r.taps.filter((t) => t.word === space && t.key === 'Space')[0]
    if (!spaceTap) continue
    const next = r.taps.filter((t) => t.word === space + 1)
    // The driver's own dump before the next word's first letter: the read a strip check could reuse.
    if (next[0]) console.log(`PAR_REUSE arm=${r.arm} rep=${r.rep} space=${space} dump_at=+${(next[0].dumpAt - spaceTap.requestAt).toFixed(2)} kind=${classify(next[0].strip, WORDS[space - 1]!, '')} strip=${pyRepr(next[0].strip)}`)
    for (const s of r.samples.filter((x) => x.space === space)) {
      // Letters of the next word whose tap was answered before this dump started. Gboard's own handling time
      // is matched from logcat in the report.
      const typed = next.filter((t) => t.key !== 'Space' && t.respondedAt <= s.startedAt).map((t) => t.key).join('')
      console.log(
        `PAR_STRIP arm=${r.arm} rep=${r.rep} space=${space} t=+${(s.startedAt - spaceTap.requestAt).toFixed(2)}..+${(s.endedAt - spaceTap.requestAt).toFixed(2)} typed=${pyRepr(typed)} kind=${classify(s.strip, WORDS[space - 1]!, typed)} strip=${pyRepr(suggestions(s.strip))}${s.error ? ` ERROR ${s.error}` : ''}`,
      )
    }
  }
  if (r.join) console.log(`PAR_JOIN arm=${r.arm} rep=${r.rep} waited_ms=${r.join.waitedMs} cut=${r.join.cut}`)
  if (r.logcat) console.log(`PAR_LOGCAT arm=${r.arm} rep=${r.rep} markers=${r.logcat.markers} found=${r.logcat.found} in_order=${r.logcat.inOrder} restarts=${r.logcat.restarts} read_ms=${r.logcat.readMs}${r.logcat.error ? ` ERROR ${r.logcat.error}` : ''}`)
}

/**
 * For each tap, the device times of its uiautomator2 request line and of Gboard's first line for the key
 * after it (ProactiveUndoTriggerExtension, which logs the decoded key, SPACE for keyCode 62).
 */
export function deviceLags(lines: Array<{t: number; tag: string; line: string}>, taps: Tap[], offset: number): Array<{request: number | undefined; gboard: number | undefined}> {
  const requests = lines.filter((l) => l.tag === 'UIAutomatorStub' && l.line.includes('"method":"click"'))
  const keys = lines.filter((l) => l.tag === 'ProactiveUndoTriggerExtension' && /keyCode=(62|-20003)/.test(l.line))
  return taps.map((tap) => {
    const sent = tap.requestAt + offset
    const request = requests.find((l) => l.t >= sent - 0.5 && l.t <= tap.respondedAt + offset + 0.5)?.t
    const gboard = request === undefined ? undefined : keys.find((l) => l.t >= request && l.t <= request + 3)?.t
    return {request, gboard}
  })
}

export function summary(recs: Record_[], arm: Arm): string {
  const rs = recs.filter((r) => r.arm === arm)
  const taps = rs.flatMap((r) => r.taps)
  const clicks = taps.map((t) => (t.respondedAt - t.requestAt) * 1000).sort((a, b) => a - b)
  const q = (p: number) => (clicks.length ? Math.round(clicks[Math.min(clicks.length - 1, Math.floor(p * clicks.length))]!) : NaN)
  const reuse = rs.flatMap((r) => {
    const space = r.taps.find((t) => t.word === 1 && t.key === 'Space')
    const next = r.taps.find((t) => t.word === 2)
    return space && next ? [classify(next.strip, WORDS[0]!, '')] : []
  })
  return `PAR_SUMMARY arm=${arm} reps=${rs.length} reuse_predictions=${reuse.filter((k) => k === 'predictions').length}/${reuse.length} faults=${rs.filter((r) => r.fault).length} text_ok=${rs.filter((r) => r.ok).length} taps=${taps.length} overlapped=${taps.filter((t) => t.dumpsInFlight > 0).length} click_ms_p50=${q(0.5)} p90=${q(0.9)} max=${q(1)}`
}

async function main(): Promise<void> {
  out = process.argv[2] ?? 'out'
  mkdirSync(out, {recursive: true})
  watchdog(1080)
  phase('start space parallel probe')
  const logs = new LogStream()
  const d = await openKeyboard('plain.html', '', out, 'parallel')
  const offset = await clockOffset()
  phase(`device clock offset ${offset.toFixed(3)}s`)
  for (let n = 1; n <= REPS; n++) for (const arm of n % 2 ? ARMS : [...ARMS].reverse()) await rep(d, arm, n)
  await sleep(2)
  for (const r of records) {
    const lags = deviceLags(logs.lines, r.taps, offset)
    r.taps.forEach((t, i) => Object.assign(t, {device: lags[i]}))
    for (const [i, t] of r.taps.entries()) {
      const l = lags[i]!
      console.log(
        `PAR_LAG arm=${r.arm} rep=${r.rep} word=${t.word} key=${t.key} dumps_in_flight=${t.dumpsInFlight} request_after_send_ms=${l.request === undefined ? 'none' : Math.round((l.request - t.requestAt - offset) * 1000)} gboard_after_request_ms=${l.gboard === undefined || l.request === undefined ? 'none' : Math.round((l.gboard - l.request) * 1000)}`,
      )
    }
  }
  writeFileSync(`${out}/space-parallel.json`, JSON.stringify(records, null, 2))
  writeFileSync(`${out}/space-parallel-logcat.txt`, logs.lines.map((l) => l.line).join('\n') + '\n')
  for (const arm of ARMS) console.log(summary(records, arm))
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
