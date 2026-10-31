// Dry run against real artifacts from CI runs 40746115263 (en) and 40746139942 (ja) on API 36:
// accessibility dumps, the RESULT lines their cases printed, and the Python-compatible formatting.

import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {test} from 'node:test'
import {hasDigit, isJapanese, nestedCompositionstart, resultLine} from '../drive.ts'
import {packageKeys, parseXml} from '../lib/hierarchy.ts'
import {pyRepr, pySorted} from '../lib/util.ts'
import {candidates, findLabel, gboardNodes, summary} from '../probe-candidates.ts'
import {hasKanji, screenLabels, stripLabels, summary as readinessSummary} from '../probe-readiness.ts'

const GBOARD = 'com.google.android.inputmethod.latin'
const fixture = (name: string) => readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf8')
const keys = (name: string) => packageKeys(fixture(name), GBOARD)

test('the English keyboard dump has its keys and the space key', () => {
  const k = keys('en-keyboard.xml')
  assert.equal(k.size, 52)
  assert.ok(k.has('Space'))
  assert.deepEqual(k.get('K'), [860, 1885])
  assert.equal(isJapanese(k.keys()), false)
  // The PHASE line the Python driver printed for this dump.
  assert.equal(
    pyRepr(pySorted(k.keys()).slice(0, 40)),
    "[',', '.', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'A', 'B', 'Back', 'C', 'Clipboard', 'D', 'Delete', 'E', 'Emoji button', 'Enter', 'F', 'G', 'GIF Keyboard', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'Open features menu', 'P', 'Q', 'R', 'S', 'Settings', 'Shift enabled']",
  )
})

test('the Gboard v15 install banner is found before the language key', () => {
  const k = keys('ja-banner.xml')
  const banner = [...k.keys()].filter((l) => l.toLowerCase().startsWith('close the new language'))
  assert.deepEqual(banner, ['Close the new language installation banner.'])
  assert.equal(isJapanese(k.keys()), false)
})

test('the English layout offers Next language once the banner is closed', () => {
  const k = keys('ja-next-language.xml')
  assert.deepEqual([...k.keys()].filter((l) => /^(next language|switch to|globe)/i.test(l)), ['Next language'])
})

test('the Japanese QWERTY layout is recognised and labels its space key スペース', () => {
  const k = keys('ja-keyboard.xml')
  assert.ok(isJapanese(k.keys()))
  assert.ok(k.has('k'))
  assert.ok(k.has('スペース'))
})

test('a dump without Gboard nodes counts as incomplete', () => {
  const k = keys('no-gboard.xml')
  assert.equal(k.size, 0)
  assert.ok(!['Space', 'space', 'スペース'].some((l) => k.has(l)))
})

test('malformed XML throws like ElementTree', () => {
  assert.throws(() => parseXml('<hierarchy><node></hierarchy>'))
  assert.throws(() => parseXml('<hierarchy><node a="&nope;"/></hierarchy>'))
  assert.throws(() => parseXml(''))
})

test('a Japanese case reproduces its RESULT line', () => {
  const r = JSON.parse(fixture('ja-editor-empty.json'))
  const events = r.state.events
  assert.equal(nestedCompositionstart(events), r.nested_compositionstart)
  assert.equal(
    resultLine('editor-empty', r.state.text, r.picked, events, nestedCompositionstart(events), r.second_word_compositionstart, 'ja'),
    "RESULT editor-empty: text='ｋ用今日' picked=space/今日 compositionstart=3 nested=1 second_word_compositionstart=1 lang=ja",
  )
})

test('an English case reproduces its RESULT line, with the non-breaking space escaped as Python did', () => {
  const r = JSON.parse(fixture('en-plain-empty.json'))
  const events = r.state.events
  assert.equal(
    resultLine('plain-empty', r.state.text, r.picked, events, nestedCompositionstart(events), r.second_word_compositionstart, 'en'),
    "RESULT plain-empty: text='Kyou kyou\\xa0' picked=space/space compositionstart=0 nested=0 second_word_compositionstart=0 lang=en",
  )
})

test('a digit in the typed text is a mistap, ASCII or full width', () => {
  assert.ok(hasDigit('K7ou kyou '))
  assert.ok(hasDigit('ｋ７'))
  assert.ok(!hasDigit('今日今日'))
  assert.ok(!hasDigit(null))
})

test('repr matches Python for quotes and escapes', () => {
  assert.equal(pyRepr("a'b"), `"a'b"`)
  assert.equal(pyRepr('a\'b"c'), `'a\\'b"c'`)
  assert.equal(pyRepr('　'), "'\\u3000'")
  assert.equal(pyRepr({package: 'x', pid: 4264, ok: true, none: null}), "{'package': 'x', 'pid': 4264, 'ok': True, 'none': None}")
})

test('the candidates probe keeps the strip and drops the keys of the Japanese layout', () => {
  const nodes = gboardNodes(fixture('ja-keyboard.xml'))
  const strip = candidates(nodes)
  assert.ok(nodes.some((n) => n.rid === 'key_pos_0_0' && n.label === 'q'))
  assert.ok(!strip.some((n) => n.rid.startsWith('key_pos_') && !n.rid.startsWith('key_pos_header')))
  assert.ok(findLabel(strip, '機能メニューを開く'))
  assert.equal(findLabel(strip, 'q'), undefined)
})

test('parseXml gives each node its depth', () => {
  assert.deepEqual(parseXml('<a><b/><c><d/></c></a>').map((n) => `${n.tag}${n.depth}`), ['a0', 'b1', 'c1', 'd2'])
})

test('the candidates summary names strip, expanded list and the committed code points', () => {
  assert.equal(
    summary({rep: 1, word: 2, strip: false, more: true, expanded: true, scrolled: false, committed: 'きょう今日', codepoints: ['U+304D', 'U+3087', 'U+3046', 'U+4ECA', 'U+65E5']}),
    "r1w2:strip=no,expanded=yes,committed='きょう今日'[U+304D+U+3087+U+3046+U+4ECA+U+65E5]",
  )
  assert.equal(summary({rep: 3, word: 1, strip: true, more: false, expanded: null, scrolled: false, committed: '', codepoints: []}), "r3w1:strip=yes,expanded=no_more_button,committed=''[]")
})

test('the readiness probe counts only strip labels kyou brought, and spots ideographs', () => {
  const nodes = gboardNodes(fixture('ja-keyboard.xml'))
  const idle = new Set(candidates(nodes).map((n) => n.label))
  assert.deepEqual(stripLabels(nodes, idle), [])
  assert.ok(stripLabels(nodes, new Set()).includes('設定'))
  assert.ok(!stripLabels(nodes, new Set()).includes('Back'))
  assert.ok(hasKanji('今日') && !hasKanji('きょう') && !hasKanji('キョウ'))
  assert.ok(screenLabels(fixture('ja-keyboard.xml')).has(`${GBOARD}: 設定`))
})

test('the readiness summary gives the first kanji time and what followed', () => {
  assert.equal(readinessSummary([{t: 1, kanji: false, labels: []}, {t: 61.2, kanji: true, labels: ['今日']}, {t: 66, kanji: true, labels: []}, {t: 71, kanji: false, labels: [], error: 'x'}]), 'READINESS_SUMMARY first_kanji_t=61.2 iterations=4 after=[true,error]')
  assert.equal(readinessSummary([{t: 1, kanji: false, labels: []}]), 'READINESS_SUMMARY first_kanji_t=none iterations=1 after=[]')
})
