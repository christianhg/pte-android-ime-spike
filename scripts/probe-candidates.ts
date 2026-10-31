// Find out what Japanese Gboard lists behind その他の候補 after romaji "kyou", and whether 今日 is there.
//
// Three repetitions, each on a fresh plain page. In each, word 1 is typed into the empty field and word 2
// after a first "kyou" committed with Space, as the crash cases do. For each word: dump the strip, tap
// その他の候補, dump the expanded list until it settles, and tap 今日 there if it is listed. Every step logs
// CAND lines, and the run ends with a CANDIDATES_SUMMARY line.
//
// Usage: IME_LANG=ja node scripts/probe-candidates.ts <outdir>

import {mkdirSync, writeFileSync} from 'node:fs'
import {adb} from './lib/adb.ts'
import {cdpEval} from './lib/cdp.ts'
import {parseXml} from './lib/hierarchy.ts'
import type {Device} from './lib/u2.ts'
import {errorRepr, phase, pyRepr, sleep, watchdog} from './lib/util.ts'
import {gboardKeys, openKeyboard} from './drive.ts'
import {codepoints} from './probe-dash.ts'

const GBOARD = 'com.google.android.inputmethod.latin'
const CHROME = 'com.android.chrome'
const ID = `${GBOARD}:id/`
const REPETITIONS = 3
const MORE = 'その他の候補'
const KANJI = '今日'
// Labels a control that closes the expanded list could carry. Its id is obfuscated, so match on the label.
const CLOSE = /閉じる|戻る|折りたた|たたむ|close|collapse|back/i

export type Node = {
  label: string
  desc: string
  text: string
  rid: string
  cls: string
  bounds: [number, number, number, number]
  clickable: boolean
  selected: boolean
  scrollable: boolean
  // The nearest scrollable ancestor, as "id class bounds", or '' when there is none.
  scroller: string
}
type PageEvent = {type: string; inputType?: string; data?: string | null}
type PageState = {text: string | null; events: PageEvent[]}
type WordResult = {rep: number; word: number; strip: boolean; more: boolean; expanded: boolean | null; scrolled: boolean; committed: string; codepoints: string[]; error?: string}

const results: WordResult[] = []
let out = 'out'
let dumps = 0
// Where その他の候補 sat, so the list can be closed from the same spot when no control is labelled as closing it.
let moreSpot: [number, number] | undefined

/** Every Gboard node, with the flags the expanded list is judged by. */
export function gboardNodes(xml: string): Node[] {
  const nodes: Node[] = []
  const ancestors: Array<Record<string, string>> = []
  for (const n of parseXml(xml)) {
    ancestors.length = n.depth
    ancestors[n.depth] = n.attrs
    if (n.tag !== 'node' || n.attrs.package !== GBOARD) continue
    const b = (n.attrs.bounds ?? '').match(/-?\d+/g)?.map(Number)
    if (!b || b.length !== 4) continue
    const s = ancestors.slice(0, n.depth).findLast((a) => a.scrollable === 'true')
    const desc = n.attrs['content-desc'] ?? ''
    const text = n.attrs.text ?? ''
    nodes.push({
      label: desc || text,
      desc,
      text,
      rid: (n.attrs['resource-id'] ?? '').replace(ID, ''),
      cls: (n.attrs.class ?? '').replace(/^android\.(widget|view)\./, ''),
      bounds: b as Node['bounds'],
      clickable: n.attrs.clickable === 'true',
      selected: n.attrs.selected === 'true',
      scrollable: n.attrs.scrollable === 'true',
      scroller: s ? `${(s['resource-id'] ?? '').replace(ID, '') || '-'} ${(s.class ?? '').replace(/^android\.(widget|view)\./, '')} ${s.bounds}` : '',
    })
  }
  return nodes
}

const center = (n: Node): [number, number] => [Math.floor((n.bounds[0] + n.bounds[2]) / 2), Math.floor((n.bounds[1] + n.bounds[3]) / 2)]
const visible = (n: Node): boolean => n.bounds[2] > n.bounds[0] && n.bounds[3] > n.bounds[1]
const isKey = (n: Node): boolean => n.rid.startsWith('key_pos_') && !n.rid.startsWith('key_pos_header')

/** Labelled Gboard nodes that are not keyboard keys: the strip's candidates and controls, or the expanded list. */
export function candidates(nodes: Node[]): Node[] {
  return nodes.filter((n) => n.label && visible(n) && !isKey(n))
}

export const findLabel = (nodes: Node[], label: string): Node | undefined => nodes.find((n) => n.label === label && visible(n))

function describe(n: Node): string {
  return `label=${pyRepr(n.label)} id=${n.rid || '-'} class=${n.cls} bounds=${n.bounds.join(',')} clickable=${n.clickable} selected=${n.selected} scrollable=${n.scrollable} scroller=${pyRepr(n.scroller || null)}`
}

const signature = (nodes: Node[]): string => candidates(nodes).map((n) => `${n.label}@${n.bounds.join(',')}`).join('|')

async function save(d: Device, xml: string, tag: string, name: string): Promise<void> {
  const base = `${out}/cand-${String(++dumps).padStart(3, '0')}-${tag}-${name}`
  writeFileSync(`${base}.xml`, xml)
  await d.screenshot(base)
}

/** Dump until two consecutive dumps list the same labelled nodes, or 8 tries. Saves the last dump and a screenshot. */
async function settled(d: Device, tag: string, name: string): Promise<Node[]> {
  let xml = ''
  let nodes: Node[] = []
  let previous: string | undefined
  let tries = 0
  for (; tries < 8; tries++) {
    xml = await d.dumpHierarchy()
    nodes = gboardNodes(xml)
    const sig = signature(nodes)
    if (nodes.length && sig === previous) break
    previous = sig
    await sleep(0.5)
  }
  phase(`${tag} ${name}: ${tries < 8 ? `settled after ${tries + 1} dumps` : 'still changing after 8 dumps'}, ${nodes.length} Gboard nodes`)
  await save(d, xml, tag, name)
  return nodes
}

async function state(): Promise<PageState> {
  return (await cdpEval('window.__state()')) as PageState
}

function composing(events: PageEvent[]): boolean {
  const last = events.filter((e) => e.type.startsWith('composition')).at(-1)
  return last !== undefined && last.type !== 'compositionend'
}

const eventsRepr = (events: PageEvent[]): string => pyRepr(events.map((e) => `${e.type}${e.inputType ? `:${e.inputType}` : ''}${e.data != null ? `:${e.data}` : ''}`))

async function tapKey(d: Device, label: string): Promise<void> {
  const keys = await gboardKeys(d)
  const at = keys.get(label) ?? keys.get(label.toUpperCase())
  if (!at) throw new Error(`no Gboard key ${pyRepr(label)}`)
  await d.click(...at)
  await sleep(0.4)
}

/** Return to the keyboard when the expanded list is still open, through its close control. */
async function backToKeyboard(d: Device, tag: string): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const nodes = gboardNodes(await d.dumpHierarchy())
    if (nodes.some((n) => n.rid === 'key_pos_del')) return
    const close = candidates(nodes).find((n) => CLOSE.test(n.label))
    const at = close ? center(close) : moreSpot
    phase(`${tag} keyboard not showing, closing the list via ${close ? pyRepr(close.label) : at ? `the その他の候補 spot ${at.join(',')}` : 'nothing found'}`)
    if (!at) return
    await d.click(...at)
    await sleep(1)
  }
}

/** Empty the field with Gboard's delete key, so an open composition goes too, then check over CDP. */
async function clear(d: Device, tag: string): Promise<void> {
  await backToKeyboard(d, tag)
  let s = await state()
  if (!s.text) return
  const del = gboardNodes(await d.dumpHierarchy()).find((n) => n.rid === 'key_pos_del' || n.label === '削除')
  for (let i = 0; i < [...s.text].length + 1 && del; i++) {
    await d.click(...center(del))
    await sleep(0.25)
  }
  await sleep(0.4)
  s = await state()
  if (s.text) {
    phase(`${tag} delete key left ${pyRepr(s.text)}, clearing over CDP`)
    await cdpEval("(() => { const el = document.getElementById('ed'); el.textContent = ''; const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); })()")
    await sleep(0.5)
  }
}

function logList(tag: string, where: string, nodes: Node[]): void {
  const list = candidates(nodes)
  console.log(`CAND ${tag} ${where} count=${list.length} labels=${pyRepr(list.map((n) => n.label))}`)
  list.forEach((n, i) => console.log(`CAND ${tag} ${where}[${i}] ${describe(n)}`))
}

/** Tap 今日 and log what the field holds afterwards. */
async function commit(d: Device, tag: string, node: Node, before: number, where: string): Promise<string> {
  await d.click(...center(node))
  await sleep(1.2)
  const s = await state()
  const text = s.text ?? ''
  console.log(`CAND ${tag} COMMITTED via=${where} text=${pyRepr(text)} codepoints=${codepoints(text).join(',') || '(empty)'} composing=${composing(s.events)} inputTypes=${[...new Set(s.events.slice(before).map((e) => e.inputType).filter((t): t is string => !!t))].join(',')} events=${eventsRepr(s.events.slice(before))}`)
  await save(d, await d.dumpHierarchy(), tag, 'after-commit')
  return text
}

/** Type kyou, look at the strip, open その他の候補 and pick 今日 there when it is listed. */
async function word(d: Device, rep: number, n: number): Promise<void> {
  const tag = `r${rep}w${n}`
  const result: WordResult = {rep, word: n, strip: false, more: false, expanded: null, scrolled: false, committed: '', codepoints: []}
  results.push(result)
  try {
    const before = (await state()).events.length
    for (const key of 'kyou') await tapKey(d, key)
    phase(`${tag} typed kyou`)
    const strip = await settled(d, tag, 'strip')
    logList(tag, 'STRIP', strip)
    const s = await state()
    console.log(`CAND ${tag} FIELD text=${pyRepr(s.text)} composing=${composing(s.events)} events=${eventsRepr(s.events.slice(before))}`)
    result.strip = !!findLabel(strip, KANJI)

    const more = findLabel(strip, MORE)
    if (!more) {
      console.log(`CAND ${tag} NO_MORE_BUTTON strip_has_kanji=${result.strip}`)
      const kanji = findLabel(strip, KANJI)
      if (kanji) result.committed = await commit(d, tag, kanji, before, 'strip')
      return
    }
    result.more = true
    console.log(`CAND ${tag} MORE ${describe(more)}`)
    moreSpot = center(more)
    await d.click(...moreSpot)
    await sleep(0.8)
    let list = await settled(d, tag, 'expanded')
    logList(tag, 'EXPANDED', list)
    const closers = candidates(list).filter((n) => CLOSE.test(n.label))
    // The control that opened the list often turns into the one that closes it, in the same spot.
    const [mx, my] = moreSpot
    const sameSpot = candidates(list).find((n) => n.bounds[0] <= mx && mx <= n.bounds[2] && n.bounds[1] <= my && my <= n.bounds[3])
    console.log(`CAND ${tag} CLOSE matches=${pyRepr(closers.map((n) => `${n.label} id=${n.rid || '-'}`))} at_more_spot=${sameSpot ? pyRepr(`${sameSpot.label} id=${sameSpot.rid || '-'}`) : 'None'}`)
    closers.forEach((n) => console.log(`CAND ${tag} CLOSE ${describe(n)}`))

    let kanji = findLabel(list, KANJI)
    result.expanded = !!kanji
    if (!kanji) {
      console.log(`CAND ${tag} NOT_IN_EXPANDED`)
      const scroller = list.filter((n) => n.scrollable && visible(n)).sort((a, b) => (b.bounds[3] - b.bounds[1]) - (a.bounds[3] - a.bounds[1]))[0]
      if (scroller) {
        phase(`${tag} scrolling ${describe(scroller)}`)
        const [x] = center(scroller)
        await d.swipe(x, scroller.bounds[3] - 60, x, scroller.bounds[1] + 60, 0.5)
        await sleep(1)
        result.scrolled = true
        list = await settled(d, tag, 'expanded-scrolled')
        logList(tag, 'SCROLLED', list)
        kanji = findLabel(list, KANJI)
        result.expanded = !!kanji
        if (!kanji) console.log(`CAND ${tag} NOT_IN_EXPANDED after scroll`)
      } else {
        console.log(`CAND ${tag} NOT_SCROLLABLE`)
      }
    }
    if (kanji) result.committed = await commit(d, tag, kanji, before, result.scrolled ? 'expanded-scrolled' : 'expanded')
    else result.committed = (await state()).text ?? ''
  } catch (error) {
    result.error = errorRepr(error)
    console.log(`CAND ${tag} ERROR ${result.error}`)
    try {
      await save(d, await d.dumpHierarchy(), tag, 'fail')
    } catch (e) {
      phase(`${tag} fail dump failed: ${errorRepr(e)}`)
    }
  } finally {
    result.codepoints = codepoints(result.committed)
    writeFileSync(`${out}/candidates-probe.json`, JSON.stringify(results, null, 2))
  }
}

/** Type a first kyou and press Space, as the crash cases do before their second word. */
async function firstWord(d: Device, rep: number): Promise<void> {
  const tag = `r${rep}w2-prefix`
  const before = (await state()).events.length
  for (const key of 'kyou') await tapKey(d, key)
  const keys = await gboardKeys(d)
  await tapKey(d, keys.has('スペース') ? 'スペース' : 'Space')
  await sleep(1.5)
  const s = await state()
  console.log(`CAND ${tag} SPACE text=${pyRepr(s.text)} codepoints=${codepoints(s.text ?? '').join(',') || '(empty)'} composing=${composing(s.events)} events=${eventsRepr(s.events.slice(before))}`)
  await save(d, await d.dumpHierarchy(), tag, 'after-space')
}

async function repetition(rep: number): Promise<void> {
  if (rep > 1) {
    await adb(['shell', 'am', 'force-stop', CHROME])
    await adb(['shell', 'rm', '-rf', '/data/data/com.android.chrome/app_tabs']).catch(() => '')
  }
  const d = await openKeyboard('plain.html', '', out, `cand-r${rep}`)
  await word(d, rep, 1)
  await clear(d, `r${rep}`)
  try {
    await firstWord(d, rep)
  } catch (error) {
    console.log(`CAND r${rep}w2-prefix ERROR ${errorRepr(error)}`)
  }
  await word(d, rep, 2)
  await clear(d, `r${rep}`)
}

async function main(): Promise<void> {
  out = process.argv[2] ?? 'out'
  mkdirSync(out, {recursive: true})
  watchdog(1080)
  phase('start candidates probe')
  for (let rep = 1; rep <= REPETITIONS; rep++) {
    try {
      await repetition(rep)
    } catch (error) {
      phase(`repetition ${rep} FAILED: ${errorRepr(error)}`)
      for (const n of [1, 2]) if (!results.some((r) => r.rep === rep && r.word === n)) results.push({rep, word: n, strip: false, more: false, expanded: null, scrolled: false, committed: '', codepoints: [], error: errorRepr(error)})
    }
  }
  writeFileSync(`${out}/candidates-probe.json`, JSON.stringify(results, null, 2))
  console.log(`CANDIDATES_SUMMARY ${results.map(summary).join(' ')}`)
}

export function summary(r: WordResult): string {
  const expanded = r.expanded === null ? (r.more ? 'unknown' : 'no_more_button') : r.expanded ? (r.scrolled ? 'yes_after_scroll' : 'yes') : 'no'
  return `r${r.rep}w${r.word}:strip=${r.strip ? 'yes' : 'no'},expanded=${expanded},committed=${pyRepr(r.committed)}[${r.codepoints.join('+')}]${r.error ? ',error' : ''}`
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
