// The probe's parsing: Gboard keys by role in real dumps from CI, layout detection, candidates, emoji cells,
// settings switches, subtypes and page-to-screen coordinates. Dumps the CI runs have not produced yet are
// built inline from the node shape uiautomator writes.

import assert from 'node:assert/strict'
import {existsSync, readFileSync} from 'node:fs'
import {test} from 'node:test'
import {probeLine} from '../probe.ts'
import {charsPerPixel, chromePid, cursorControlFromLog, dragDistance, dragSign, evidence, hasWord, pageInfo, pageUrl, PAGES, parsePages, textDirection, type Step} from '../lib/probe-logic.ts'
import {
  charKey,
  classifyLayout,
  cssToScreen,
  downloadStates,
  enabledSubtypes,
  firstCandidate,
  GBOARD,
  gboardNodes,
  LANGS,
  localeMatches,
  onLayout,
  pickEmoji,
  enabledLocales,
  layoutTiles,
  LATIN_IME,
  originFromTap,
  originFromScreen,
  omniboxOpen,
  currentInputType,
  isUrlField,
  pickRow,
  languagePickerOpen,
  keyboardTop,
  reachableRows,
  searchQuery,
  emojiPanelOpen,
  keyText,
  scrollBand,
  roleKey,
  statusBarHeight,
  subtypeHashFromLog,
  subtypeLocale,
  subtypesLine,
  subtypeTokens,
} from '../lib/gboard.ts'
import {parseXml, switchRow} from '../lib/hierarchy.ts'
import {safePath} from '../lib/util.ts'

const fixture = (name: string) => readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf8')
const nodes = (name: string) => gboardNodes(fixture(name))

type N = {desc?: string; text?: string; id?: string; bounds: string; pkg?: string; extra?: string; children?: N[]}

function node(n: N): string {
  const attrs = `text="${n.text ?? ''}" resource-id="${n.id ? `${GBOARD}:id/${n.id}` : ''}" package="${n.pkg ?? GBOARD}" content-desc="${n.desc ?? ''}" ${n.extra ?? ''} bounds="${n.bounds}"`
  return n.children ? `<node ${attrs}>${n.children.map(node).join('')}</node>` : `<node ${attrs} />`
}

const dump = (...ns: N[]) => `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">${ns.map(node).join('')}</hierarchy>`

test('parseXml records each element parent', () => {
  const ns = parseXml('<a><b><c/></b><d/></a>')
  assert.deepEqual(ns.map((n) => [n.tag, n.parent]), [['a', -1], ['b', 0], ['c', 1], ['d', 0]])
})

test('roles on the English layout: the slot left of Space is the emoji key, not a language key', () => {
  const k = nodes('en-keyboard.xml')
  assert.equal(roleKey(k, 'space')?.label, 'Space')
  assert.equal(roleKey(k, 'delete')?.label, 'Delete')
  assert.equal(roleKey(k, 'enter')?.label, 'Enter')
  assert.equal(roleKey(k, 'shift')?.label, 'Shift enabled')
  assert.equal(roleKey(k, 'emoji')?.label, 'Emoji button')
  assert.equal(roleKey(k, 'language'), undefined)
  assert.deepEqual([roleKey(k, 'space')!.x, roleKey(k, 'space')!.y], [593, 2196])
})

test('roles on the Japanese layout go by resource id where the labels are Japanese', () => {
  const k = nodes('ja-keyboard.xml')
  assert.equal(roleKey(k, 'space')?.label, 'スペース')
  assert.equal(roleKey(k, 'delete')?.label, '削除')
  assert.equal(roleKey(k, 'language')?.label, '次の言語')
  assert.equal(roleKey(k, 'emoji'), undefined)
})

test('with two languages the slot left of Space is Next language', () => {
  assert.equal(roleKey(nodes('ja-next-language.xml'), 'language')?.label, 'Next language')
})

test('charKey finds a Latin key in either case and prefers keys over the suggestion strip', () => {
  const k = nodes('en-keyboard.xml')
  assert.deepEqual([charKey(k, 'k')!.x, charKey(k, 'k')!.y], [860, 1885])
  const strip = dump(
    {desc: 'ㅎ', bounds: '[0,1517][300,1633]'},
    {desc: 'ㅎ', id: 'key_pos_2_0', bounds: '[0,2000][100,2100]'},
    {desc: '◌ั', id: 'key_pos_2_1', bounds: '[100,2000][200,2100]'},
  )
  assert.equal(charKey(gboardNodes(strip), 'ㅎ')!.y, 2050)
  assert.equal(charKey(gboardNodes(strip), 'ั')!.x, 150, 'a dotted circle on a combining mark key is ignored')
  assert.equal(charKey(k, 'ü'), undefined)
})

test('classifyLayout tells scripts apart and leaves plain QWERTY as latin', () => {
  assert.equal(classifyLayout(nodes('en-keyboard.xml')), 'latin')
  assert.equal(classifyLayout(nodes('ja-keyboard.xml')), 'ja')
  assert.equal(classifyLayout(nodes('no-gboard.xml')), 'none')
  const row = (labels: string[]) => gboardNodes(dump(...labels.map((desc, i) => ({desc, id: `key_pos_0_${i}`, bounds: `[${i * 100},1654][${i * 100 + 100},1808]`}))))
  assert.equal(classifyLayout(row(['ㅂ', 'ㅈ', 'ㄷ'])), 'ko')
  assert.equal(classifyLayout(row(['ौ', 'ै', 'ा'])), 'hi')
  assert.equal(classifyLayout(row(['ض', 'ص', 'ث'])), 'ar')
  assert.equal(classifyLayout(row(['/', "'", 'ק'])), 'he')
  assert.equal(classifyLayout(row(['ๆ', 'ไ', 'ำ'])), 'th')
  assert.equal(classifyLayout(row(['q', 'w', 'e', 'r', 't', 'z'])), 'de')
  assert.equal(classifyLayout(row(['q', 'w', 'e', 'r', 't', 'y', 'ư'])), 'vi')
})

test('onLayout trusts the subtype, unless the keys show another script or QWERTZ', () => {
  assert.ok(onLayout('vi', 'vi', 'latin'))
  assert.ok(!onLayout('en', 'vi', 'latin'))
  assert.ok(onLayout('en', 'en-US', 'latin'))
  assert.ok(!onLayout('en', 'en-US', 'ko'), 'subtype lagging a switch to Korean')
  assert.ok(!onLayout('en', 'en-US', 'de'))
  assert.ok(onLayout('de', 'de-DE', 'de'))
  assert.ok(onLayout('he', 'iw', 'he'), 'Android reports Hebrew as iw')
  assert.ok(onLayout('en', undefined, 'latin'))
  assert.ok(!onLayout('vi', undefined, 'latin'), 'without a subtype vi cannot be told from en')
  assert.ok(localeMatches('zh_CN', 'zh'))
})

test('firstCandidate takes the leftmost Han label above the keys and skips the header icons', () => {
  const k = gboardNodes(
    dump(
      {desc: '设置', id: 'key_pos_header_access_points_menu', bounds: '[0,1517][110,1633]'},
      {text: '你好', bounds: '[110,1517][300,1633]'},
      {text: '拟好', bounds: '[300,1517][500,1633]'},
      {text: 'nihao', bounds: '[500,1517][700,1633]'},
      {desc: 'q', id: 'key_pos_0_0', bounds: '[0,1654][100,1808]'},
      {desc: '你', id: 'key_pos_1_0', bounds: '[0,1808][100,1960]'},
    ),
  )
  assert.equal(firstCandidate(k)?.label, '你好')
  assert.equal(firstCandidate(nodes('en-keyboard.xml')), undefined)
})

test('pickEmoji prefers a ZWJ sequence or a flag and skips keys', () => {
  // A panel needs a grid of cells, so pad with the ".." cells the dump turns astral emoji into.
  const pad = Array.from({length: 8}, () => '..')
  const cells = (...labels: string[]) => gboardNodes(dump({desc: 'Delete', id: 'key_pos_del', bounds: '[0,0][1,1]'}, ...[...labels, ...pad].map((desc, i) => ({desc, bounds: `[${i},10][${i + 1},11]`}))))
  assert.equal(pickEmoji(cells('😀', '👨‍👩‍👧', '🇳🇴'))?.label, '👨‍👩‍👧')
  assert.equal(pickEmoji(cells('😀', '🇳🇴'))?.label, '🇳🇴')
  assert.equal(pickEmoji(cells('Recent', '😀'))?.label, '😀')
  assert.equal(pickEmoji(cells('grinning face', 'flag: Norway'))?.label, 'flag: Norway')
  assert.equal(pickEmoji(cells('Recent', 'Smileys'))?.label, '..', 'a mangled cell when nothing is readable')
})

test('switchRow reads the switch in a settings row and taps the row', () => {
  const xml = dump({
    pkg: 'x',
    extra: 'clickable="true"',
    bounds: '[0,500][1080,700]',
    children: [
      {pkg: 'x', text: 'Enable gesture cursor control', bounds: '[40,520][800,580]'},
      {pkg: 'x', extra: 'checkable="true" checked="false"', bounds: '[900,560][1040,640]'},
    ],
  })
  assert.deepEqual(switchRow(xml, /cursor control/i), {title: 'Enable gesture cursor control', checked: false, x: 540, y: 600})
  assert.equal(switchRow(xml, /delete/i), undefined)
})

test('subtypes: the active one by hash, the enabled ids, and the logged tokens', () => {
  const ims = [
    '  InputMethodSubtype #0:',
    '    mSubtypeNameOverride= mLayoutLabelNonLocalized= mPkLanguageTag= mPkLayoutType= mSubtypeId=0 mSubtypeLocale=en_US mSubtypeLanguageTag=en-US mSubtypeMode=keyboard mIsAuxiliary=false mOverridesImplicitlyEnabledSubtype=false mIsAsciiCapable=true mSubtypeHashCode=-921088104',
    '    mSubtypeNameOverride= mSubtypeId=0 mSubtypeLocale=ko mSubtypeLanguageTag=ko mSubtypeMode=keyboard mIsAuxiliary=false mSubtypeHashCode=1234',
  ].join('\n')
  assert.equal(subtypeLocale(ims, '1234\n'), 'ko')
  assert.equal(subtypeLocale(ims, '-921088104'), 'en-US')
  assert.equal(subtypeLocale(ims, '123'), undefined, 'a hash prefix does not match')
  assert.equal(subtypeLocale(ims, 'null'), undefined)
  assert.deepEqual(subtypeTokens(ims), ['mSubtypeLanguageTag=en-US', 'mSubtypeLanguageTag=ko', 'mSubtypeLocale=en_US', 'mSubtypeLocale=ko'])
  const ime = `${GBOARD}/com.android.inputmethod.latin.LatinIME`
  assert.deepEqual(enabledSubtypes(`com.other/.Ime:${ime};-921088104;1234\n`, ime), ['-921088104', '1234'])
  assert.deepEqual(enabledSubtypes(ime, ime), [])
})

test('downloadStates picks the download and install notes', () => {
  const xml = dump({pkg: 'x', text: 'Downloading 42%', bounds: '[0,0][1,1]'}, {pkg: 'x', text: 'Korean', bounds: '[0,0][1,1]'}, {pkg: 'x', text: 'Installed', bounds: '[0,0][1,1]'})
  assert.deepEqual(downloadStates(xml), ['Downloading 42%', 'Installed'])
})

test('page coordinates land on the screen from an origin, a pan and a zoom', () => {
  // Round 1's en dump: the WebView starts at y=275 and the editor's root div at CSS (8, 8) is drawn at (21, 296).
  const origin = {left: 0, top: 275}
  assert.deepEqual(cssToScreen(8, 8, origin, {dpr: 2.625, offsetLeft: 0, offsetTop: 0, scale: 1}), [21, 296])
  assert.deepEqual(cssToScreen(8, 108, origin, {dpr: 2.625, offsetLeft: 0, offsetTop: 100, scale: 1}), [21, 296], 'a panned visual viewport')
  assert.deepEqual(cssToScreen(8, 8, origin, {dpr: 2.625, offsetLeft: 0, offsetTop: 0, scale: 2}), [42, 317], 'a zoomed visual viewport')
})

test('the calibration tap gives the origin back, panned or not', () => {
  const vp = {dpr: 2.625, offsetLeft: 0, offsetTop: 0, scale: 1}
  assert.deepEqual(originFromTap([864, 1060], {x: 329.1428, y: 299.0476}, vp), {left: 0, top: 275})
  const panned = {...vp, offsetTop: 100}
  // clientY is relative to the visual viewport already, so a pan does not change the origin.
  assert.deepEqual(originFromTap([864, 1060], {x: 329.1428, y: 299.0476}, panned), {left: 0, top: 275})
})

test('the origin estimate: WebView when visible, else the toolbar, else status bar plus 56dp', () => {
  assert.equal(statusBarHeight(fixture('en-keyboard.xml')), 128)
  assert.deepEqual(originFromScreen(fixture('en-keyboard.xml'), 2.625), {origin: {left: 0, top: 275}, source: 'webview'})
  // Round 2 after a relaunch: the omnibox covers the page, so no WebView, but the toolbar is there.
  assert.deepEqual(originFromScreen(fixture('r2-omnibox.xml'), 2.625), {origin: {left: 0, top: 275}, source: 'toolbar'})
  // Round 1's promo hides both. 128 + 56dp x 2.625 = 275.
  assert.deepEqual(originFromScreen(fixture('r1-chrome-promo.xml'), 2.625), {origin: {left: 0, top: 275}, source: 'statusbar'})
})

test('after a relaunch the omnibox was open and Gboard typed into the URL bar', () => {
  assert.ok(omniboxOpen(fixture('r2-omnibox.xml')))
  assert.ok(!omniboxOpen(fixture('en-keyboard.xml')))
  // Gboard's onStartInput in round 2 logcat: inputType=80011, Uri[NoSuggestion].
  assert.ok(isUrlField(0x80011))
  assert.ok(!isUrlField(0x0), 'no field')
  assert.ok(!isUrlField(0xa0001), 'a contenteditable: text, multi-line, auto-correct')
  assert.ok(!isUrlField(undefined))
  assert.equal(currentInputType(readFileSync(new URL('fixtures/r2-ims-editorinfo.txt', import.meta.url), 'utf8')), 0)
  assert.equal(currentInputType('      curEditorInfo:\n        inputType=0x80011 imeOptions=0x2000002'), 0x80011)
  assert.equal(currentInputType('nothing'), undefined)
})

test('dump names are safe for artifact upload', () => {
  assert.equal(safePath('out/probe-zh-en-emoji-5-panel?.xml'), 'out/probe-zh-en-emoji-5-panel_.xml')
  assert.equal(safePath('out/keyboard-zh.xml'), 'out/keyboard-zh.xml')
  assert.equal(safePath('a/b c/d:e*f"g<h>i|j.xml'), 'a/b c/d_e_f_g_h_i_j.xml', 'only the file name changes')
  assert.equal(safePath('plain'), 'plain')
})

test('the run 1 notifications promo hides the WebView, which is why geometry no longer reads it', () => {
  const promo = parseXml(fixture('r1-chrome-promo.xml'))
  assert.ok(promo.some((n) => n.attrs.text === 'Chrome notifications make things easier'))
  assert.ok(promo.some((n) => n.attrs.text === 'No thanks'))
  assert.ok(!promo.some((n) => n.attrs.class === 'android.webkit.WebView'))
})

const titleRows = (name: string) => parseXml(fixture(name)).filter((n) => n.attrs['resource-id'] === 'android:id/title').map((n) => ({text: n.attrs.text!}))

test('rows: the search and variant lists run 1 showed now match', () => {
  assert.equal(pickRow(titleRows('r1-vi-search.xml'), LANGS.vi!.rows)?.text, 'Tiếng Việt (Việt Nam)')
  // (مصر) is below the fold on this page, so the next preference on screen wins rather than a scroll.
  assert.equal(pickRow(titleRows('r1-ar-variants.xml'), LANGS.ar!.rows)?.text, 'العربية (المملكة العربية السعودية)')
  assert.equal(pickRow(titleRows('r1-hi-variants.xml'), LANGS.hi!.rows)?.text, 'हिन्दी (भारत)')
  // The Arabic search's first page holds only script variants of other languages, so scrolling must go on.
  assert.equal(pickRow(titleRows('r1-ar-search.xml'), LANGS.ar!.rows), undefined)
  assert.equal(pickRow([{text: 'Deutsch (Belgien)'}, {text: 'Deutsch (Deutschland)'}], LANGS.de!.rows)?.text, 'Deutsch (Deutschland)', 'pattern order beats list order')
})

test('layoutTiles: only what follows Navigate up, so a title like हिन्दी is never a tile', () => {
  assert.deepEqual(layoutTiles(fixture('r1-ko-layouts.xml')).map((t) => `${t.desc}${t.selected ? '[x]' : ''}`), ['두벌식[x]', '단모음', '10키'])
  assert.deepEqual(layoutTiles(fixture('r1-hi-variants.xml')), [], 'a variant page has no tiles')
  assert.deepEqual(layoutTiles(fixture('r1-ar-variants.xml')), [])
  assert.ok(LANGS.ko!.layout!.test('두벌식'))
  assert.ok(LANGS.zh!.layout!.test('拼音'))
  assert.ok(!LANGS.zh!.layout!.test('9 键'))
})

test('subtypes: setup logs hash=tag pairs and probe finds the hash per language', () => {
  const dump = readFileSync(new URL('fixtures/r1-ko-ims-excerpt.txt', import.meta.url), 'utf8')
  const enabled = `${LATIN_IME};1594443099;-1906255757:com.google.android.tts/x.VoiceInputMethodService`
  const subtypes = enabledLocales(enabled, dump)
  assert.deepEqual(subtypes, [{hash: '1594443099', locale: 'en-US'}, {hash: '-1906255757', locale: 'ko-KR'}])
  const line = subtypesLine(subtypes)
  assert.equal(line, 'SUBTYPES 1594443099=en-US -1906255757=ko-KR')
  const log = `SETUP ko step 1 settings\n${line}\nSETUP ko done\n`
  assert.equal(subtypeHashFromLog(log, 'ko'), '-1906255757')
  assert.equal(subtypeHashFromLog(log, 'en'), '1594443099')
  assert.equal(subtypeHashFromLog(log, 'ar'), undefined)
  assert.equal(subtypeHashFromLog('SUBTYPES 1=iw-IL', 'he'), '1')
})

const step = (name: string, text: string, focus: number, events: Step['events']): Step => ({step: name, text, dom: text, selection: {inEditor: true, anchor: focus, focus, selected: '', collapsed: true}, events})

test('evidence counts only the action own events and spots composition', () => {
  const before = [{type: 'beforeinput', inputType: 'insertText', data: 'x'}]
  const own = [
    {type: 'compositionstart', data: ''},
    {type: 'beforeinput', inputType: 'insertCompositionText', data: 'ㅎ'},
    {type: 'beforeinput', inputType: 'insertCompositionText', data: '하'},
    {type: 'input', inputType: 'insertCompositionText', data: '하'},
  ]
  const e = evidence([step('start', '', 0, before), step('typed', '하', 1, [...before, ...own])])
  assert.deepEqual(e.eventTypes, ['compositionstart', 'beforeinput:insertCompositionText', 'input:insertCompositionText'])
  assert.equal(e.eventCounts['beforeinput:insertCompositionText'], 2)
  assert.equal(e.composition, true)
  assert.equal(e.selectionBefore?.focus, 0)
  assert.equal(e.selectionAfter?.focus, 1)
  assert.deepEqual([e.textBefore, e.textAfter], ['', '하'])
  const plain = evidence([step('start', '', 0, []), step('typed', 'K', 1, [{type: 'beforeinput', inputType: 'insertText', data: 'K'}])])
  assert.equal(plain.composition, false)
  assert.deepEqual(evidence([]).eventTypes, [])
})

test('space drag calibration: characters per pixel before the caret hits 0, and the distance for N', () => {
  // Round 1, th-2: three key widths (321px) took the caret from 5 to 0. Samples like these give ~1 char / 40px.
  const samples = [{px: 6, focus: 5}, {px: 30, focus: 5}, {px: 42, focus: 4}, {px: 84, focus: 3}, {px: 120, focus: 2}, {px: 400, focus: 0}]
  const k = charsPerPixel(5, samples)!
  assert.ok(Math.abs(k - 0.0246) < 0.001, String(k))
  assert.equal(dragDistance(3, 5, samples, k), 120)
  assert.equal(dragDistance(4, 5, samples.slice(0, 5), k), Math.round(4 / k))
  assert.equal(charsPerPixel(5, [{px: 6, focus: 5}, {px: 12, focus: 0}]), null, 'jumped straight to 0')
  assert.equal(charsPerPixel(5, []), null)
})

test('chromePid reads pidof, which is empty once Chrome is gone', () => {
  assert.equal(chromePid('4714\n'), 4714)
  assert.equal(chromePid(''), undefined)
  assert.equal(chromePid('4714 5521'), 4714)
})

test('every language has keys, an expected word, and an ASCII search', () => {
  for (const [code, lang] of Object.entries(LANGS)) {
    assert.equal(lang.code, code)
    assert.ok(lang.keys.length > 0)
    assert.match(lang.search, /^[A-Za-z]+$/)
  }
  assert.equal(LANGS.hi!.keys.join(''), LANGS.hi!.expect)
  // Gboard labels the Korean keys with compatibility jamo (U+3131..U+318E), not the conjoining ones.
  assert.ok(LANGS.ko!.keys.every((k) => /^[\u3131-\u318e]$/.test(k)))
})

test('probe log helpers', () => {
  assert.equal(cursorControlFromLog('SETUP en CURSOR_CONTROL setting=present title="x" before=false after=true'), true)
  assert.equal(cursorControlFromLog('SETUP en CURSOR_CONTROL setting=absent reason="no row"'), false)
  assert.equal(cursorControlFromLog(''), undefined)
  assert.ok(hasWord('tiếng ', 'tiếng'))
  assert.ok(hasWord('Kyou ', 'kyou'), 'Gboard capitalises the first word')
  assert.ok(hasWord('tiếng', 'tiếng'), 'decomposed Vietnamese counts')
  assert.equal(
    probeLine('ko', {page: 'editor', editor: '8.2.10', action: 'word', layout: 'ko', status: 'ok', reason: '', steps: [{step: 'space', text: '한국\xa0', dom: null, selection: {inEditor: true}, events: []}]}),
    "PROBE lang=ko page=editor editor=8.2.10 layout=ko action=word status=ok text='한국\\xa0' reason=''",
  )
  assert.equal(
    probeLine('ko', {page: 'plain', editor: null, action: 'word', layout: 'ko', status: 'failed', reason: 'x', steps: []}),
    "PROBE lang=ko page=plain editor=none layout=ko action=word status=failed text=None reason='x'",
  )
})

// Round 3 keyboard dumps (run 41260579991). Each word's keys must resolve on the layout Gboard showed.
const word = (lang: string, dumpName: string, prevDump?: Record<number, string>) => {
  const k = nodes(dumpName)
  const keys = LANGS[lang]!.keys
  return keys.map((ch, i) => {
    const pool = prevDump?.[i] ? nodes(prevDump[i]!) : k
    return charKey(pool, ch, keys.slice(0, i).join(''))?.id
  })
}

test('Korean: jamo come from key names (히읗 for ㅎ) and vowel syllables (아 for ㅏ)', () => {
  assert.deepEqual(word('ko', 'r3-ko-keyboard.xml'), ['key_pos_1_4', 'key_pos_1_7', 'key_pos_1_1', 'key_pos_0_3', 'key_pos_2_6', 'key_pos_0_3'])
  assert.equal(keyText('쌍비읍'), 'ㅃ')
  assert.equal(keyText('요'), 'ㅛ')
  assert.equal(keyText('한'), '한', 'a syllable with a final is not a vowel key')
})

test('Thai: combining marks are keys labelled with a leading space', () => {
  assert.deepEqual(word('th', 'r3-th-keyboard.xml'), ['key_pos_2_8', 'key_pos_2_9', 'key_pos_1_5', 'key_pos_2_8', 'key_pos_2_3', 'key_pos_1_6'])
  assert.equal(keyText(' ั'), 'ั')
})

test('Hindi: after a consonant or conjunct the mark keys preview it joined, and still match the mark', () => {
  // Round 3 failed on the virama right after स. On the dump taken there, the key reads स्‍.
  assert.equal(charKey(nodes('r3-hi-after-sa.xml'), '्', 'स')?.id, 'key_pos_4_8')
  assert.equal(charKey(nodes('r3-hi-after-sa.xml'), 'े', 'स')?.id, 'key_pos_0_6')
  // Round 4 stopped at the e-matra after the conjunct स्त, where the key reads स्ते.
  assert.equal(charKey(nodes('r4-hi-after-sta.xml'), 'े', 'नमस्त')?.id, 'key_pos_0_6')
  assert.equal(charKey(nodes('r4-hi-after-sta.xml'), 'त', 'नमस्')?.id, 'key_pos_2_5', 'a consonant is still its plain key')
  // On the base page the virama has its own key and the consonants are plain.
  assert.equal(charKey(nodes('r3-hi-keyboard.xml'), '्')?.id, 'key_pos_4_8')
  assert.equal(charKey(nodes('r3-hi-keyboard.xml'), 'न')?.id, 'key_pos_2_9')
  assert.equal(keyText('स‌‌‌'), 'स', 'Hindi pads keys with zero width non-joiners')
  // Without prev a joined preview is not the mark.
  assert.equal(charKey(nodes('r3-hi-after-sa.xml'), '्'), undefined)
})

test('German QWERTZ has no ü key, so ü stays on a long-press of u', () => {
  const k = nodes('r3-de-keyboard.xml')
  assert.equal(charKey(k, 'ü'), undefined)
  assert.equal(charKey(k, 'u')?.id, 'key_pos_0_6')
  assert.equal(classifyLayout(k), 'de')
  assert.equal(LANGS.de!.longPress?.ü, 'u')
})

test('the language key is found by id on every localised two-language keyboard', () => {
  for (const [name, label] of [['r3-ko-keyboard.xml', '다음 언어'], ['r3-th-keyboard.xml', 'ภาษาถัดไป'], ['r3-hi-keyboard.xml', 'अगली भाषा'], ['r3-de-keyboard.xml', 'Nächste Sprache']] as const) {
    assert.equal(roleKey(nodes(name), 'language')?.label, label, name)
  }
  assert.equal(roleKey(nodes('en-keyboard.xml'), 'language'), undefined, 'a one-language keyboard has the emoji key there')
})

test('emoji panel: found by its grid of cells, which the dump mangles to ".."', () => {
  const ko = nodes('r3-ko-emoji-panel.xml')
  assert.ok(emojiPanelOpen(ko))
  // Its readable cells: ☺️ and a ZWJ sequence with a mangled base, which wins as the multi-code-point case.
  assert.match(pickEmoji(ko)!.label, /^\.\.\u200d/)
  assert.equal(roleKey(ko, 'delete')?.id, 'key_pos_del')
  // English round 3 picked a ZWJ sequence whose emoji base was mangled.
  assert.match(pickEmoji(nodes('r3-en-emoji-panel.xml'))!.label, /\u200d/)
  // A keyboard with emoji suggestions in its strip is not the panel.
  assert.ok(!emojiPanelOpen(nodes('r3-de-emoji-strip.xml')))
  assert.equal(pickEmoji(nodes('r3-de-emoji-strip.xml')), undefined)
  assert.ok(!emojiPanelOpen(nodes('r3-de-keyboard.xml')))
})

test('the language list scrolls above the search keyboard, which round 3 glide-typed into', () => {
  const band = scrollBand(readFileSync(new URL('fixtures/r3-ar-search-keyboard.xml', import.meta.url), 'utf8'), 2400)
  const keyboardTop = Math.min(...nodes('r3-ar-search-keyboard.xml').filter((n) => n.id.startsWith('key_pos_')).map((n) => n.bounds.top))
  assert.ok(band.bottom < keyboardTop, `${band.bottom} < ${keyboardTop}`)
  assert.ok(band.top < band.bottom - 300, 'a swipe long enough to scroll')
  assert.deepEqual(scrollBand('<hierarchy><node package="x" bounds="[0,0][1,1]"/></hierarchy>', 2400), {top: 864, bottom: 2040})
})

test('space drag goes right to move back through rtl text', () => {
  assert.equal(textDirection('שלום '), 'rtl')
  assert.equal(textDirection('مرحبا'), 'rtl')
  assert.equal(textDirection('  Kyou'), 'ltr')
  assert.equal(textDirection('123 שלום'), 'rtl', 'digits are weak, the first letter decides')
  assert.equal(textDirection(''), 'ltr')
  assert.equal(dragSign('שלום '), 1)
  assert.equal(dragSign('Kyou '), -1)
})

test('setup only taps rows above the search keyboard, and knows a search screen from a variant page', () => {
  const xml = readFileSync(new URL('fixtures/r3-ar-search-keyboard.xml', import.meta.url), 'utf8')
  const top = keyboardTop(xml)!
  assert.ok(top > 1000)
  const rows = reachableRows(xml)
  assert.ok(rows.length > 0 && rows.every((r) => r.y < top))
  const all = parseXml(xml).filter((n) => n.attrs['resource-id'] === 'android:id/title')
  assert.ok(all.length > rows.length, 'rows under the keyboard are left out')
  // Round 4: the search field after a tap landed on the keyboard.
  assert.equal(searchQuery(fixture('r4-ar-stray-query.xml')), 'Arabic word ', 'a committed suggestion, trailing space and all')
  assert.equal(searchQuery(fixture('r1-vi-search.xml')), 'Vietnamese')
  assert.equal(searchQuery(fixture('r1-ar-variants.xml')), undefined, 'a variant page has no search field')
  assert.equal(searchQuery(fixture('r1-hi-variants.xml')), undefined)
  assert.equal(keyboardTop(fixture('r1-ar-variants.xml')), undefined)
})

test('a space drag that sat still opened the language picker, in any UI language', () => {
  // Round 4 th-1: the picker titled เปลี่ยนแป้นพิมพ์ over the keyboard, after a drag that moved 0.
  assert.ok(languagePickerOpen(fixture('r4-th-language-picker.xml')))
  assert.ok(!languagePickerOpen(fixture('r3-th-keyboard.xml')))
  assert.ok(!languagePickerOpen(fixture('en-keyboard.xml')))
})

test('pages: the editor page and the plain control, with the editor version only where there is an editor', () => {
  assert.deepEqual(parsePages(undefined), ['editor', 'plain'])
  assert.deepEqual(parsePages(''), ['editor', 'plain'])
  assert.deepEqual(parsePages(' plain  editor plain '), ['plain', 'editor'])
  assert.throws(() => parsePages('editor lexical'), /unknown page lexical/)
  assert.equal(pageUrl('plain', 8765), 'http://localhost:8765/plain.html?prefix=')
  assert.deepEqual(pageInfo('editor', {editor: '8.2.10'}), {page: 'editor', editor: '8.2.10'})
  assert.deepEqual(pageInfo('editor', {}), {page: 'editor', editor: 'unknown'})
  assert.deepEqual(pageInfo('plain', {editor: '8.2.10'}), {page: 'plain', editor: null})
  // Both pages exist in the page build, which copies src/*.html.
  for (const {file} of Object.values(PAGES)) assert.ok(existsSync(new URL(`../../page/src/${file}`, import.meta.url)), file)
})
