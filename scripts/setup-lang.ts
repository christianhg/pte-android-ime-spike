// Add one Gboard language and layout through its settings screens, the way setup-ja.ts adds Japanese, and
// turn on gesture cursor control for the space bar drag. English needs no language, only the setting.
//
// Every step dumps the screen to out/<lang>-setup-*. Lines start with SETUP so the log greps well.
//
// Usage: node scripts/setup-lang.ts <lang> <outdir>

import {writeFileSync} from 'node:fs'
import {adbOutput, adbPassthrough} from './lib/adb.ts'
import {downloadStates, enabledLocales, reachableRows, scrollBand, searchQuery, enabledSubtypes, GBOARD, LANGS, LATIN_IME, layoutTiles, localeMatches, pickRow, subtypesLine, type Lang} from './lib/gboard.ts'
import {center, parseBounds, parseXml, switchRow} from './lib/hierarchy.ts'
import {Device, type UiObject} from './lib/u2.ts'
import {safePath, sleep} from './lib/util.ts'

/** writeFileSync with the file name made safe for artifact upload. */
function writeFile(path: string, data: string): void {
  writeFileSync(safePath(path), data)
}

const [code, out] = process.argv.slice(2) as [string, string]
let step = 0

function log(line: string): void {
  console.log(`SETUP ${code} ${line}`)
}

async function snap(d: Device, name: string): Promise<string> {
  step += 1
  const base = `${out}/${code}-setup-${String(step).padStart(2, '0')}-${name}`
  const xml = await d.dumpHierarchy()
  writeFile(`${base}.xml`, xml)
  await d.screenshot(base)
  const downloads = downloadStates(xml)
  log(`step ${step} ${name}${downloads.length ? ` download=${JSON.stringify(downloads)}` : ''}`)
  return xml
}

async function scrollTo(d: Device, sel: UiObject, pages = 12): Promise<void> {
  if ((await sel.exists()) || !(await d.find({scrollable: true}).exists())) return
  for (let i = 0; i < pages; i++) {
    await d.find({scrollable: true}).scrollForward(30)
    if (await sel.exists()) return
  }
}

async function tapText(d: Device, pattern: string, name: string, scroll = false): Promise<void> {
  const sel = d.find({textMatches: `(?i)${pattern}`})
  if (scroll) await scrollTo(d, sel)
  if (!(await sel.wait(15))) {
    await snap(d, `missing-${name}`)
    throw new Error(`no node matching ${JSON.stringify(pattern)} for ${name}`)
  }
  await sel.click()
  await sleep(1.5)
  await snap(d, name)
}

async function openSettings(d: Device): Promise<void> {
  await adbPassthrough(['shell', 'am', 'force-stop', GBOARD])
  await adbPassthrough(['shell', 'am', 'start', '-n', `${GBOARD}/com.google.android.apps.inputmethod.latin.preference.SettingsActivity`])
  await sleep(4)
  await snap(d, 'settings')
}

/** The search on the Add keyboard screen, in either of the two shapes setup-ja.ts met. */
async function languageSearch(d: Device): Promise<UiObject> {
  const inline = d.find({className: 'android.widget.EditText', text: 'Search language'})
  if (await inline.exists()) return inline
  const button = d.find({description: 'Search for a language'})
  if (!(await button.wait(8))) {
    await snap(d, 'missing-search-button')
    throw new Error('no language search on the Add keyboard screen')
  }
  await button.click()
  await sleep(1.5)
  const field = d.find({resourceId: `${GBOARD}:id/search_src_text`})
  if (!(await field.wait(8))) {
    await snap(d, 'missing-search-field')
    throw new Error('no search field after tapping Search for a language')
  }
  return field
}

/** Result rows in a dump: the android:id/title texts, which the search field does not have. */
// Only rows above the keyboard: a row under it cannot be tapped without hitting Gboard.
const titles = reachableRows

/**
 * Scroll the language list one page. Round 3 scrolled with the search keyboard up: the swipe crossed Gboard,
 * glide typing turned it into words, and the search read "Arabic by by by ...", so Arabic was never added.
 * Back would hide the keyboard but closes the search on some Gboard builds (round 1, vi), so swipe only in
 * the band between the list's top and the keyboard's top instead.
 */
async function scrollList(d: Device, xml: string): Promise<void> {
  const [w, h] = await d.windowSize()
  const band = scrollBand(xml, h)
  await d.swipe(w / 2, band.bottom, w / 2, band.top, 0.5)
  await sleep(0.8)
}

/**
 * Clear the search field and type `query`, then check the field holds exactly that. Round 4 ended with
 * "Arabic word" in the field after a tap landed on the keyboard, and the search found nothing.
 */
async function typeQuery(d: Device, search: UiObject, query: string): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    await search.click()
    await adbPassthrough(['shell', 'input', 'keyevent', 'KEYCODE_MOVE_END'])
    await adbPassthrough(['shell', 'input', 'keyevent', ...Array<string>(40).fill('KEYCODE_DEL')])
    await adbPassthrough(['shell', 'input', 'text', query])
    await sleep(2)
    const xml = await snap(d, 'search-typed')
    const now = searchQuery(xml)
    if (now === query || now === undefined) return xml
    log(`search field reads ${JSON.stringify(now)}, retyping`)
  }
  throw new Error(`could not get ${JSON.stringify(query)} into the language search`)
}

/**
 * Find a row matching `lang.rows` in the list on screen, scrolling the list (never pressing Back, which
 * closes the search on Gboard v15 and drops back to the unfiltered list, as run 1 did for ar and vi).
 */
async function findRow(d: Device, lang: Lang, xml: string, name: string): Promise<{text: string; x: number; y: number}> {
  for (let i = 0; i < 40; i++) {
    const row = pickRow(titles(xml), lang.rows)
    if (row) return row
    if (!(await d.find({scrollable: true}).exists())) break
    const before = JSON.stringify(titles(xml).map((t) => t.text))
    await scrollList(d, xml)
    xml = await d.dumpHierarchy()
    writeFile(`${out}/${code}-setup-${name}-scroll-${String(i + 1).padStart(2, '0')}.xml`, xml)
    // The end of the list: a scroll that changes nothing.
    if (JSON.stringify(titles(xml).map((t) => t.text)) === before) break
  }
  log(`rows ${JSON.stringify(titles(xml).map((t) => t.text).slice(0, 20))}`)
  await snap(d, `missing-${name}`)
  throw new Error(`no row matching ${lang.rows.join(' or ')} on the ${name} screen`)
}

async function addLanguage(d: Device, lang: Lang): Promise<void> {
  await tapText(d, '^Languages$', 'languages')
  await tapText(d, '^Add keyboard$', 'add-keyboard')
  const search = await languageSearch(d)
  let xml = await typeQuery(d, search, lang.search)
  log(`rows ${JSON.stringify(titles(xml).map((t) => t.text).slice(0, 20))}`)
  let row = await findRow(d, lang, xml, 'search')
  // A language with regional or script variants opens a list of them instead of its layout page. Tap the
  // best variant until the layout page (its Navigate up and layout tiles) shows, two levels at most.
  for (let level = 0; level < 3; level++) {
    log(`tapping row ${JSON.stringify(row.text)}`)
    await d.click(row.x, row.y)
    await sleep(2)
    xml = await snap(d, level ? `variant-${level}` : 'language')
    if (layoutTiles(xml).length) break
    // Still on the search screen: the tap missed the row, so find it again rather than go a level down.
    if (searchQuery(xml) !== undefined) {
      log(`tap missed ${JSON.stringify(row.text)}, query ${JSON.stringify(searchQuery(xml))}`)
      if (searchQuery(xml) !== lang.search) xml = await typeQuery(d, search, lang.search)
      row = await findRow(d, lang, xml, 'search')
      continue
    }
    if (!titles(xml).length) throw new Error(`neither layout tiles nor variant rows after tapping ${JSON.stringify(row.text)}`)
    log(`variants ${JSON.stringify(titles(xml).map((t) => t.text).slice(0, 20))}`)
    row = await findRow(d, lang, xml, 'variants')
  }
  if (!layoutTiles(xml).length) throw new Error('never reached the layout page')
  await pickLayout(d, lang, xml)
  if (!(await d.find({textMatches: '(?i)^(Done|Add)$'}).exists())) {
    await snap(d, 'missing-done')
    throw new Error('no Done button on the layout page')
  }
  await tapText(d, '^(Done|Add)$', 'done')
}

/**
 * Leave the wanted layout as the only one selected, as setup-ja.ts does for QWERTY. A missing tile keeps
 * Gboard's default layout, and the log lists the tiles so the pattern can be fixed.
 */
async function pickLayout(d: Device, lang: Lang, xml: string): Promise<void> {
  log(`tiles ${layoutTiles(xml).map((t) => `${t.desc}${t.selected ? '[x]' : '[ ]'}`).join(' | ')}`)
  if (!lang.layout) return
  const want = lang.layout
  for (let i = 0; i < 3; i++) {
    const all = layoutTiles(xml)
    const target = all.find((t) => want.test(t.desc))
    if (!target) {
      log(`layout tile ${want} missing, keeping the default layout`)
      return
    }
    const wrong = all.filter((t) => t.selected && !want.test(t.desc))
    if (target.selected && !wrong.length) {
      log(`layout ${JSON.stringify(target.desc)} is the only one selected`)
      await snap(d, 'layouts')
      return
    }
    // Select the wanted tile first, so Gboard never sees a language without layouts.
    if (!target.selected) await d.click(target.x, target.y)
    else for (const t of wrong) await d.click(t.x, t.y)
    await sleep(1)
    xml = await d.dumpHierarchy()
  }
  await snap(d, 'layouts-unsettled')
  log('layout selection did not settle, see the screenshot')
}

/** Watch the Languages screen for a download or install note and log each state until it clears. */
async function waitForDownload(d: Device): Promise<void> {
  let quiet = 0
  let last = ''
  for (let i = 0; i < 30 && quiet < 3; i++) {
    const states = downloadStates(await d.dumpHierarchy())
    const now = JSON.stringify(states)
    if (now !== last) log(`download state +${i * 3}s ${now}`)
    last = now
    quiet = states.length ? 0 : quiet + 1
    await sleep(3)
  }
  log(`download state final ${last}`)
}

/** Settings > Glide typing > gesture cursor control, switched on. Logs whether the setting exists. */
async function enableCursorControl(d: Device): Promise<void> {
  await openSettings(d)
  const glide = d.find({textMatches: '(?i)^Glide typing$'})
  await scrollTo(d, glide)
  if (!(await glide.exists())) {
    await snap(d, 'missing-glide-typing')
    log('CURSOR_CONTROL setting=absent reason="no Glide typing screen"')
    return
  }
  await glide.click()
  await sleep(1.5)
  const sel = d.find({textMatches: '(?i).*cursor control.*'})
  await scrollTo(d, sel, 4)
  const xml = await snap(d, 'glide-typing')
  const row = switchRow(xml, /cursor control/i)
  if (!row) {
    log(`CURSOR_CONTROL setting=absent reason="no cursor control row" texts=${JSON.stringify(parseXml(xml).map((n) => n.attrs.text).filter(Boolean))}`)
    return
  }
  if (row.checked !== true) {
    await d.click(row.x, row.y)
    await sleep(1)
  }
  const after = switchRow(await snap(d, 'cursor-control'), /cursor control/i)
  log(`CURSOR_CONTROL setting=present title=${JSON.stringify(row.title)} before=${row.checked} after=${after?.checked}`)
}

async function main(): Promise<void> {
  const lang = LANGS[code]
  if (!lang) throw new Error(`unknown language ${code}, expected one of ${Object.keys(LANGS).join(' ')}`)
  const d = await Device.connect()
  if (code !== 'en') {
    await openSettings(d)
    await addLanguage(d, lang)
    await waitForDownload(d)
  }
  await enableCursorControl(d)

  const ims = await adbOutput(['shell', 'dumpsys', 'input_method'])
  writeFile(`${out}/${code}-ims.txt`, ims)
  const enabled = await adbOutput(['shell', 'settings', 'get', 'secure', 'enabled_input_methods'])
  const subtypes = enabledLocales(enabled, ims)
  log(`enabled gboard subtypes ${JSON.stringify(enabledSubtypes(enabled, LATIN_IME))} raw=${enabled.trim()}`)
  // probe.ts reads this line to select the subtype directly.
  console.log(subtypesLine(subtypes))
  await adbPassthrough(['shell', 'input', 'keyevent', 'KEYCODE_HOME'])
  // Run 1 added ar and hi without a subtype and still said done. Say so instead.
  if (code !== 'en' && !subtypes.some((s) => s.locale !== undefined && localeMatches(s.locale, code))) {
    log(`SUBTYPE_MISSING no enabled Gboard subtype for ${code}`)
    throw new Error(`no enabled Gboard subtype for ${code} after setup`)
  }
  log('done')
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
    process.exit(1)
  },
)
