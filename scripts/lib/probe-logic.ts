// The probe's judgements, kept apart from the device calls so the tests can run them: what an action's
// event log shows, how far a space bar drag moves the caret, and what the shell says about Chrome.

export type PageEvent = {type: string; inputType?: string; data?: string | null}
export type Selection = {inEditor: boolean; anchor?: number; focus?: number; selected?: string; collapsed?: boolean}
export type Step = {step: string; text: string | null; dom: string | null; selection: Selection; events: PageEvent[]; [key: string]: unknown}

export type Evidence = {
  /** Event types in the order they first appeared during the action, e.g. beforeinput:insertText. */
  eventTypes: string[]
  /** How many of each, keyed like eventTypes. */
  eventCounts: Record<string, number>
  composition: boolean
  selectionBefore: Selection | null
  selectionAfter: Selection | null
  textBefore: string | null
  textAfter: string | null
}

/** beforeinput and input carry their inputType, composition events their bare type. */
export function eventKey(e: PageEvent): string {
  return e.inputType ? `${e.type}:${e.inputType}` : e.type
}

/**
 * What an action did, from its recorded steps. The page's event log only grows, so the events after the
 * first step are the action's own.
 */
export function evidence(steps: Step[]): Evidence {
  const first = steps[0]
  const last = steps.at(-1)
  const own = last ? last.events.slice(first?.events.length ?? 0) : []
  const eventCounts: Record<string, number> = {}
  for (const e of own) eventCounts[eventKey(e)] = (eventCounts[eventKey(e)] ?? 0) + 1
  return {
    eventTypes: Object.keys(eventCounts),
    eventCounts,
    composition: own.some((e) => e.type.startsWith('composition') || e.inputType === 'insertCompositionText'),
    selectionBefore: first?.selection ?? null,
    selectionAfter: last?.selection ?? null,
    textBefore: first?.text ?? null,
    textAfter: last?.text ?? null,
  }
}

/** Case-insensitive, since Gboard capitalises the first word of a block (run 1 typed Kyou for kyou). */
export function hasWord(text: string | null, expect: string): boolean {
  return (text ?? '').normalize('NFC').toLowerCase().includes(expect.normalize('NFC').toLowerCase())
}

const GRAPHEMES = new Intl.Segmenter(undefined, {granularity: 'grapheme'})

/**
 * The grapheme cluster index of a caret at UTF-16 `offset` in `text`: how many whole clusters lie before
 * it. Every caret position and every move the probe checks goes through this, never through code units.
 * Round 5's Hindi drag moved the caret over नमस्ते + space from offset 7 to 2: two clusters (the space and
 * स्ते), which a code unit count called five.
 */
export function graphemeIndex(text: string, offset: number): number {
  let n = 0
  for (const g of GRAPHEMES.segment(text)) {
    if (g.index >= offset) break
    n += 1
  }
  return n
}

/** Clusters the caret moved back from `from` to `to` (UTF-16 offsets in `text`). Negative is forward. */
export function caretMove(text: string, from: number, to: number): number {
  return graphemeIndex(text, from) - graphemeIndex(text, to)
}

/** The number of grapheme clusters in `text`, as a person counts characters. */
export function graphemeCount(text: string): number {
  return graphemeIndex(text, text.length)
}

export type DragSample = {px: number; focus: number}

/**
 * Characters (grapheme clusters) per pixel of space bar drag, from samples of total drag distance and
 * caret offset taken during one drag over `text`. The caret stops at offset 0, so only samples before it
 * got there count. Null when the caret never moved or hit 0 at once.
 */
export function charsPerPixel(text: string, start: number, samples: DragSample[]): number | null {
  const useful = samples.filter((s) => s.focus > 0 && s.focus < start)
  if (!useful.length) return null
  // Least squares through the origin: moved = k * px.
  const num = useful.reduce((a, s) => a + s.px * caretMove(text, start, s.focus), 0)
  const den = useful.reduce((a, s) => a + s.px * s.px, 0)
  return num / den
}

/**
 * The pixel distance at which the caret first moved `chars` clusters, read off calibration samples.
 * Falls back to chars / k when no sample moved that far.
 */
export function dragDistance(text: string, chars: number, start: number, samples: DragSample[], k: number | null): number | null {
  const hit = samples.find((s) => caretMove(text, start, s.focus) >= chars)
  if (hit) return hit.px
  return k ? Math.round(chars / k) : null
}

/** Chrome's main process pid from `pidof com.android.chrome`, which lists only the exact name. */
export function chromePid(pidof: string): number | undefined {
  const pid = pidof.trim().split(/\s+/)[0]
  return pid && /^\d+$/.test(pid) ? Number(pid) : undefined
}

/** Whether the setup log's cursor control line said the setting exists. Undefined when it did not say. */
export function cursorControlFromLog(log: string): boolean | undefined {
  const m = /CURSOR_CONTROL setting=(present|absent)/.exec(log)
  return m ? m[1] === 'present' : undefined
}

/**
 * The paragraph direction of `text` by its first strong character, as the Unicode bidi algorithm picks it:
 * Hebrew and Arabic make it rtl. The editor block has no dir attribute, and Chrome lays it out this way.
 */
export function textDirection(text: string): 'ltr' | 'rtl' {
  for (const ch of text) {
    if (/[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufeff]/.test(ch)) return 'rtl'
    if (/\p{L}/u.test(ch)) return 'ltr'
  }
  return 'ltr'
}

/**
 * Screen direction to drag the space bar to move the caret back through `text`: left in ltr, right in rtl,
 * since Gboard moves the caret the way the finger goes on screen. -1 is left.
 */
export function dragSign(text: string): -1 | 1 {
  return textDirection(text) === 'rtl' ? 1 : -1
}

/**
 * Pages the probe can type into. `editor` is the Portable Text Editor, `plain` a bare contenteditable with
 * the same event log, the control: what happens on both is Gboard and Chrome, what happens only on the
 * editor page is the editor.
 */
export const PAGES: Record<string, {file: string; editor: boolean}> = {
  editor: {file: 'editor.html', editor: true},
  plain: {file: 'plain.html', editor: false},
}

/** Page names from a space-separated list such as the workflow's `pages` input, in order, unknown ones refused. */
export function parsePages(list: string | undefined): string[] {
  const names = (list ?? '').split(/\s+/).filter(Boolean)
  if (!names.length) return ['editor', 'plain']
  for (const n of names) if (!PAGES[n]) throw new Error(`unknown page ${n}, expected one of ${Object.keys(PAGES).join(' ')}`)
  return [...new Set(names)]
}

export function pageUrl(page: string, port: number): string {
  return `http://localhost:${port}/${PAGES[page]!.file}?prefix=`
}

/** What a PROBE line and an evidence object say about the page: its name and the editor version, if any. */
export function pageInfo(page: string, versions: {editor?: string}): {page: string; editor: string | null} {
  return {page, editor: PAGES[page]!.editor ? (versions.editor ?? 'unknown') : null}
}

export type WordSegment = {index: number; segment: string; isWordLike?: boolean | undefined}

/** Word segments of `text`, from Intl.Segmenter granularity word, the segmentation a long-press selects by. */
export function wordSegments(text: string, locale?: string): WordSegment[] {
  return [...new Intl.Segmenter(locale, {granularity: 'word'}).segment(text)].map((s) => ({index: s.index, segment: s.segment, isWordLike: s.isWordLike}))
}

/** The word-like segment containing UTF-16 `offset`, or undefined when the offset is in spaces or punctuation. */
export function wordAt(segments: WordSegment[], offset: number): WordSegment | undefined {
  return segments.find((s) => s.isWordLike !== false && offset >= s.index && offset < s.index + s.segment.length)
}

export type SelectionCheck = {expected: string | null; selected: string; ok: boolean; mismatch: boolean}

/**
 * Judge a long-press selection against the word the segmenter puts at the press. `segments` must come from
 * the same text the selection was made in, ideally from the page's own Intl.Segmenter. A selection that is
 * a different word-like run inside the expected one (Chrome selecting 你 where the segmenter gives 你好) is
 * a segmentation mismatch, reported as such rather than counted as a pass or a plain miss.
 */
export function selectionCheck(segments: WordSegment[], pressOffset: number, selected: string): SelectionCheck {
  const word = wordAt(segments, pressOffset)
  const got = selected.trim()
  if (!word) return {expected: null, selected: got, ok: false, mismatch: false}
  const ok = got === word.segment
  return {expected: word.segment, selected: got, ok, mismatch: !ok && got !== '' && word.segment.includes(got)}
}
