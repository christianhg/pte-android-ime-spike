// Find out when Japanese Gboard starts offering kanji for romaji "kyou" after it first shows the Japanese layout.
//
// Run 41198153394 typed kyou 6s after Gboard turned Japanese and got only きょう, while 今日 led the strip about
// 60s later. T0 is the moment the Japanese layout first shows. From there, about every 5s for up to 180s, type
// kyou into the plain page's field, dump the strip until it settles, log a READY line and clear the field. The
// loop stops 3 iterations after the first strip with a kanji candidate. The notification shade is checked before
// the loop and at first readiness, and both moments get a full dump. A READINESS_SUMMARY line ends the run.
//
// Usage: IME_LANG=ja node scripts/probe-readiness.ts <outdir>

import {mkdirSync, writeFileSync} from 'node:fs'
import {adbOutput} from './lib/adb.ts'
import {cdpEval} from './lib/cdp.ts'
import {parseXml} from './lib/hierarchy.ts'
import type {Device} from './lib/u2.ts'
import {errorRepr, phase, pyRepr, sleep, watchdog} from './lib/util.ts'
import {gboardKeys, openKeyboard} from './drive.ts'
import {candidates, clear, gboardNodes, type Node} from './probe-candidates.ts'

const WINDOW = 180
const PERIOD = 5
const AFTER = 3
// The idle strip's own controls (設定, 機能メニューを開く) hold ideographs too, and so does the system nav bar's
// row. Only labels that were not on the idle strip at T0 count as candidates.
const NAV = /^android:id\/input_method_nav_/
const NOTIFY = /gboard|inputmethod\.latin|日本語|japanese/i

type Iteration = {t: number; kanji: boolean; labels: string[]; error?: string}

const iterations: Iteration[] = []
let out = 'out'
let t0 = 0
let idle = new Set<string>()

const since = (): number => (Date.now() - t0) / 1000

export const hasKanji = (s: string): boolean => /[一-鿿]/.test(s)

/** Strip labels that kyou brought, in strip order: everything labelled that was not on the idle strip. */
export function stripLabels(nodes: Node[], idleLabels: Set<string>): string[] {
  return candidates(nodes).filter((n) => !NAV.test(n.rid) && !idleLabels.has(n.label)).map((n) => n.label)
}

/** Dump until two consecutive dumps give the same strip labels, or 8 tries. Returns the last dump. */
async function settled(d: Device): Promise<{xml: string; labels: string[]; dumps: number}> {
  let xml = ''
  let labels: string[] = []
  let previous: string | undefined
  let tries = 0
  for (; tries < 8; tries++) {
    xml = await d.dumpHierarchy()
    labels = stripLabels(gboardNodes(xml), idle)
    const sig = labels.join('|')
    if (sig === previous) break
    previous = sig
    await sleep(0.5)
  }
  return {xml, labels, dumps: Math.min(tries + 1, 8)}
}

async function save(d: Device, xml: string, name: string): Promise<void> {
  const base = `${out}/ready-${name}`
  writeFileSync(`${base}.xml`, xml)
  await d.screenshot(base)
}

/** The notification shade's lines that mention Gboard or Japanese, and the whole dump on disk. */
async function notifications(name: string): Promise<void> {
  try {
    const dump = await adbOutput(['shell', 'dumpsys', 'notification', '--noredact'])
    writeFileSync(`${out}/ready-notifications-${name}.txt`, dump)
    const lines = dump.split(/\r?\n/).map((l) => l.trim()).filter((l) => NOTIFY.test(l))
    console.log(`READY NOTIFY ${name} t=${since().toFixed(1)} matches=${lines.length}`)
    lines.slice(0, 60).forEach((l) => console.log(`READY NOTIFY ${name} ${l}`))
  } catch (error) {
    console.log(`READY NOTIFY ${name} ERROR ${errorRepr(error)}`)
  }
}

/** Every labelled node on screen, of any package, as "package: label". */
export function screenLabels(xml: string): Set<string> {
  const labels = new Set<string>()
  for (const n of parseXml(xml)) {
    const label = n.attrs['content-desc'] || n.attrs.text
    if (n.tag === 'node' && label) labels.add(`${n.attrs.package ?? ''}: ${label}`)
  }
  return labels
}

/** Labels on screen that differ from those at T0, both with the field cleared: a banner, a toast or a changed strip. */
function changed(xml: string, before: Set<string>): string[] {
  const now = screenLabels(xml)
  return [...[...now].filter((l) => !before.has(l)).map((l) => `+${l}`), ...[...before].filter((l) => !now.has(l)).map((l) => `-${l}`)]
}

async function iteration(d: Device, n: number): Promise<Iteration> {
  const start = since()
  try {
    const keys = await gboardKeys(d)
    for (const key of 'kyou') {
      const at = keys.get(key) ?? keys.get(key.toUpperCase())
      if (!at) throw new Error(`no Gboard key ${pyRepr(key)}`)
      await d.click(...at)
      await sleep(0.4)
    }
    const {xml, labels, dumps} = await settled(d)
    const it: Iteration = {t: start, kanji: labels.some(hasKanji), labels}
    const text = ((await cdpEval('window.__state()')) as {text: string | null}).text
    console.log(`READY t=${start.toFixed(1)} kanji=${it.kanji} labels=${pyRepr(labels)} field=${pyRepr(text)} dumps=${dumps} i=${n}`)
    if (it.kanji && !iterations.some((i) => i.kanji)) {
      await save(d, xml, 'first-kanji')
      await notifications('first-kanji')
    }
    return it
  } catch (error) {
    console.log(`READY t=${start.toFixed(1)} ERROR ${errorRepr(error)} i=${n}`)
    return {t: start, kanji: false, labels: [], error: errorRepr(error)}
  } finally {
    try {
      await clear(d, `i${n}`)
    } catch (error) {
      phase(`i${n} clear failed: ${errorRepr(error)}`)
    }
  }
}

export function summary(its: Iteration[]): string {
  const first = its.findIndex((i) => i.kanji)
  const after = first < 0 ? [] : its.slice(first + 1).map((i) => (i.error ? 'error' : String(i.kanji)))
  return `READINESS_SUMMARY first_kanji_t=${first < 0 ? 'none' : its[first]!.t.toFixed(1)} iterations=${its.length} after=[${after.join(',')}]`
}

async function main(): Promise<void> {
  out = process.argv[2] ?? 'out'
  mkdirSync(out, {recursive: true})
  watchdog(560)
  phase('start readiness probe')
  // openKeyboard returns right after ensureJapanese logs "japanese layout active", so T0 is that moment.
  const d = await openKeyboard('plain.html', '', out, 'ready')
  t0 = Date.now()
  phase('T0 japanese layout active')
  // A dump taken mid-redraw can miss the strip, and then its controls would count as candidates.
  let xml0 = ''
  for (let i = 0; i < 6; i++) {
    xml0 = await d.dumpHierarchy()
    if (gboardNodes(xml0).some((n) => n.rid === 'key_pos_space')) break
    await sleep(1)
  }
  await save(d, xml0, 't0')
  idle = new Set(candidates(gboardNodes(xml0)).map((n) => n.label))
  const before = screenLabels(xml0)
  console.log(`READY T0 idle_strip=${pyRepr([...idle])}`)
  await notifications('t0')

  let first = -1
  // Past the window only to finish the iterations after the first kanji.
  for (let n = 1; since() < WINDOW || first >= 0; n++) {
    const it = await iteration(d, n)
    iterations.push(it)
    writeFileSync(`${out}/readiness-probe.json`, JSON.stringify(iterations, null, 2))
    if (it.kanji && first < 0) {
      first = iterations.length - 1
      console.log(`READY FIRST_KANJI t=${it.t.toFixed(1)} changed_since_t0=${pyRepr(changed(await d.dumpHierarchy(), before))}`)
    }
    if (first >= 0 && iterations.length - 1 - first >= AFTER) break
    const wait = it.t + PERIOD - since()
    if (wait > 0) await sleep(wait)
  }
  console.log(summary(iterations))
}

if (import.meta.main) {
  main().then(
    () => process.exit(0),
    (error: unknown) => {
      console.error(error instanceof Error ? (error.stack ?? errorRepr(error)) : String(error))
      console.log(summary(iterations))
      process.exit(1)
    },
  )
}
