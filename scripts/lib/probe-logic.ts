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

export type DragSample = {px: number; focus: number}

/**
 * Characters per pixel of space bar drag, from samples of total drag distance and caret offset taken
 * during one drag. The caret stops at offset 0, so only samples before it got there count. Null when the
 * caret never moved or hit 0 at once.
 */
export function charsPerPixel(start: number, samples: DragSample[]): number | null {
  const useful = samples.filter((s) => s.focus > 0 && s.focus < start)
  if (!useful.length) return null
  // Least squares through the origin: moved = k * px.
  const num = useful.reduce((a, s) => a + s.px * (start - s.focus), 0)
  const den = useful.reduce((a, s) => a + s.px * s.px, 0)
  return num / den
}

/**
 * The pixel distance at which the caret first moved `chars` characters, read off calibration samples.
 * Falls back to chars / k when no sample moved that far.
 */
export function dragDistance(chars: number, start: number, samples: DragSample[], k: number | null): number | null {
  const hit = samples.find((s) => start - s.focus >= chars)
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
