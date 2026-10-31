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
import {classify, conversions, isHiragana, isLoadLine, lineTime, loadSummary, nonHiragana, result, scanLog} from '../probe-load.ts'

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

// Lines from boot 1 and boot 3 of run 41202239894 (logcat -v time), and the same load line as -v epoch prints it.
const LOAD = 'I/native  ( 1595): I0000 00:00:1793450715.969830    6379 data_loader.cc:121] New data is loaded: id=9739237208464961633 priority=10 sequence_id=1 file_path=/data/user/0/com.google.android.inputmethod.latin/files/datadownload/shared/public/datadownloadfile_1793450595163/mozcdata-24.20241006.9.data'
const BOOT1 = [
  '10-31 12:45:17.035 E/DownloadManager( 1587): DownloadManager.startDownload():531 error downloading __MOZCPACK_mozcmain_ja_JP',
  '10-31 12:45:20.127 I/DownloadManager( 1587): DownloadManager.startDownload():542 Retry download filegroup __MOZCPACK_mozcmain_ja_JP 1/3',
  '10-31 12:45:20.145 E/DownloadManager( 1587): DownloadManager.startDownload():531 error downloading __SP_handwriting_recognition',
  '10-31 12:45:37.613 I/SystemSubtypesReportModule( 1587): SystemSubtypesReportModule$3.onCurrentInputMethodEntryChanged():149 entry: en-US, source: UNSPECIFIED',
  '10-31 12:45:41.579 I/SystemSubtypesReportModule( 1587): SystemSubtypesReportModule$3.onCurrentInputMethodEntryChanged():149 entry: ja-JP, source: GLOBE_KEY',
  '10-31 12:46:21.526 I/native  ( 1587): I0000 00:00:1793450781.525996    4683 data_loader.cc:89] New request is registered: id=1 file_path=/x/mozcdata-24.20241006.9.data',
  '10-31 12:46:21.697 I/native  ( 1587): I0000 00:00:1793450781.697841    6219 data_loader.cc:121] New data is loaded: id=1 file_path=/x/mozcdata-24.20241006.9.data',
].join('\n')
const BOOT3 = [
  `10-31 12:45:15.969 ${LOAD}`,
  '10-31 12:45:27.914 I/SystemSubtypesReportModule( 1595): SystemSubtypesReportModule$3.onCurrentInputMethodEntryChanged():149 entry: ja-JP, source: GLOBE_KEY',
  '10-31 12:45:28.225 I/SessionExecutor( 1595): SessionExecutor$ExecutorMainCallback.ensureSession():515 Mozc engine reload status: RELOADED',
  '10-31 12:45:28.225 I/SessionExecutor( 1595): type: MOBILE',
].join('\n')

test('logcat times read from -v time as UTC and from -v epoch as they are', () => {
  assert.equal(lineTime('10-31 12:45:15.969 I/native  ( 1595): x', 2026), Date.UTC(2026, 9, 31, 12, 45, 15, 969) / 1000)
  assert.equal(lineTime('1793450715.969830  1595  6379 I native  : x', 2026), 1793450715.96983)
  assert.equal(lineTime('--------- beginning of main', 2026), undefined)
  assert.equal(lineTime('CAPTURE_START 1793450616', 2026), undefined)
})

test('only the mozcdata data_loader line counts as the load', () => {
  assert.ok(isLoadLine(LOAD))
  assert.ok(!isLoadLine(LOAD.replace('New data is loaded', 'New request is registered')))
  assert.ok(!isLoadLine(LOAD.replace('mozcdata', 'otherdata')))
})

test('a boot whose load came after the switch: error, retry, switches and load, and class late', () => {
  const ev = scanLog(BOOT1, 2026)
  const at = (h: number, m: number, s: number, ms: number) => Date.UTC(2026, 9, 31, h, m, s, ms) / 1000
  assert.deepEqual(ev.loads.map((l) => l.t), [at(12, 46, 21, 697)])
  assert.deepEqual(ev.entries.map((e) => `${e.lang}/${e.source}`), ['en-US/UNSPECIFIED', 'ja-JP/GLOBE_KEY'])
  assert.deepEqual(ev.errors.map((e) => e.pack), ['__MOZCPACK_mozcmain_ja_JP'])
  assert.deepEqual(ev.retries.map((r) => `${r.pack} ${r.n}/${r.of}`), ['__MOZCPACK_mozcmain_ja_JP 1/3'])
  assert.deepEqual(ev.reloads, [])
  assert.equal(classify(ev.loads[0]?.t, ev.entries.find((e) => e.lang === 'ja-JP')?.t), 'late')
})

test('a boot whose load came before the switch: RELOADED, and class early', () => {
  const ev = scanLog(BOOT3, 2026)
  assert.deepEqual(ev.reloads.map((r) => r.status), ['RELOADED'])
  assert.equal(ev.loads[0]!.line, `10-31 12:45:15.969 ${LOAD}`)
  assert.equal(classify(ev.loads[0]?.t, ev.entries.find((e) => e.lang === 'ja-JP')?.t), 'early')
})

test('early and late depend only on the load and the first ja-JP switch', () => {
  assert.equal(classify(10, 20), 'early')
  assert.equal(classify(20, 10), 'late')
  assert.equal(classify(undefined, 10), 'late')
  assert.equal(classify(10, undefined), 'early')
  assert.equal(classify(undefined, undefined), 'none')
})

test('a restarted capture counts repeated lines once and flags a hole between streams', () => {
  const a = '1793450700.000000  1 1 I x  : a\n1793450710.000000  1 1 I x  : b'
  const again = scanLog(`CAPTURE_START 1793450600\n${a}\nCAPTURE_START 1793450711\n1793450700.000000  1 1 I x  : a\n1793450720.000000  1 1 I SessionExecutor: Mozc engine reload status: RELOADED`, 2026)
  assert.deepEqual(again.starts, [1793450600, 1793450711])
  assert.deepEqual(again.gaps, [])
  assert.equal(again.reloads.length, 1)
  const hole = scanLog(`CAPTURE_START 1793450600\n${a}\nCAPTURE_START 1793450800\n1793450790.000000  1 1 I x  : c`, 2026)
  assert.deepEqual(hole.gaps, [{from: 1793450710, to: 1793450790}])
})

test('kana-only strip and expanded list offer no non-hiragana conversion, the ready list does', () => {
  const idle = new Set(candidates(gboardNodes(fixture('ja-keyboard.xml'))).map((n) => n.label))
  assert.deepEqual(conversions(gboardNodes(fixture('ja-strip-kana.xml')), idle), ['きょう'])
  assert.deepEqual(nonHiragana(conversions(gboardNodes(fixture('ja-expanded-kana.xml')), idle)), [])
  const ready = nonHiragana(conversions(gboardNodes(fixture('ja-expanded-kanji.xml')), idle))
  assert.ok(ready.includes('キョウ') && ready.includes('今日') && ready.includes('kyo'))
  assert.ok(isHiragana('きょう') && isHiragana('きょー') && !isHiragana('キョウ') && !isHiragana('ｋｙｏｕ') && !isHiragana('今日'))
})

test('the load result separates no load from a capture fault, and kanji from none', () => {
  const t = (kanji: boolean, error?: string) => ({t: 1, kanji, strip: [], expanded: null, nonHiragana: [], ...(error ? {error} : {})})
  assert.equal(result(false, true, []), 'setup-fault-never-loaded')
  assert.equal(result(false, false, []), 'capture-fault')
  assert.equal(result(true, true, [t(false), t(true)]), 'kanji')
  assert.equal(result(true, true, [t(false), t(false, 'x')]), 'no-kanji')
  assert.equal(result(true, true, [t(false, 'x')]), 'driver-error')
  assert.equal(result(true, true, []), 'driver-error')
})

test('the load summary line', () => {
  assert.equal(
    loadSummary({arm: 'load-then-switch', cls: 'early', loadT: 122.04, switchT: 133.9, reloads: ['RELOADED'], firstKanjiT: 134.5, nonHiragana: [], result: 'kanji'}),
    'LOAD_SUMMARY arm=load-then-switch class=early load_t=122.0 switch_t=133.9 reloaded=RELOADED first_kanji_t=134.5 non_hiragana=[] result=kanji',
  )
  assert.equal(
    loadSummary({arm: 'control', cls: 'late', loadT: undefined, switchT: 125.6, reloads: [], firstKanjiT: undefined, nonHiragana: ['キョウ'], result: 'setup-fault-never-loaded'}),
    "LOAD_SUMMARY arm=control class=late load_t=none switch_t=125.6 reloaded=none first_kanji_t=none non_hiragana=['キョウ'] result=setup-fault-never-loaded",
  )
})
