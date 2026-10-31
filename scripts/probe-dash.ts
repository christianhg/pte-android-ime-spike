// Find out which character each dash-like key on Japanese Gboard commits into the plain page.
//
// Walks romaji → アルファベット入力キーボード → 数字キーボード → 記号キーボード, taps every dash-like cell on
// each sub-tab of the rich symbol panel, then long-presses and flicks keys on the 12-key pad and the
// alphabet layout. Every action logs a DASH line with the code points that landed in the field.
//
// Usage: IME_LANG=ja node scripts/probe-dash.ts <outdir>

import {mkdirSync, writeFileSync} from 'node:fs'
import {adb} from './lib/adb.ts'
import {cdpEval} from './lib/cdp.ts'
import {parseXml} from './lib/hierarchy.ts'
import type {Device} from './lib/u2.ts'
import {errorRepr, phase, pyRepr, sleep, watchdog} from './lib/util.ts'
import {openKeyboard} from './drive.ts'

const GBOARD = 'com.google.android.inputmethod.latin'
const ID = `${GBOARD}:id/`

export const DASH = /ダッシュ|ハイフン|マイナス|ハイフンマイナス|長音|波|チルダ|-|－|‐|–|—|―|−/
// The user-facing name of every sub-tab the probe visits. 数記号 is a cell in 一般 on Gboard v15, not a tab,
// so the probe logs when a name is not in the tab strip instead of failing.
const TABS = ['一般', '括弧', '数字', '数学', '矢印', '図形', '数記号']

export type Node = {desc: string; text: string; rid: string; selected: boolean; bounds: [number, number, number, number]}
type PageEvent = {type: string; inputType?: string; data?: string | null}
type PageState = {text: string | null; events: PageEvent[]}
type Layout = 'romaji' | 'alphabet' | 'pad' | 'symbol' | 'unknown'
type Record_ = {layout: string; tab: string; label: string; via: string; codepoints: string[]; text: string; composing: boolean; committed?: string[]; inputTypes: string[]}

const records: Record_[] = []
const tabLabels: Record<string, string[]> = {}
let out = 'out'

export function gboardNodes(xml: string): Node[] {
  const nodes: Node[] = []
  for (const n of parseXml(xml)) {
    if (n.tag !== 'node' || n.attrs.package !== GBOARD) continue
    const b = (n.attrs.bounds ?? '').match(/-?\d+/g)?.map(Number)
    if (!b || b.length !== 4) continue
    nodes.push({desc: n.attrs['content-desc'] ?? '', text: n.attrs.text ?? '', rid: (n.attrs['resource-id'] ?? '').replace(ID, ''), selected: n.attrs.selected === 'true', bounds: b as Node['bounds']})
  }
  return nodes
}

const center = (n: Node): [number, number] => [Math.floor((n.bounds[0] + n.bounds[2]) / 2), Math.floor((n.bounds[1] + n.bounds[3]) / 2)]
const inside = (n: Node, box: Node): boolean => n.bounds[0] >= box.bounds[0] && n.bounds[2] <= box.bounds[2] && n.bounds[1] >= box.bounds[1] && n.bounds[3] <= box.bounds[3]
const height = (n: Node): number => n.bounds[3] - n.bounds[1]
const width = (n: Node): number => n.bounds[2] - n.bounds[0]

export function codepoints(s: string): string[] {
  return [...s].map((c) => 'U+' + c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0'))
}

export function layoutOf(nodes: Node[]): Layout {
  const descs = new Set(nodes.map((n) => n.desc))
  if (descs.has('リッチ記号キーボード') || nodes.some((n) => n.rid === 'expression_view_pager')) return 'symbol'
  if (nodes.some((n) => n.rid.startsWith('key_pos_ja_12keys_'))) return 'pad'
  if (descs.has('長音記号')) return 'romaji'
  if (descs.has('l') || descs.has('L')) return 'alphabet'
  return 'unknown'
}

let dumps = 0
async function dump(d: Device, name?: string): Promise<Node[]> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const xml = await d.dumpHierarchy()
    const nodes = gboardNodes(xml)
    if (name) writeFileSync(`${out}/dash-${String(++dumps).padStart(2, '0')}-${name}.xml`, xml)
    // A dump mid-redraw holds only part of the keyboard. Every whole layout has its delete key.
    if (nodes.some((n) => n.rid === 'key_pos_del')) return nodes
    phase(`dump incomplete, ${nodes.length} Gboard nodes (attempt ${attempt + 1}), retrying`)
    await sleep(1)
  }
  throw new Error('no whole Gboard dump')
}

const find = (nodes: Node[], desc: string): Node | undefined => nodes.find((n) => n.desc === desc && width(n) > 0 && height(n) > 0)

async function state(): Promise<PageState> {
  return (await cdpEval('window.__state()')) as PageState
}

function composing(events: PageEvent[]): boolean {
  const last = events.filter((e) => e.type.startsWith('composition')).at(-1)
  return last !== undefined && last.type !== 'compositionend'
}

/** Empty the field with Gboard's own delete key, so any open composition goes too, then check over CDP. */
async function clear(d: Device): Promise<void> {
  let s = await state()
  if (!s.text) return
  const del = find(await dump(d), '削除') ?? (await dump(d)).find((n) => n.rid === 'key_pos_del')
  for (let i = 0; i < [...s.text].length + 1 && del; i++) {
    await d.click(...center(del))
    await sleep(0.25)
  }
  await sleep(0.4)
  s = await state()
  if (s.text) {
    phase(`delete key left ${pyRepr(s.text)}, clearing over CDP`)
    await cdpEval("(() => { const el = document.getElementById('ed'); el.textContent = ''; const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); })()")
    await sleep(0.5)
  }
}

/** Run one action on a cleared field and log what it put there. A composition is committed with Enter and read again. */
async function probe(d: Device, layout: string, tab: string, label: string, via: string, act: () => Promise<void>): Promise<Record_ | undefined> {
  try {
    await clear(d)
    const before = (await state()).events.length
    await act()
    await sleep(0.8)
    const s = await state()
    const events = s.events.slice(before)
    const text = s.text ?? ''
    const rec: Record_ = {layout, tab, label, via, codepoints: codepoints(text), text, composing: composing(s.events), inputTypes: [...new Set(events.map((e) => e.inputType).filter((t): t is string => !!t))]}
    if (rec.composing) {
      const enter = find(await dump(d), 'Enter')
      if (enter) {
        await d.click(...center(enter))
        await sleep(0.8)
        const after = (await state()).text ?? ''
        rec.committed = codepoints(after)
      }
    }
    records.push(rec)
    const committed = rec.committed ? ` after_enter=${rec.committed.join(',') || '(empty)'}` : ''
    const ascii = rec.codepoints.includes('U+002D') || rec.committed?.includes('U+002D') ? ' HYPHEN-MINUS' : ''
    console.log(`DASH layout=${layout} tab=${tab} label=${pyRepr(label)} via=${via} text=${pyRepr(text)} codepoints=${rec.codepoints.join(',') || '(empty)'} composing=${rec.composing}${committed} inputTypes=${rec.inputTypes.join(',')}${ascii}`)
    writeFileSync(`${out}/dash-probe.json`, JSON.stringify({records, tabLabels}, null, 2))
    await clear(d)
    return rec
  } catch (error) {
    console.log(`DASH layout=${layout} tab=${tab} label=${pyRepr(label)} via=${via} ERROR ${errorRepr(error)}`)
    return undefined
  }
}

/** Tap layout toggles until `target` shows. */
async function goTo(d: Device, target: Layout): Promise<Node[]> {
  for (let i = 0; i < 8; i++) {
    const nodes = await dump(d)
    const now = layoutOf(nodes)
    if (now === target) {
      phase(`on layout ${target}`)
      return nodes
    }
    const next: Record<Layout, string> = {
      symbol: '文字キーボード',
      romaji: 'アルファベット入力キーボード',
      alphabet: '数字キーボード',
      pad: target === 'symbol' ? '記号キーボード' : 'かな入力キーボード',
      unknown: '文字キーボード',
    }
    const key = find(nodes, next[now])
    phase(`layout ${now}, want ${target}, tapping ${pyRepr(next[now])}`)
    if (!key) throw new Error(`no ${next[now]} key on layout ${now}`)
    await d.click(...center(key))
    await sleep(1.2)
  }
  throw new Error(`could not reach layout ${target}`)
}

function header(nodes: Node[]): Node | undefined {
  return nodes.find((n) => n.rid === 'keyboard_expression_header_middle_element_container')
}

function pager(nodes: Node[]): Node | undefined {
  return nodes.find((n) => n.rid === 'expression_view_pager')
}

function tabs(nodes: Node[]): Node[] {
  const h = header(nodes)
  return h ? nodes.filter((n) => n.desc && inside(n, h)) : []
}

/** Symbol cells fully enough on screen to tap. */
function cells(nodes: Node[]): Node[] {
  const p = pager(nodes)
  if (!p) return []
  const full = Math.max(0, ...nodes.filter((n) => n.desc && inside(n, p)).map(height))
  return nodes.filter((n) => n.desc && inside(n, p) && height(n) >= full * 0.6)
}

/** Find a sub-tab in the header strip, scrolling it sideways when it is off screen. */
async function openTab(d: Device, label: string): Promise<Node[] | undefined> {
  for (const dir of [0, -1, -1, 1, 1, 1]) {
    let nodes = await dump(d)
    const h = header(nodes)
    if (dir && h) {
      const y = center(h)[1]
      await d.swipe(dir < 0 ? h.bounds[2] - 40 : h.bounds[0] + 40, y, dir < 0 ? h.bounds[0] + 40 : h.bounds[2] - 40, y, 0.4)
      await sleep(0.8)
      nodes = await dump(d)
    }
    const tab = tabs(nodes).find((n) => n.desc === label && width(n) >= 30)
    if (tab) {
      await d.click(...center(tab))
      await sleep(1.2)
      return nodes
    }
  }
  return undefined
}

/** Tap a symbol cell by label, first returning to the panel and tab when the last tap left them. */
async function tapCell(d: Device, tab: string, label: string): Promise<void> {
  let nodes = await dump(d)
  if (layoutOf(nodes) !== 'symbol') {
    phase(`the last tap left the symbol panel for ${layoutOf(nodes)}, going back`)
    await goTo(d, 'symbol')
    nodes = await dump(d)
  }
  if (tab !== 'first' && tabs(nodes).find((n) => n.selected)?.desc !== tab) {
    await openTab(d, tab)
    nodes = await dump(d)
  }
  const cell = cells(nodes).find((n) => n.desc === label)
  if (!cell) throw new Error(`cell ${label} not on screen in ${tab}`)
  await d.click(...center(cell))
}

async function symbolPanel(d: Device): Promise<void> {
  let nodes = await goTo(d, 'symbol')
  nodes = await dump(d, 'symbol-first')
  await d.screenshot(`${out}/dash-symbol-first`)
  phase(`symbol panel tabs ${pyRepr(tabs(nodes).map((n) => `${n.desc}${n.selected ? '*' : ''}`))}`)

  // Step 1: ダッシュ on the panel as it opens.
  const dash = find(nodes, 'ダッシュ')
  if (dash) await probe(d, 'symbol', 'first', 'ダッシュ', 'tap', () => tapCell(d, 'first', 'ダッシュ'))
  else console.log('DASH layout=symbol tab=first label=ダッシュ MISSING')

  // Collect the whole tab strip, which scrolls sideways.
  const seen = new Set(tabs(nodes).map((n) => n.desc))
  const h = header(nodes)
  if (h) {
    const y = center(h)[1]
    for (let i = 0; i < 3; i++) {
      await d.swipe(h.bounds[2] - 40, y, h.bounds[0] + 40, y, 0.4)
      await sleep(0.8)
      for (const t of tabs(await dump(d))) seen.add(t.desc)
    }
    await dump(d, 'symbol-tabs-scrolled')
  }
  phase(`all sub-tabs ${pyRepr([...seen])}`)
  const visit = [...TABS, ...[...seen].filter((t) => !TABS.includes(t) && t !== '履歴')]

  for (const tab of visit) {
    const opened = await openTab(d, tab)
    if (!opened) {
      console.log(`DASH tab=${tab} NOT_A_TAB, the header strip holds ${pyRepr([...seen])}`)
      continue
    }
    const labels: string[] = []
    const tapped = new Set<string>()
    for (let page = 0; page < 10; page++) {
      nodes = await dump(d, `symbol-${tab}-${page}`)
      const selected = tabs(nodes).find((n) => n.selected)?.desc ?? tab
      let added = 0
      for (const c of cells(nodes)) {
        if (!labels.includes(c.desc)) {
          labels.push(c.desc)
          added += 1
        }
      }
      for (const c of cells(nodes)) {
        if (!DASH.test(c.desc) || tapped.has(c.desc)) continue
        tapped.add(c.desc)
        await probe(d, 'symbol', selected, c.desc, 'tap', () => tapCell(d, tab, c.desc))
      }
      if (page > 0 && added === 0) break
      const p = pager(nodes)
      if (!p) break
      await d.swipe(center(p)[0], p.bounds[3] - 60, center(p)[0], p.bounds[1] + 60, 0.5)
      await sleep(1)
    }
    tabLabels[tab] = labels
    phase(`tab ${tab}: ${labels.length} cells ${pyRepr(labels)}`)
  }

}

/** 一般 holds the ASCII punctuation, so tap every cell there: '-' could sit under a label the pattern misses. */
async function sweep(d: Device): Promise<void> {
  const deadline = Date.now() + 240_000
  await goTo(d, 'symbol')
  let nodes: Node[]
  if (await openTab(d, '一般')) {
    const done = new Set<string>()
    for (let page = 0; page < 10; page++) {
      nodes = await dump(d)
      let added = 0
      for (const c of cells(nodes)) {
        if (done.has(c.desc)) continue
        if (Date.now() > deadline) {
          console.log(`DASH sweep of 一般 stopped at its time budget after ${done.size} cells`)
          return
        }
        done.add(c.desc)
        added += 1
        await probe(d, 'symbol', '一般', c.desc, 'sweep', () => tapCell(d, '一般', c.desc))
      }
      if (page > 0 && added === 0) break
      const p = pager(nodes)
      if (!p) break
      await d.swipe(center(p)[0], p.bounds[3] - 60, center(p)[0], p.bounds[1] + 60, 0.5)
      await sleep(1)
    }
  }
}

async function motion(action: 'DOWN' | 'MOVE' | 'UP', x: number, y: number): Promise<void> {
  await adb(['shell', 'input', 'motionevent', action, String(Math.round(x)), String(Math.round(y))])
}

/** Long-press a key, dump the popup while the finger is down, release in place, then slide to each dash-like candidate. */
async function longPress(d: Device, layout: Layout, label: string): Promise<void> {
  const base = await goTo(d, layout)
  const key = find(base, label)
  if (!key) {
    console.log(`DASH layout=${layout} label=${pyRepr(label)} MISSING`)
    return
  }
  const [x, y] = center(key)
  const before = new Set(base.map((n) => `${n.desc}@${n.bounds.join(',')}`))
  let popup: Node[] = []
  await probe(d, layout, '-', label, 'longpress-release', async () => {
    await motion('DOWN', x, y)
    await sleep(1.2)
    const xml = await d.dumpHierarchy()
    writeFileSync(`${out}/dash-${String(++dumps).padStart(2, '0')}-longpress-${layout}-${label}.xml`, xml)
    await d.screenshot(`${out}/dash-longpress-${layout}-${label}`)
    popup = gboardNodes(xml).filter((n) => (n.desc || n.text) && !before.has(`${n.desc}@${n.bounds.join(',')}`))
    await motion('UP', x, y)
  })
  const names = popup.map((n) => n.desc || n.text)
  console.log(`DASH_POPUP layout=${layout} key=${pyRepr(label)} candidates=${pyRepr(names)} dashlike=${pyRepr(names.filter((n) => DASH.test(n)))}`)
  for (const c of popup) {
    const name = c.desc || c.text
    if (!DASH.test(name)) continue
    const [cx, cy] = center(c)
    await probe(d, layout, '-', `${label} → ${name}`, 'longpress-slide', async () => {
      await motion('DOWN', x, y)
      await sleep(1.2)
      await motion('MOVE', (x + cx) / 2, (y + cy) / 2)
      await motion('MOVE', cx, cy)
      await sleep(0.3)
      await motion('UP', cx, cy)
    })
  }
}

/** Flick a key in each direction, the 12-key pad's way of reaching its other characters. */
async function flicks(d: Device, layout: Layout, label: string): Promise<void> {
  const key = find(await goTo(d, layout), label)
  if (!key) {
    console.log(`DASH layout=${layout} label=${pyRepr(label)} MISSING`)
    return
  }
  const [x, y] = center(key)
  const reach = Math.min(width(key), height(key)) * 0.8
  for (const [dir, dx, dy] of [['up', 0, -1], ['down', 0, 1], ['left', -1, 0], ['right', 1, 0]] as const) {
    await probe(d, layout, '-', label, `flick-${dir}`, async () => {
      await motion('DOWN', x, y)
      await sleep(0.15)
      await motion('MOVE', x + (dx * reach) / 2, y + (dy * reach) / 2)
      await motion('MOVE', x + dx * reach, y + dy * reach)
      await motion('UP', x + dx * reach, y + dy * reach)
    })
  }
}

async function keyLayouts(d: Device): Promise<void> {
  // The romaji layout's own dash key, for comparison: it composes ー, which Enter commits.
  const romaji = await goTo(d, 'romaji')
  await dump(d, 'romaji')
  const choon = find(romaji, '長音記号')
  if (choon) await probe(d, 'romaji', '-', '長音記号', 'tap', () => d.click(...center(choon)))

  for (const k of ['l', 'p']) await longPress(d, 'alphabet', k)
  await goTo(d, 'alphabet')
  const alphabet = await dump(d, 'alphabet')
  for (const n of alphabet.filter((n) => DASH.test(n.desc))) await probe(d, 'alphabet', '-', n.desc, 'tap', () => d.click(...center(n)))

  await goTo(d, 'pad')
  await dump(d, 'pad')
  // 1 and 0 as asked, plus ( and . since the pad's other punctuation hangs off those.
  for (const k of ['1', '0', '(', '.']) {
    await longPress(d, 'pad', k)
    await flicks(d, 'pad', k)
  }
}

async function main(): Promise<void> {
  out = process.argv[2] ?? 'out'
  mkdirSync(out, {recursive: true})
  watchdog(1080)
  phase('start dash probe')
  const d = await openKeyboard('plain.html', '', out, 'dash')
  for (const [name, part] of [['symbol panel', symbolPanel], ['key layouts', keyLayouts], ['general sweep', sweep]] as const) {
    try {
      await part(d)
    } catch (error) {
      phase(`${name} FAILED: ${errorRepr(error)}`)
      writeFileSync(`${out}/dash-fail-${name.replace(' ', '-')}.xml`, await d.dumpHierarchy())
      await d.screenshot(`${out}/dash-fail-${name.replace(' ', '-')}`)
    }
  }
  writeFileSync(`${out}/dash-probe.json`, JSON.stringify({records, tabLabels}, null, 2))
  const hits = records.filter((r) => r.codepoints.includes('U+002D') || r.committed?.includes('U+002D'))
  console.log(`DASH_SUMMARY records=${records.length} hyphen_minus=${pyRepr(hits.map((r) => `${r.layout}/${r.tab}/${r.label}/${r.via}`))}`)
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
