// The probe's parsing: Gboard keys by role in real dumps from CI, layout detection, candidates, emoji cells,
// settings switches, subtypes and page-to-screen coordinates. Dumps the CI runs have not produced yet are
// built inline from the node shape uiautomator writes.

import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {test} from 'node:test'
import {cursorControlFromLog, hasWord, probeLine} from '../probe.ts'
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
  roleKey,
  subtypeLocale,
  subtypeTokens,
  webViewBounds,
} from '../lib/gboard.ts'
import {parseXml, switchRow} from '../lib/hierarchy.ts'

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
  const cells = (...labels: string[]) => gboardNodes(dump({desc: 'Delete', id: 'key_pos_del', bounds: '[0,0][1,1]'}, ...labels.map((desc, i) => ({desc, bounds: `[${i},10][${i + 1},11]`}))))
  assert.equal(pickEmoji(cells('😀', '👨‍👩‍👧', '🇳🇴'))?.label, '👨‍👩‍👧')
  assert.equal(pickEmoji(cells('😀', '🇳🇴'))?.label, '🇳🇴')
  assert.equal(pickEmoji(cells('Recent', '😀'))?.label, '😀')
  assert.equal(pickEmoji(cells('grinning face', 'flag: Norway'))?.label, 'flag: Norway')
  assert.equal(pickEmoji(cells('Recent', 'Smileys')), undefined)
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

test('page coordinates land on the screen through the WebView bounds', () => {
  const webView = webViewBounds(fixture('en-keyboard.xml'))
  assert.deepEqual(webView, {left: 0, top: 275, right: 1080, bottom: 1520})
  // The editor's root div sits at CSS (8, 8) on a 2.625 dpr screen: the dump puts it at (21, 296).
  assert.deepEqual(cssToScreen(8, 8, webView!, {dpr: 2.625, offsetLeft: 0, offsetTop: 0, scale: 1}), [21, 296])
  assert.deepEqual(cssToScreen(8, 108, webView!, {dpr: 2.625, offsetLeft: 0, offsetTop: 100, scale: 1}), [21, 296], 'a panned visual viewport')
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
  assert.ok(hasWord('tiếng', 'tiếng'), 'decomposed Vietnamese counts')
  assert.equal(
    probeLine('ko', {action: 'word', layout: 'ko', status: 'ok', reason: '', steps: [{step: 'space', text: '한국\xa0', dom: null, selection: {inEditor: true}, events: []}]}),
    "PROBE lang=ko layout=ko action=word status=ok text='한국\\xa0' reason=''",
  )
})
