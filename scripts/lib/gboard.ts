// What the probe needs to know about Gboard: the languages it adds, how to find a key by role in an
// accessibility dump, which layout is showing, and how page coordinates map onto the screen. All pure, so
// the tests can run it against dumps from CI.

import {center, parseBounds, parseXml, type Bounds} from './hierarchy.ts'

export const GBOARD = 'com.google.android.inputmethod.latin'

export type Lang = {
  code: string
  /** Typed into the Add keyboard search with adb `input text`, so ASCII. */
  search: string
  /** The result row in the language list. */
  row: RegExp
  /** The layout tile to leave as the only one selected. Undefined keeps Gboard's default. */
  layout?: RegExp
  /** Keys to tap for the probe word, in order. */
  keys: string[]
  /** Characters without a key of their own, reached by long-pressing the key named here. */
  longPress?: Record<string, string>
  /** How the word is committed before Space: Space alone, or the first candidate first. */
  commit: 'space' | 'candidate'
  expect: string
}

export const LANGS: Record<string, Lang> = {
  en: {code: 'en', search: 'English', row: /^English \(US\)$/, keys: [...'kyou'], commit: 'space', expect: 'kyou'},
  ko: {
    code: 'ko',
    search: 'Korean',
    row: /^(Korean|한국어)$/,
    layout: /2.?(set|bulsik|벌식)|dubeolsik|두벌식/i,
    keys: ['ㅎ', 'ㅏ', 'ㄴ', 'ㄱ', 'ㅜ', 'ㄱ'],
    commit: 'space',
    expect: '한국',
  },
  zh: {
    code: 'zh',
    search: 'Chinese',
    row: /^(Chinese.*Simplified|中文.*简体|简体中文)/i,
    layout: /pinyin.*(qwerty|全键)|拼音.*全键|全键盘/i,
    keys: [...'nihao'],
    commit: 'candidate',
    expect: '你好',
  },
  hi: {
    code: 'hi',
    search: 'Hindi',
    row: /^(Hindi|हिन्दी|हिंदी)$/,
    layout: /devanagari|^हिन्दी$|^हिंदी$/i,
    keys: ['न', 'म', 'स', '्', 'त', 'े'],
    commit: 'space',
    expect: 'नमस्ते',
  },
  ar: {code: 'ar', search: 'Arabic', row: /^(Arabic|العربية)$/, keys: [...'مرحبا'], commit: 'space', expect: 'مرحبا'},
  he: {code: 'he', search: 'Hebrew', row: /^(Hebrew|עברית)$/, keys: [...'שלום'], commit: 'space', expect: 'שלום'},
  th: {code: 'th', search: 'Thai', row: /^(Thai|ไทย)$/, keys: [...'สวัสดี'], commit: 'space', expect: 'สวัสดี'},
  vi: {code: 'vi', search: 'Vietnamese', row: /^(Vietnamese|Tiếng Việt)$/, layout: /telex/i, keys: [...'tieengs'], commit: 'space', expect: 'tiếng'},
  de: {code: 'de', search: 'German', row: /^(German|Deutsch)( \(Germany\)| \(Deutschland\))?$/, layout: /^QWERTZ$/i, keys: [...'für'], longPress: {ü: 'u'}, commit: 'space', expect: 'für'},
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

export type Role = 'space' | 'delete' | 'enter' | 'shift' | 'language' | 'emoji' | 'letters'

const ROLE_IDS: Partial<Record<Role, string[]>> = {
  space: ['key_pos_space'],
  delete: ['key_pos_del'],
  enter: ['key_pos_ime_action'],
  shift: ['key_pos_shift'],
  language: ['key_pos_qwerty_globe'],
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
}

/** The key that plays `role`, by resource id first and label second. */
export function roleKey(nodes: GNode[], role: Role): GNode | undefined {
  const ids = ROLE_IDS[role] ?? []
  // The bottom-row slot left of Space holds the emoji key on a one-language keyboard and the globe key
  // otherwise, so that slot's id says nothing. Go by label there.
  return nodes.find((n) => ids.includes(n.id) && !ROLE_LABELS.emoji.test(n.label)) ?? nodes.find((n) => ROLE_LABELS[role].test(n.label))
}

/** The key that types `ch`. Combining marks may carry a dotted circle (◌ั), and Latin keys may be either case. */
export function charKey(nodes: GNode[], ch: string): GNode | undefined {
  const wanted = new Set([ch, ch.toUpperCase(), ch.toLowerCase()].map((c) => c.normalize('NFC')))
  // Keys first: once typing starts, the suggestion strip above them can hold the same character.
  const isKey = (n: GNode) => n.id.startsWith('key_pos_') && !n.id.startsWith('key_pos_header')
  for (const pool of [nodes.filter(isKey), nodes]) {
    for (const field of ['desc', 'text'] as const) {
      const hit = pool.find((n) => n[field] && wanted.has(n[field].replaceAll('\u25cc', '').normalize('NFC')))
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

/**
 * The emoji to tap: a ZWJ sequence or a flag when the panel shows one, any emoji otherwise. Gboard names
 * the cells either by the emoji itself or by its name, so names count too.
 */
export function pickEmoji(nodes: GNode[]): GNode | undefined {
  const cells = nodes.filter((n) => !n.id.startsWith('key_pos_'))
  return (
    cells.find((n) => n.label.includes('\u200d') || FLAG.test(n.label)) ??
    cells.find((n) => /^(flag\b|family\b)/i.test(n.label)) ??
    cells.find((n) => PICTOGRAPH.test(n.label) && [...new Intl.Segmenter().segment(n.label)].length === 1)
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

/**
 * Screen pixels for a point in CSS pixels of the layout viewport. The WebView node's bounds give the
 * content origin on screen, and the visual viewport says how far the page is panned and zoomed within it.
 */
export function cssToScreen(x: number, y: number, webView: Bounds, vp: Viewport): [number, number] {
  const k = vp.dpr * vp.scale
  return [Math.round(webView.left + (x - vp.offsetLeft) * k), Math.round(webView.top + (y - vp.offsetTop) * k)]
}

/** Bounds of Chrome's WebView, where the page content starts on screen. */
export function webViewBounds(xml: string): Bounds | undefined {
  const node = parseXml(xml).find((n) => n.attrs.class === 'android.webkit.WebView' && n.attrs.package === 'com.android.chrome')
  return node ? parseBounds(node.attrs.bounds!) : undefined
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
