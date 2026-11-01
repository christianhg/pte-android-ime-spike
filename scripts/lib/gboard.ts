// What the probe needs to know about Gboard: the languages it adds, how to find a key by role in an
// accessibility dump, which layout is showing, and how page coordinates map onto the screen. All pure, so
// the tests can run it against dumps from CI.

import {center, parseBounds, parseXml, type Bounds} from './hierarchy.ts'

export const GBOARD = 'com.google.android.inputmethod.latin'

export type Lang = {
  code: string
  /** Typed into the Add keyboard search with adb `input text`, so ASCII. */
  search: string
  /**
   * Rows to tap in the language list, best first. The same patterns pick the variant on the page some
   * languages open next (Arabic lists its regions, Hindi lists Hinglish and हिन्दी (भारत)).
   */
  rows: RegExp[]
  /** The layout tile to leave as the only one selected. Undefined keeps Gboard's default. */
  layout?: RegExp
  /** Keys to tap for the probe word, in order. */
  keys: string[]
  /**
   * Characters without a key of their own, reached by long-pressing the key named here. The popup is not
   * in the accessibility tree, so the probe holds and releases in place, taking the preselected entry.
   */
  longPress?: Record<string, string>
  /** How the word is committed before Space: Space alone, or the first candidate first. */
  commit: 'space' | 'candidate'
  expect: string
}

export const LANGS: Record<string, Lang> = {
  en: {code: 'en', search: 'English', rows: [/^English \(US\)$/], keys: [...'kyou'], commit: 'space', expect: 'kyou'},
  ko: {
    code: 'ko',
    search: 'Korean',
    rows: [/^(Korean|한국어)$/],
    layout: /2.?(set|bulsik|벌식)|dubeolsik|두벌식/i,
    keys: ['ㅎ', 'ㅏ', 'ㄴ', 'ㄱ', 'ㅜ', 'ㄱ'],
    commit: 'space',
    expect: '한국',
  },
  zh: {
    code: 'zh',
    search: 'Chinese',
    rows: [/^(Chinese.*Simplified|中文.*简体|简体中文)/i],
    // Run 1 showed the tiles 拼音[x] | 9 键 | 手写: 拼音 is the full Pinyin QWERTY layout.
    layout: /^(拼音|pinyin)( qwerty| 全键盘)?$/i,
    keys: [...'nihao'],
    commit: 'candidate',
    expect: '你好',
  },
  hi: {
    code: 'hi',
    search: 'Hindi',
    // हिन्दी opens a page with Hinglish and हिन्दी (भारत). The second is the Devanagari keyboard.
    rows: [/^हिन्दी \(भारत\)$/, /^Hindi \(India\)$/, /^(Hindi|हिन्दी|हिंदी)$/],
    layout: /devanagari|^(हिन्दी|हिंदी)$/i,
    keys: ['न', 'म', 'स', '्', 'त', 'े'],
    commit: 'space',
    expect: 'नमस्ते',
  },
  // العربية opens a page of regional variants. Run 1 listed (مصر), (المملكة العربية السعودية) and others.
  ar: {
    code: 'ar',
    search: 'Arabic',
    rows: [/^العربية \(مصر\)$/, /^العربية \(المملكة العربية السعودية\)$/, /^العربية( \(.+\))?$/, /^Arabic( \(.+\))?$/], keys: [...'مرحبا'], commit: 'space', expect: 'مرحبا'},
  he: {code: 'he', search: 'Hebrew', rows: [/^(Hebrew|עברית)( \(.+\))?$/], keys: [...'שלום'], commit: 'space', expect: 'שלום'},
  th: {code: 'th', search: 'Thai', rows: [/^(Thai|ไทย)$/], keys: [...'สวัสดี'], commit: 'space', expect: 'สวัสดี'},
  vi: {code: 'vi', search: 'Vietnamese', rows: [/^(Vietnamese|Tiếng Việt)( \(.+\))?$/], layout: /telex/i, keys: [...'tieengs'], commit: 'space', expect: 'tiếng'},
  de: {code: 'de', search: 'German', rows: [/^(German|Deutsch) \((Germany|Deutschland)\)$/, /^(German|Deutsch)$/], layout: /^QWERTZ$/i, keys: [...'für'], longPress: {ü: 'u'}, commit: 'space', expect: 'für'},
}

export type GNode = {label: string; desc: string; text: string; id: string; bounds: Bounds; x: number; y: number}

/** Every Gboard node with a content-desc or text, in document order. */
export function gboardNodes(xml: string): GNode[] {
  const nodes: GNode[] = []
  for (const n of parseXml(xml)) {
    if (n.tag !== 'node' || n.attrs.package !== GBOARD) continue
    const desc = n.attrs['content-desc'] ?? ''
    const text = n.attrs.text ?? ''
    if (!desc && !text) continue
    const bounds = parseBounds(n.attrs.bounds!)
    const [x, y] = center(bounds)
    nodes.push({label: desc || text, desc, text, id: (n.attrs['resource-id'] ?? '').replace(`${GBOARD}:id/`, ''), bounds, x, y})
  }
  return nodes
}

export type Role = 'space' | 'delete' | 'enter' | 'shift' | 'language' | 'emoji' | 'letters' | 'symbols'

const ROLE_IDS: Partial<Record<Role, string[]>> = {
  space: ['key_pos_space'],
  delete: ['key_pos_del'],
  enter: ['key_pos_ime_action'],
  shift: ['key_pos_shift'],
  // switch_to_next_language is the emoji key on a one-language keyboard, which roleKey filters out by label.
  language: ['key_pos_qwerty_globe', 'key_pos_switch_to_next_language'],
  symbols: ['key_pos_switch_to_symbol'],
}

// Labels in English and in the languages whose layouts localise them (ja and zh seen so far).
const ROLE_LABELS: Record<Role, RegExp> = {
  space: /^(space|スペース|空格|空白)$/i,
  delete: /^(delete|backspace|削除|删除)$/i,
  enter: /^(enter|done|go|search|next|send|return)$/i,
  shift: /^shift/i,
  language: /^(next language|switch to|globe|次の言語|下一种语言|切换语言)/i,
  emoji: /emoji|絵文字|表情/i,
  letters: /^(abc|back to keyboard|letters|alphabet|返回键盘|キーボードに戻る)/i,
  symbols: /^(symbol keyboard|symbols|\?123)$/i,
}

/** The key that plays `role`, by resource id first and label second. */
export function roleKey(nodes: GNode[], role: Role): GNode | undefined {
  const ids = ROLE_IDS[role] ?? []
  // The bottom-row slot left of Space holds the emoji key on a one-language keyboard and the globe key
  // otherwise, so a key found by id still has to pass the emoji label check.
  return nodes.find((n) => ids.includes(n.id) && !ROLE_LABELS.emoji.test(n.label)) ?? nodes.find((n) => ROLE_LABELS[role].test(n.label))
}

// Gboard's Korean 2-set keys are named, not lettered (round 3, keyboard-ko.xml): consonants by their
// jamo name (히읗 for ㅎ, 쌍비읍 for ㅃ on the shift layer), vowels by the syllable ㅇ + vowel (아 for ㅏ).
const JAMO_NAMES: Record<string, string> = {
  기역: 'ㄱ', 쌍기역: 'ㄲ', 니은: 'ㄴ', 디귿: 'ㄷ', 쌍디귿: 'ㄸ', 리을: 'ㄹ', 미음: 'ㅁ', 비읍: 'ㅂ', 쌍비읍: 'ㅃ',
  시옷: 'ㅅ', 쌍시옷: 'ㅆ', 이응: 'ㅇ', 지읒: 'ㅈ', 쌍지읒: 'ㅉ', 치읓: 'ㅊ', 키읔: 'ㅋ', 티읕: 'ㅌ', 피읖: 'ㅍ', 히읗: 'ㅎ',
}
const VOWELS = 'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ'

/** The compatibility jamo a Korean key label stands for, or the label as it is. */
function jamoOf(label: string): string {
  if (JAMO_NAMES[label]) return JAMO_NAMES[label]!
  // A lone syllable ㅇ + vowel, no final consonant: 아 is U+C544, each vowel steps 28 code points.
  const cp = label.length === 1 ? label.codePointAt(0)! - 0xc544 : -1
  if (cp >= 0 && cp % 28 === 0 && cp / 28 < VOWELS.length) return VOWELS[cp / 28]!
  return label
}

/**
 * What a key label types once Gboard's decoration is gone: surrounding space (Thai marks read " ั"), the
 * dotted circle (◌ั), joiners and the invisible padding Gboard puts on Hindi keys ("स‌‌‌"), and Korean names.
 */
export function keyText(label: string): string {
  return jamoOf(label.replace(/[\u25cc\u200c\u200d]/g, '').trim()).normalize('NFC')
}

const COMBINING = /^\p{M}+$/u

/**
 * The key that types `ch`. Latin keys may be either case. Gboard's Hindi keys preview a mark joined to the
 * syllable before it: after स the virama key reads "स्" + ZWJ (round 3), and after the conjunct स्त the
 * e-matra key reads "स्ते" (round 4). So a combining mark also matches any short tail of `typed`, the text
 * typed so far, followed by the mark.
 */
export function charKey(nodes: GNode[], ch: string, typed = ''): GNode | undefined {
  const wanted = new Set([ch, ch.toUpperCase(), ch.toLowerCase()].map((c) => c.normalize('NFC')))
  if (COMBINING.test(ch)) {
    const tail = [...typed]
    for (let n = 1; n <= Math.min(4, tail.length); n++) wanted.add((tail.slice(-n).join('') + ch).normalize('NFC'))
  }
  // Keys first: once typing starts, the suggestion strip above them can hold the same character.
  const isKey = (n: GNode) => n.id.startsWith('key_pos_') && !n.id.startsWith('key_pos_header')
  for (const pool of [nodes.filter(isKey), nodes]) {
    for (const field of ['desc', 'text'] as const) {
      const hit = pool.find((n) => n[field] && wanted.has(keyText(n[field])))
      if (hit) return hit
    }
  }
  return undefined
}

const SCRIPTS: Array<[string, RegExp]> = [
  ['ko', /[\u1100-\u11ff\u3131-\u318e\uac00-\ud7a3]/],
  ['hi', /[\u0900-\u097f]/],
  ['ar', /[\u0600-\u06ff]/],
  ['he', /[\u0590-\u05ff]/],
  ['th', /[\u0e00-\u0e7f]/],
  // Kana before Han: the Japanese layout labels keys with both (削除, スペース).
  ['ja', /[\u3040-\u30ff]/],
  ['zh', /[\u4e00-\u9fff]/],
]

/**
 * Which layout the keys belong to, judged by their labels. Latin layouts other than QWERTZ look alike in a
 * dump unless Gboard localises the header, so plain QWERTY comes back as 'latin' and the caller decides
 * between en and vi.
 */
export function classifyLayout(nodes: GNode[]): string {
  const keys = nodes.filter((n) => n.id.startsWith('key_pos_'))
  if (!keys.length) return 'none'
  const labels = keys.map((n) => n.label)
  for (const [code, re] of SCRIPTS) if (labels.some((l) => re.test(l))) return code
  if (/^z$/i.test(keys.find((n) => n.id === 'key_pos_0_5')?.label ?? '') || labels.some((l) => /^[\u00e4\u00f6\u00fc\u00df]$/i.test(l))) return 'de'
  if (labels.some((l) => /[\u0103\u00e2\u0111\u00ea\u00f4\u01a1\u01b0]/i.test(l))) return 'vi'
  return 'latin'
}

/** The first conversion candidate: a Han label above the top key row, leftmost first. */
export function firstCandidate(nodes: GNode[]): GNode | undefined {
  const rowTop = Math.min(...nodes.filter((n) => /^key_pos_0_\d+$/.test(n.id)).map((n) => n.bounds.top))
  return nodes
    .filter((n) => /^[\u4e00-\u9fff]{1,8}$/.test(n.label) && n.bounds.bottom <= rowTop && !n.id.startsWith('key_pos_header'))
    .sort((a, b) => a.y - b.y || a.x - b.x)[0]
}

const PICTOGRAPH = /\p{Extended_Pictographic}/u
const FLAG = /[\u{1f1e6}-\u{1f1ff}]{2}/u

// The dump turns every character outside the Basic Multilingual Plane into '.', so most emoji cells read
// ".." (round 3: 43 to 52 such cells in each open panel). BMP ones like ☺️ survive, and so do the joiner
// and BMP parts of a ZWJ sequence ("..\u200d↕️").
const MANGLED = /^\.+$/

// Flags are pairs of regional indicators, which are not Extended_Pictographic. Some builds name cells.
const isEmojiCell = (n: GNode) => !n.id.startsWith('key_pos_') && (MANGLED.test(n.label) || PICTOGRAPH.test(n.label) || FLAG.test(n.label) || /^(flag|family)\b/i.test(n.label) || n.label.includes('\u200d'))

/**
 * Whether Gboard's emoji panel is up. Its labels are localised (그림 이모티콘 키보드 숨기기, ซ่อน แป้นพิมพ์อีโมจิ,
 * 隐藏表情符号键盘 ...), so go by its grid instead: several emoji cells that are not keys. The suggestion
 * strip can hold one or two emoji, never a grid.
 */
export function emojiPanelOpen(nodes: GNode[]): boolean {
  return nodes.filter(isEmojiCell).length >= 8
}

/**
 * The emoji to tap in an open panel: a ZWJ sequence or a flag when one is readable, else any readable
 * emoji, else a mangled cell, which still types its real emoji (the page reads it back over CDP).
 */
export function pickEmoji(nodes: GNode[]): GNode | undefined {
  if (!emojiPanelOpen(nodes)) return undefined
  const cells = nodes.filter(isEmojiCell)
  return (
    cells.find((n) => n.label.includes('\u200d') || FLAG.test(n.label)) ??
    cells.find((n) => /^(flag\b|family\b)/i.test(n.label)) ??
    cells.find((n) => PICTOGRAPH.test(n.label) && [...new Intl.Segmenter().segment(n.label)].length === 1) ??
    cells.find((n) => MANGLED.test(n.label))
  )
}

/** Texts on screen that speak of a language pack download or install. */
export function downloadStates(xml: string): string[] {
  const texts = new Set<string>()
  for (const n of parseXml(xml)) {
    const t = n.attrs.text ?? ''
    if (/download|install|update|\d+\s?%/i.test(t) && t.length < 120) texts.add(t)
  }
  return [...texts]
}

/** Subtype ids listed for `ime` in the secure setting enabled_input_methods ("ime;id;id:other;id"). */
export function enabledSubtypes(setting: string, ime: string): string[] {
  for (const entry of setting.trim().split(':')) {
    const [id, ...subtypes] = entry.split(';')
    if (id === ime) return subtypes.filter(Boolean)
  }
  return []
}

/** Name and locale tokens of the subtypes in `dumpsys input_method`, as setup-ja logs them. */
export function subtypeTokens(dump: string): string[] {
  return [...new Set(dump.match(/mSubtypeName=[^ }]+|(?:mSubtypeLanguageTag|mSubtypeLocale|locale)=[\p{L}\p{N}\p{Mn}\p{Pc}-]+/gu) ?? [])].sort()
}

export type Viewport = {dpr: number; offsetLeft: number; offsetTop: number; scale: number}

/** Where the page's CSS (0, 0) sits on screen, in screen pixels. */
export type Origin = {left: number; top: number}

/**
 * Screen pixels for a point in CSS pixels of the layout viewport. The visual viewport says how far the page
 * is panned and zoomed, which moves when Gboard opens and Chrome scrolls the caret into view.
 */
export function cssToScreen(x: number, y: number, origin: Origin, vp: Viewport): [number, number] {
  const k = vp.dpr * vp.scale
  return [Math.round(origin.left + (x - vp.offsetLeft) * k), Math.round(origin.top + (y - vp.offsetTop) * k)]
}

/**
 * The content origin from a calibration tap: the screen pixel the driver tapped, less where the page saw
 * the pointer land (clientX/Y, already relative to the visual viewport's pan, times its zoom).
 */
export function originFromTap(screen: [number, number], client: {x: number; y: number}, vp: Viewport): Origin {
  const k = vp.dpr * vp.scale
  return {left: Math.round(screen[0] - client.x * k), top: Math.round(screen[1] - client.y * k)}
}

// Chrome's top toolbar is 56dp. Round 1 and 2 dumps on the pixel_6 (dpr 2.625) put it at 128..275.
const TOOLBAR_DP = 56

/**
 * The content origin from a dump, before any tap, and where it came from. Chrome's WebView node is exact
 * but missing whenever something covers the page (round 1's notifications promo, round 2's open omnibox).
 * Next best is the bottom of Chrome's toolbar, then the status bar plus a 56dp toolbar. Round 2 estimated
 * from outerHeight - innerHeight, which is 0 in Chrome on Android, so it put the origin at the status bar
 * (128 instead of 275), 147px too high.
 */
export function originFromScreen(xml: string, dpr: number): {origin: Origin; source: 'webview' | 'toolbar' | 'statusbar'} {
  const nodes = parseXml(xml)
  const webView = nodes.find((n) => n.attrs.class === 'android.webkit.WebView' && n.attrs.package === 'com.android.chrome')
  if (webView) {
    const b = parseBounds(webView.attrs.bounds!)
    return {origin: {left: b.left, top: b.top}, source: 'webview'}
  }
  const toolbar = nodes.find((n) => n.attrs['resource-id'] === 'com.android.chrome:id/toolbar')
  if (toolbar) return {origin: {left: 0, top: parseBounds(toolbar.attrs.bounds!).bottom}, source: 'toolbar'}
  return {origin: {left: 0, top: Math.round((statusBarHeight(xml) ?? 0) + TOOLBAR_DP * dpr)}, source: 'statusbar'}
}

/**
 * Whether Chrome's omnibox is open over the page. A tap that lands in the toolbar opens it, Gboard then
 * types into the URL bar, and the page and its editor sit behind the suggestion list (round 2, after
 * every Chrome relaunch).
 */
export function omniboxOpen(xml: string): boolean {
  return parseXml(xml).some((n) => n.attrs['resource-id'] === 'com.android.chrome:id/omnibox_results_container')
}

/** Height of the status bar in screen pixels, from a dump's systemui status bar node. */
export function statusBarHeight(xml: string): number | undefined {
  const node = parseXml(xml).find((n) => n.attrs.package === 'com.android.systemui' && /status_bar(_container)?$/.test(n.attrs['resource-id'] ?? ''))
  if (node) return parseBounds(node.attrs.bounds!).bottom
  // Some images name it differently. The first full-width systemui strip from the top serves.
  const strip = parseXml(xml).find((n) => n.attrs.package === 'com.android.systemui' && parseBounds(n.attrs.bounds ?? '[0,0][0,0]').top === 0)
  return strip ? parseBounds(strip.attrs.bounds!).bottom : undefined
}

/**
 * The language tag (or locale) of the subtype whose hash code is `hash`, from `dumpsys input_method`.
 * `settings get secure selected_input_method_subtype` gives the hash of the active subtype.
 */
export function subtypeLocale(dump: string, hash: string): string | undefined {
  if (!/^-?\d+$/.test(hash.trim())) return undefined
  for (const line of dump.split('\n')) {
    if (!new RegExp(`mSubtypeHashCode=${hash.trim()}(\\s|$)`).test(line)) continue
    const tag = /mSubtypeLanguageTag=([\w-]+)/.exec(line)?.[1]
    const locale = /mSubtypeLocale=([\w-]+)/.exec(line)?.[1]
    return tag && tag !== 'und' ? tag : locale
  }
  return undefined
}

// Android still reports Hebrew under its old code.
const ALIASES: Record<string, string[]> = {he: ['he', 'iw']}

export function localeMatches(locale: string, code: string): boolean {
  return (ALIASES[code] ?? [code]).includes(locale.split(/[-_]/)[0]!.toLowerCase())
}

/**
 * Whether the keyboard shows `target`. The active subtype decides when it is known, but keys in another
 * script, or QWERTZ, overrule it, since the subtype setting can lag a switch. Without a subtype, only the keys count,
 * which cannot tell English from the other Latin layouts.
 */
export function onLayout(target: string, locale: string | undefined, layout: string): boolean {
  const scriptKnown = layout !== 'latin' && layout !== 'none'
  if (locale !== undefined) return localeMatches(locale, target) && (!scriptKnown || layout === target)
  return target === 'en' ? layout === 'latin' : layout === target
}

/** The first row matching the best pattern that matches any row, so pattern order sets the priority. */
export function pickRow<T extends {text: string}>(rows: T[], patterns: RegExp[]): T | undefined {
  for (const p of patterns) {
    const hit = rows.find((r) => p.test(r.text))
    if (hit) return hit
  }
  return undefined
}

export type Tile = {desc: string; selected: boolean; x: number; y: number}

/**
 * The layout tiles on a language's layout page, from Gboard's content-desc nodes. The page title (the
 * language name) and Navigate up come first and are not tiles, and a title can read like a layout name
 * (हिन्दी), so only what follows Navigate up counts. Empty when the screen is not a layout page.
 */
export function layoutTiles(xml: string): Tile[] {
  const all = parseXml(xml)
    .filter((n) => n.attrs.package === GBOARD && n.attrs['content-desc'])
    .map((n) => {
      const [x, y] = center(parseBounds(n.attrs.bounds!))
      return {desc: n.attrs['content-desc']!, selected: n.attrs.selected === 'true', x, y}
    })
  const up = all.findIndex((t) => t.desc === 'Navigate up')
  return up < 0 ? [] : all.slice(up + 1)
}

export const LATIN_IME = `${GBOARD}/com.android.inputmethod.latin.LatinIME`

/** Each enabled Gboard subtype hash with its language tag, from the enabled setting and dumpsys. */
export function enabledLocales(enabledSetting: string, dump: string): Array<{hash: string; locale: string | undefined}> {
  return enabledSubtypes(enabledSetting, LATIN_IME).map((hash) => ({hash, locale: subtypeLocale(dump, hash)}))
}

/** `SUBTYPES <hash>=<tag> ...`, the line setup-lang logs and probe reads back. */
export function subtypesLine(subtypes: Array<{hash: string; locale: string | undefined}>): string {
  return `SUBTYPES ${subtypes.map((s) => `${s.hash}=${s.locale ?? '?'}`).join(' ')}`
}

/** The hash of the enabled subtype for `code` from a setup log's SUBTYPES line, if it has one. */
export function subtypeHashFromLog(log: string, code: string): string | undefined {
  const line = /SUBTYPES ((?:-?\d+=\S+ ?)*)/.exec(log)?.[1] ?? ''
  for (const pair of line.trim().split(/\s+/)) {
    const [hash, locale] = pair.split('=')
    if (hash && locale && locale !== '?' && localeMatches(locale, code)) return hash
  }
  return undefined
}

/** The focused field's inputType from `dumpsys input_method` (curEditorInfo), undefined without one. */
export function currentInputType(dump: string): number | undefined {
  const m = /curEditorInfo:\s*\n\s*inputType=0x([0-9a-f]+)/i.exec(dump)
  return m ? parseInt(m[1]!, 16) : undefined
}

/** A text field with the URI variation, as Chrome's URL bar reports itself (0x80011 in round 2). */
export function isUrlField(inputType: number | undefined): boolean {
  return inputType !== undefined && (inputType & 0xf) === 1 && (inputType & 0xff0) === 0x10
}

/**
 * Where to swipe a settings list without touching the keyboard: from just above Gboard's window (or 85% of
 * the screen when it is hidden) up to 30% of the way down from the list's top, in screen pixels.
 */
export function scrollBand(xml: string, screenHeight: number): {top: number; bottom: number} {
  const list = parseXml(xml).find((n) => n.attrs.scrollable === 'true' && n.attrs['resource-id'] !== '')
  const listTop = list ? parseBounds(list.attrs.bounds!).top : screenHeight * 0.15
  const top = keyboardTop(xml)
  const bottom = top !== undefined ? top - 60 : screenHeight * 0.85
  return {top: Math.round(listTop + (bottom - listTop) * 0.3), bottom: Math.round(bottom)}
}

/** The top of Gboard's keys on screen, or undefined when the keyboard is hidden. */
export function keyboardTop(xml: string): number | undefined {
  const tops = parseXml(xml)
    .filter((n) => n.attrs.package === GBOARD && /key_pos_/.test(n.attrs['resource-id'] ?? ''))
    .map((n) => parseBounds(n.attrs.bounds!).top)
  return tops.length ? Math.min(...tops) : undefined
}

/**
 * Language list rows a tap can reach: the android:id/title rows whose centre sits above the keyboard.
 * Round 4 scrolled the Arabic row into view under the search keyboard, tapped it, hit Gboard instead, and
 * the query became "Arabic word".
 */
export function reachableRows(xml: string): Array<{text: string; x: number; y: number}> {
  const top = keyboardTop(xml) ?? Infinity
  return parseXml(xml)
    .filter((n) => n.attrs['resource-id'] === 'android:id/title' && n.attrs.text)
    .map((n) => {
      const [x, y] = center(parseBounds(n.attrs.bounds!))
      return {text: n.attrs.text!, x, y}
    })
    .filter((r) => r.y < top - 20)
}

/**
 * The language search field's text, or undefined when the screen has none. The search screens have one
 * (search_src_text or an EditText), a language's variant page does not.
 */
export function searchQuery(xml: string): string | undefined {
  const field = parseXml(xml).find((n) => n.attrs['resource-id'] === `${GBOARD}:id/search_src_text` || (n.attrs.class === 'android.widget.EditText' && n.attrs.package === GBOARD))
  return field ? (field.attrs.text ?? '') : undefined
}

/**
 * Whether Gboard's language picker (Change keyboard, เปลี่ยนแป้นพิมพ์, ...) is open. A touch on Space that does
 * not move before the long-press timeout opens it, and a space bar drag then never starts (round 4: all 7
 * drags that moved 0). The picker lists the enabled keyboards, English (US) among them in every probe job,
 * as plain text nodes, which keys never are.
 */
export function languagePickerOpen(xml: string): boolean {
  return parseXml(xml).some((n) => n.attrs.package === GBOARD && n.attrs.text === 'English (US)')
}

export type KeyboardDump = {state: 'ok'; nodes: GNode[]} | {state: 'empty' | 'unreadable'; nodes: []; why: string}

/**
 * Read a hierarchy dump for Gboard's nodes, telling an empty or unreadable dump apart from a keyboard that
 * is there. Round 5 de-2 reported "no key for 'f'; labels []" from a dump holding only Chrome and the
 * status bar: the keyboard was not in the hierarchy, which is a different failure from a missing key.
 */
export function readKeyboard(xml: string): KeyboardDump {
  let nodes: GNode[]
  try {
    nodes = gboardNodes(xml)
  } catch (error) {
    return {state: 'unreadable', nodes: [], why: error instanceof Error ? error.message : String(error)}
  }
  if (!nodes.length) return {state: 'empty', nodes: [], why: 'no Gboard nodes in the hierarchy'}
  return {state: 'ok', nodes}
}

/**
 * Why `ch` cannot be typed from this dump: the keyboard is not in it at all, or it is there without the
 * key. The probe retries an empty dump before it gives up, and uses this for the message it fails with.
 */
export function keyLookupFailure(xml: string, ch: string): string {
  const dump = readKeyboard(xml)
  if (dump.state !== 'ok') return `keyboard hierarchy empty: ${dump.why}`
  return `no key for ${JSON.stringify(ch)}; labels ${JSON.stringify(dump.nodes.map((n) => n.label).slice(0, 80))}`
}
