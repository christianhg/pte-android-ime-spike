// Does switching Gboard to Japanese only after its Mozc dictionary has loaded give kanji for romaji "kyou"?
//
// Run 41202239894: the one boot whose mozcdata "New data is loaded" line came before the switch to ja-JP had
// 今日 at once and logged "Mozc engine reload status: RELOADED". The two boots whose load came after the switch
// never had kanji. Three arms, picked by PROBE_ARM:
//   control          switch to Japanese as soon as the keyboard shows, as the other probes do
//   load-then-switch wait for the load line with the keyboard on English, then switch
//   switch-reswitch  switch at once, wait for the load line, then switch away and back once
// After the arm's switch, for about 60s, type kyou, read the strip and, when it has no kanji, the expanded
// その他の候補 list too, then delete the composition. Nothing is ever committed.
//
// The log lines come from out/boot-logcat.txt, which run-on-device.sh streams from boot. Every time is in
// seconds after the last BOOTED line in out/timing.txt (host clock, which the emulator's clock follows).
//
// Usage: IME_LANG=ja PROBE_ARM=<arm>[-<n>] node scripts/probe-load.ts <outdir>

import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs'
import {adbOutput} from './lib/adb.ts'
import {cdpEval} from './lib/cdp.ts'
import type {Device} from './lib/u2.ts'
import {errorRepr, phase, pyRepr, sleep, watchdog} from './lib/util.ts'
import {ensureJapanese, gboardKeys, isJapanese, openKeyboard} from './drive.ts'
import {candidates, clear, gboardNodes, type Node} from './probe-candidates.ts'
import {hasKanji, stripLabels} from './probe-readiness.ts'

export const ARMS = ['control', 'load-then-switch', 'switch-reswitch'] as const
export type Arm = (typeof ARMS)[number]

// Run 41202239894 loaded at 122s, 125s and 166s after boot. The 166s boot had one download error (101s) and
// retry 1/3 (104s), 65s from error to load. Retries 2/3 and 3/3 at that pace end at 166 + 2 x 65 = 296s.
// 360s leaves about 20% on top of that.
export const LOAD_DEADLINE = 360
const WINDOW = 60
const PERIOD = 5
const NAV = /^android:id\/input_method_nav_/
const MORE_ID = 'key_pos_show_more_candidates'
const center = (n: Node): [number, number] => [Math.floor((n.bounds[0] + n.bounds[2]) / 2), Math.floor((n.bounds[1] + n.bounds[3]) / 2)]

export type LogEvents = {
  loads: Array<{t: number; line: string}>
  entries: Array<{t: number; lang: string; source: string; line: string}>
  reloads: Array<{t: number; status: string; line: string}>
  errors: Array<{t: number; pack: string; line: string}>
  retries: Array<{t: number; pack: string; n: number; of: number; line: string}>
  // Each CAPTURE_START marker the shell writes when (re)starting adb logcat, as epoch seconds.
  starts: number[]
  // A restarted adb logcat dumps the whole buffer again, so its first line should be no later than the
  // previous stream's last one. A later first line means lines in between were lost.
  gaps: Array<{from: number; to: number}>
  first?: number
  last?: number
  lines: number
}

/** The epoch seconds of a logcat line in `-v epoch` or `-v time`/`threadtime` format (the latter read as UTC in `year`). */
export function lineTime(line: string, year: number): number | undefined {
  const epoch = line.match(/^\s*(\d{9,}\.\d+)\s/)
  if (epoch) return Number(epoch[1])
  const time = line.match(/^(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)\.(\d{3})\s/)
  if (!time) return undefined
  const [mo, d, h, mi, s, ms] = time.slice(1).map(Number) as [number, number, number, number, number, number]
  return Date.UTC(year, mo - 1, d, h, mi, s, ms) / 1000
}

export const isLoadLine = (line: string): boolean => line.includes('data_loader.cc') && line.includes('New data is loaded') && line.includes('mozcdata')

/** Pick the lines the probe reports out of a logcat capture. Lines repeated by a restarted stream count once. */
export function scanLog(text: string, year: number): LogEvents {
  const ev: LogEvents = {loads: [], entries: [], reloads: [], errors: [], retries: [], starts: [], gaps: [], lines: 0}
  const seen = new Set<string>()
  let segmentLast: number | undefined
  let segmentFirst = true
  for (const line of text.split(/\r?\n/)) {
    const start = line.match(/^CAPTURE_START (\d+)/)
    if (start) {
      ev.starts.push(Number(start[1]))
      segmentFirst = true
      continue
    }
    const t = lineTime(line, year)
    if (t === undefined) continue
    if (segmentFirst && segmentLast !== undefined && t > segmentLast + 1) ev.gaps.push({from: segmentLast, to: t})
    segmentFirst = false
    segmentLast = segmentLast === undefined ? t : Math.max(segmentLast, t)
    ev.lines += 1
    ev.first = ev.first === undefined ? t : Math.min(ev.first, t)
    ev.last = ev.last === undefined ? t : Math.max(ev.last, t)
    if (seen.has(line)) continue
    seen.add(line)
    if (isLoadLine(line)) ev.loads.push({t, line})
    const entry = line.match(/onCurrentInputMethodEntryChanged\(\).*?entry: ([\w-]+), source: (\w+)/)
    if (entry) ev.entries.push({t, lang: entry[1]!, source: entry[2]!, line})
    const reload = line.match(/Mozc engine reload status: (\w+)/)
    if (reload) ev.reloads.push({t, status: reload[1]!, line})
    const error = line.match(/error downloading (__MOZCPACK_\w+)/)
    if (error) ev.errors.push({t, pack: error[1]!, line})
    const retry = line.match(/Retry download filegroup (__MOZCPACK_\w+) (\d+)\/(\d+)/)
    if (retry) ev.retries.push({t, pack: retry[1]!, n: Number(retry[2]), of: Number(retry[3]), line})
  }
  return ev
}

export type LoadClass = 'early' | 'late' | 'none'

/** early: the load line came before the first switch to ja-JP. late: after it, or never while a switch happened. */
export function classify(loadT: number | undefined, firstJaT: number | undefined): LoadClass {
  if (loadT === undefined) return firstJaT === undefined ? 'none' : 'late'
  return firstJaT === undefined || loadT < firstJaT ? 'early' : 'late'
}

export const isHiragana = (s: string): boolean => /^[ぁ-ゟー]+$/u.test(s)

/** Conversion texts on the strip or the expanded list: text nodes that were not on the idle strip. */
export function conversions(nodes: Node[], idle: Set<string>): string[] {
  return candidates(nodes).filter((n) => n.text && !NAV.test(n.rid) && !idle.has(n.text) && !idle.has(n.label)).map((n) => n.text)
}

export const nonHiragana = (texts: string[]): string[] => [...new Set(texts.filter((s) => !isHiragana(s)))]

export type Try = {t: number; kanji: boolean; strip: string[]; expanded: string[] | null; nonHiragana: string[]; error?: string}

export type Result = 'kanji' | 'no-kanji' | 'driver-error' | 'setup-fault-never-loaded' | 'capture-fault'

export function result(loaded: boolean, captureOk: boolean, tries: Try[]): Result {
  if (!loaded) return captureOk ? 'setup-fault-never-loaded' : 'capture-fault'
  if (tries.some((t) => t.kanji)) return 'kanji'
  if (!tries.length || tries.every((t) => t.error)) return 'driver-error'
  return 'no-kanji'
}

const secs = (t: number | undefined): string => (t === undefined ? 'none' : t.toFixed(1))

export function loadSummary(s: {arm: string; cls: LoadClass; loadT: number | undefined; switchT: number | undefined; reloads: string[]; firstKanjiT: number | undefined; nonHiragana: string[]; result: Result}): string {
  return `LOAD_SUMMARY arm=${s.arm} class=${s.cls} load_t=${secs(s.loadT)} switch_t=${secs(s.switchT)} reloaded=${s.reloads.length ? s.reloads.join('+') : 'none'} first_kanji_t=${secs(s.firstKanjiT)} non_hiragana=${pyRepr(s.nonHiragana)} result=${s.result}`
}

let out = 'out'
let booted = 0
let year = new Date().getUTCFullYear()
let idle = new Set<string>()
const tries: Try[] = []

const now = (): number => Date.now() / 1000 - booted

function capture(): LogEvents {
  const path = `${out}/boot-logcat.txt`
  return scanLog(existsSync(path) ? readFileSync(path, 'utf8') : '', year)
}

/** The stream ran from boot without a hole and is still writing. Only then does a missing line mean "not there". */
function captureOk(ev: LogEvents): boolean {
  return ev.starts.length > 0 && ev.starts[0]! <= booted + 60 && ev.gaps.length === 0 && ev.last !== undefined && Date.now() / 1000 - ev.last < 120
}

/** Poll the capture until the load line shows or LOAD_DEADLINE after boot. Download retries share the one deadline. */
async function waitForLoad(): Promise<number | undefined> {
  phase(`waiting for the mozcdata load line, deadline ${LOAD_DEADLINE}s after boot (now ${now().toFixed(1)}s)`)
  let logged = 0
  for (;;) {
    // A full scan only once the load text shows up anywhere; the capture grows to tens of MB.
    const path = `${out}/boot-logcat.txt`
    const ev = existsSync(path) && readFileSync(path, 'utf8').includes('New data is loaded') ? capture() : undefined
    const load = ev?.loads[0]
    if (load) {
      console.log(`LOAD WAIT seen t=${(load.t - booted).toFixed(1)} at=${now().toFixed(1)}`)
      return load.t - booted
    }
    if (now() - logged >= 30) {
      logged = now()
      const full = ev ?? capture()
      console.log(`LOAD WAIT t=${now().toFixed(1)} errors=${full.errors.length} retries=${full.retries.length} capture_lines=${full.lines}`)
    }
    if (now() >= LOAD_DEADLINE) {
      console.log(`LOAD WAIT deadline t=${now().toFixed(1)} no load line`)
      return undefined
    }
    await sleep(2)
  }
}

async function switchJapanese(d: Device, what: string): Promise<number> {
  console.log(`LOAD ACTION t=${now().toFixed(1)} ${what} start`)
  await ensureJapanese(d, out, `load-${what}`)
  const t = now()
  console.log(`LOAD ACTION t=${t.toFixed(1)} ${what} japanese layout active`)
  return t
}

/** Tap the language key on the Japanese layout until it leaves Japanese. With English and Japanese only, that lands on English. */
async function switchAway(d: Device): Promise<void> {
  console.log(`LOAD ACTION t=${now().toFixed(1)} switch-away start`)
  for (let attempt = 0; attempt < 4; attempt++) {
    const keys = await gboardKeys(d)
    if (!isJapanese(keys.keys())) {
      console.log(`LOAD ACTION t=${now().toFixed(1)} switch-away left japanese after ${attempt} taps`)
      return
    }
    const key = [...keys.keys()].find((k) => k === '次の言語' || /^(next language|switch to|globe)/i.test(k))
    if (!key) throw new Error(`no language key on the Japanese layout, labels ${pyRepr([...keys.keys()].slice(0, 60))}`)
    await d.click(...keys.get(key)!)
    await sleep(1.5)
  }
  throw new Error('could not switch Gboard away from Japanese')
}

/** Dump until two consecutive dumps give the same strip labels, or 8 tries. */
async function settled(d: Device): Promise<{xml: string; nodes: Node[]}> {
  let xml = ''
  let nodes: Node[] = []
  let previous: string | undefined
  for (let i = 0; i < 8; i++) {
    xml = await d.dumpHierarchy()
    nodes = gboardNodes(xml)
    const sig = stripLabels(nodes, idle).join('|')
    if (nodes.length && sig === previous) break
    previous = sig
    await sleep(0.5)
  }
  return {xml, nodes}
}

/** Open その他の候補, read the list and close it through the same toggle. Never taps a candidate. */
async function expanded(d: Device, n: number, strip: Node[]): Promise<string[] | null> {
  const more = strip.find((x) => x.rid === MORE_ID) ?? strip.find((x) => x.label === 'その他の候補')
  if (!more) {
    console.log(`LOAD TRY i=${n} NO_MORE_BUTTON`)
    return null
  }
  const at = center(more)
  await d.click(...at)
  await sleep(0.8)
  const {xml, nodes} = await settled(d)
  writeFileSync(`${out}/load-i${n}-expanded.xml`, xml)
  const list = conversions(nodes, idle)
  const toggle = nodes.find((x) => x.rid === MORE_ID)
  console.log(`LOAD TRY i=${n} EXPANDED count=${list.length} texts=${pyRepr(list)} toggle=${pyRepr(toggle?.label ?? null)}`)
  // The list leaves the keyboard's delete key hidden. Gboard turns the toggle into その他の候補を非表示.
  for (let i = 0; i < 3; i++) {
    const current = gboardNodes(await d.dumpHierarchy())
    if (current.some((x) => x.rid === 'key_pos_del')) return list
    const close = current.find((x) => x.rid === MORE_ID)
    await d.click(...(close ? center(close) : at))
    await sleep(1)
  }
  console.log(`LOAD TRY i=${n} CLOSE_FAILED`)
  return list
}

async function attempt(d: Device, n: number): Promise<Try> {
  const t = now()
  try {
    const keys = await gboardKeys(d)
    for (const key of 'kyou') {
      const at = keys.get(key) ?? keys.get(key.toUpperCase())
      if (!at) throw new Error(`no Gboard key ${pyRepr(key)}`)
      await d.click(...at)
      await sleep(0.4)
    }
    const {xml, nodes} = await settled(d)
    const strip = stripLabels(nodes, idle)
    const it: Try = {t, kanji: strip.some(hasKanji), strip, expanded: null, nonHiragana: []}
    if (!it.kanji) {
      writeFileSync(`${out}/load-i${n}-strip.xml`, xml)
      it.expanded = await expanded(d, n, nodes)
      it.nonHiragana = nonHiragana([...conversions(nodes, idle), ...(it.expanded ?? [])])
    }
    const field = ((await cdpEval('window.__state()')) as {text: string | null}).text
    console.log(`LOAD TRY t=${t.toFixed(1)} i=${n} kanji=${it.kanji} strip=${pyRepr(strip)} expanded=${it.expanded ? pyRepr(it.expanded) : 'None'} non_hiragana=${pyRepr(it.nonHiragana)} field=${pyRepr(field)}`)
    return it
  } catch (error) {
    console.log(`LOAD TRY t=${t.toFixed(1)} i=${n} ERROR ${errorRepr(error)}`)
    return {t, kanji: false, strip: [], expanded: null, nonHiragana: [], error: errorRepr(error)}
  } finally {
    try {
      await clear(d, `load-i${n}`)
    } catch (error) {
      phase(`i${n} clear failed: ${errorRepr(error)}`)
    }
  }
}

/** Kyou about every 5s for WINDOW seconds after the arm's switch. */
async function checks(d: Device): Promise<void> {
  // A dump taken mid-redraw can miss the strip, and then its controls would count as candidates.
  let xml = ''
  for (let i = 0; i < 6; i++) {
    xml = await d.dumpHierarchy()
    if (gboardNodes(xml).some((n) => n.rid === 'key_pos_space')) break
    await sleep(1)
  }
  writeFileSync(`${out}/load-idle.xml`, xml)
  idle = new Set(candidates(gboardNodes(xml)).map((n) => n.label))
  console.log(`LOAD IDLE strip=${pyRepr([...idle])}`)
  const start = now()
  for (let n = 1; now() - start < WINDOW; n++) {
    const it = await attempt(d, n)
    tries.push(it)
    writeFileSync(`${out}/load-probe.json`, JSON.stringify(tries, null, 2))
    const wait = it.t + PERIOD - now()
    if (wait > 0) await sleep(wait)
  }
}

/** Every reported log line, from the boot capture and, when that has a hole, a dump of all buffers on top. */
async function report(arm: Arm, switchHost: number | undefined): Promise<void> {
  let ev = capture()
  const ok = captureOk(ev)
  console.log(`LOAD CAPTURE ok=${ok} lines=${ev.lines} starts=${ev.starts.map((s) => (s - booted).toFixed(0)).join(',') || 'none'} first_t=${secs(ev.first === undefined ? undefined : ev.first - booted)} last_t=${secs(ev.last === undefined ? undefined : ev.last - booted)} gaps=${pyRepr(ev.gaps.map((g) => `${(g.from - booted).toFixed(1)}-${(g.to - booted).toFixed(1)}`))}`)
  if (!ok) {
    // Only ever adds lines: a line missing here may have dropped out of the ring buffer.
    try {
      const dump = await adbOutput(['logcat', '-d', '-v', 'epoch', '-b', 'all'], 120)
      writeFileSync(`${out}/load-logcat-dump.txt`, dump)
      const extra = scanLog(dump, year)
      const merge = <T extends {t: number; line: string}>(a: T[], b: T[]): T[] => [...a, ...b.filter((x) => !a.some((y) => y.line === x.line))].sort((x, y) => x.t - y.t)
      ev = {...ev, loads: merge(ev.loads, extra.loads), entries: merge(ev.entries, extra.entries), reloads: merge(ev.reloads, extra.reloads), errors: merge(ev.errors, extra.errors), retries: merge(ev.retries, extra.retries)}
    } catch (error) {
      console.log(`LOAD CAPTURE dump failed: ${errorRepr(error)}`)
    }
  }
  const rel = (t: number): string => (t - booted).toFixed(1)
  if (!ev.loads.length) console.log('LOAD LINE none')
  ev.loads.forEach((l) => console.log(`LOAD LINE t=${rel(l.t)} ${l.line}`))
  ev.entries.forEach((e) => console.log(`LOAD SWITCH t=${rel(e.t)} entry=${e.lang} source=${e.source}${e.lang === 'ja-JP' ? ' JA' : ''}`))
  ev.reloads.forEach((r) => console.log(`LOAD RELOAD t=${rel(r.t)} status=${r.status}`))
  ev.errors.forEach((e) => console.log(`LOAD DOWNLOAD_ERROR t=${rel(e.t)} pack=${e.pack}`))
  ev.retries.forEach((r) => console.log(`LOAD DOWNLOAD_RETRY t=${rel(r.t)} pack=${r.pack} ${r.n}/${r.of}`))

  const loadT = ev.loads[0] && ev.loads[0].t - booted
  const ja = ev.entries.filter((e) => e.lang === 'ja-JP').map((e) => e.t - booted)
  // The arm's own switch: the last ja-JP entry logged by the time the layout showed (with 3s for log latency).
  const switchT = switchHost === undefined ? undefined : ja.filter((t) => t <= switchHost + 3).at(-1)
  const first = tries.find((t) => t.kanji)
  console.log(loadSummary({
    arm,
    cls: classify(loadT, ja[0]),
    loadT,
    switchT,
    reloads: ev.reloads.map((r) => r.status),
    firstKanjiT: first?.t,
    nonHiragana: [...new Set(tries.flatMap((t) => t.nonHiragana))],
    result: result(loadT !== undefined, ok, tries),
  }))
}

async function main(): Promise<void> {
  out = process.argv[2] ?? 'out'
  mkdirSync(out, {recursive: true})
  // The workflow passes the matrix attempt, <arm>-<n>.
  const arm = (process.env.PROBE_ARM ?? '').replace(/-\d+$/, '') as Arm
  if (!ARMS.includes(arm)) throw new Error(`PROBE_ARM must be one of ${ARMS.join(', ')}, optionally with -<n>, got ${pyRepr(process.env.PROBE_ARM ?? null)}`)
  // The last BOOTED line: the workflow's boot retry appends to the same timing.txt.
  const timing = [...readFileSync(`${out}/timing.txt`, 'utf8').matchAll(/BOOTED at (\d+)/g)].at(-1)
  if (!timing) throw new Error('no BOOTED line in timing.txt')
  booted = Number(timing[1])
  year = new Date(booted * 1000).getUTCFullYear()
  watchdog(700)
  phase(`start load probe arm=${arm}, booted ${now().toFixed(1)}s ago`)
  // Log times are the device's clock, BOOTED is the host's. Show the skew between them.
  const device = Number((await adbOutput(['shell', 'date', '+%s'])).trim())
  console.log(`LOAD CLOCK host=${Math.floor(Date.now() / 1000)} device=${device} origin=BOOTED ${booted}`)

  // Open the keyboard on English, so every arm makes its first switch to Japanese itself.
  delete process.env.IME_LANG
  const d = await openKeyboard('plain.html', '', out, `load-${arm}`)
  process.env.IME_LANG = 'ja'
  // Gboard has so far opened on English. If it opens on Japanese, the arms that wait first leave it again.
  if (isJapanese((await gboardKeys(d)).keys())) {
    console.log(`LOAD ACTION t=${now().toFixed(1)} keyboard opened on japanese`)
    if (arm === 'load-then-switch') await switchAway(d)
  }
  let switchHost: number | undefined
  let loadT: number | undefined
  if (arm === 'control') {
    switchHost = await switchJapanese(d, 'switch')
  } else if (arm === 'load-then-switch') {
    loadT = await waitForLoad()
    if (loadT !== undefined) switchHost = await switchJapanese(d, 'switch')
  } else {
    await switchJapanese(d, 'switch')
    loadT = await waitForLoad()
    if (loadT !== undefined) {
      await switchAway(d)
      switchHost = await switchJapanese(d, 'reswitch')
    }
  }
  if (switchHost !== undefined) await checks(d)
  // The control arm never waited, so wait now to tell a late load from none.
  if (loadT === undefined && arm === 'control') await waitForLoad()
  await report(arm, switchHost)
}

if (import.meta.main) {
  main().then(
    () => process.exit(0),
    async (error: unknown) => {
      console.error(error instanceof Error ? (error.stack ?? errorRepr(error)) : String(error))
      try {
        if (booted) await report((process.env.PROBE_ARM ?? 'unknown').replace(/-\d+$/, '') as Arm, undefined)
      } catch (e) {
        console.log(`LOAD report failed: ${errorRepr(e)}`)
      }
      process.exit(1)
    },
  )
}
