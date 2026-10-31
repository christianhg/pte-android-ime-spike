// Add one Gboard language and layout through its settings screens, the way setup-ja.ts adds Japanese, and
// turn on gesture cursor control for the space bar drag. English needs no language, only the setting.
//
// Every step dumps the screen to out/<lang>-setup-*. Lines start with SETUP so the log greps well.
//
// Usage: node scripts/setup-lang.ts <lang> <outdir>

import {writeFileSync} from 'node:fs'
import {adbOutput, adbPassthrough} from './lib/adb.ts'
import {downloadStates, enabledSubtypes, GBOARD, LANGS, subtypeTokens, type Lang} from './lib/gboard.ts'
import {center, parseBounds, parseXml, switchRow} from './lib/hierarchy.ts'
import {Device, type UiObject} from './lib/u2.ts'
import {sleep} from './lib/util.ts'

const [code, out] = process.argv.slice(2) as [string, string]
let step = 0

function log(line: string): void {
  console.log(`SETUP ${code} ${line}`)
}

async function snap(d: Device, name: string): Promise<string> {
  step += 1
  const base = `${out}/${code}-setup-${String(step).padStart(2, '0')}-${name}`
  const xml = await d.dumpHierarchy()
  writeFileSync(`${base}.xml`, xml)
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
function titles(xml: string): Array<{text: string; x: number; y: number}> {
  return parseXml(xml)
    .filter((n) => n.attrs['resource-id'] === 'android:id/title' && n.attrs.text)
    .map((n) => {
      const [x, y] = center(parseBounds(n.attrs.bounds!))
      return {text: n.attrs.text!, x, y}
    })
}

async function addLanguage(d: Device, lang: Lang): Promise<void> {
  await tapText(d, '^Languages$', 'languages')
  await tapText(d, '^Add keyboard$', 'add-keyboard')
  const search = await languageSearch(d)
  await search.click()
  await adbPassthrough(['shell', 'input', 'text', lang.search])
  await sleep(2)
  let xml = await snap(d, 'search-typed')
  // Gboard v12 keeps the query when Back hides the keyboard, v15 closes the search, so only press Back
  // when no result row shows.
  if (!titles(xml).some((t) => lang.row.test(t.text))) {
    await adbPassthrough(['shell', 'input', 'keyevent', 'KEYCODE_BACK'])
    await sleep(1)
    xml = await snap(d, 'search')
  }
  for (let i = 0; i < 60 && !titles(xml).some((t) => lang.row.test(t.text)); i++) {
    // Fall back to the alphabetical All languages list.
    if (!(await d.find({scrollable: true}).exists())) break
    await d.find({scrollable: true}).scrollForward(20)
    xml = await d.dumpHierarchy()
  }
  const row = titles(xml).find((t) => lang.row.test(t.text))
  log(`rows ${JSON.stringify(titles(xml).map((t) => t.text).slice(0, 20))}`)
  if (!row) {
    await snap(d, 'missing-row')
    throw new Error(`no row matching ${lang.row} in the search results`)
  }
  log(`tapping row ${JSON.stringify(row.text)}`)
  await d.click(row.x, row.y)
  await sleep(2)
  xml = await snap(d, 'language')
  await pickLayout(d, lang, xml)
  if (await d.find({textMatches: '(?i)^(Done|Add)$'}).exists()) await tapText(d, '^(Done|Add)$', 'done')
  else log('no Done button, the language was added without a layout screen')
}

type Tile = {desc: string; selected: boolean; x: number; y: number; parent: number}

function tiles(xml: string): Tile[] {
  return parseXml(xml)
    .filter((n) => n.attrs.package === GBOARD && n.attrs['content-desc'])
    .map((n) => {
      const [x, y] = center(parseBounds(n.attrs.bounds!))
      return {desc: n.attrs['content-desc']!, selected: n.attrs.selected === 'true', x, y, parent: n.parent}
    })
}

/**
 * Leave the wanted layout as the only one selected, as setup-ja.ts does for QWERTY. The other tiles are
 * the wanted tile's siblings. A missing tile keeps Gboard's default layout, and the log lists the tiles so
 * the pattern can be fixed in the next round.
 */
async function pickLayout(d: Device, lang: Lang, xml: string): Promise<void> {
  log(`tiles ${tiles(xml).map((t) => `${t.desc}${t.selected ? '[x]' : '[ ]'}`).join(' | ')}`)
  if (!lang.layout) return
  const want = lang.layout
  for (let i = 0; i < 3; i++) {
    const all = tiles(xml)
    const target = all.find((t) => want.test(t.desc))
    if (!target) {
      log(`layout tile ${want} missing, keeping the default layout`)
      return
    }
    const wrong = all.filter((t) => t.parent === target.parent && t.selected && !want.test(t.desc))
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
  writeFileSync(`${out}/${code}-ims.txt`, ims)
  log(`subtypes ${subtypeTokens(ims).join(' | ')}`)
  const enabled = await adbOutput(['shell', 'settings', 'get', 'secure', 'enabled_input_methods'])
  log(`enabled gboard subtypes ${JSON.stringify(enabledSubtypes(enabled, `${GBOARD}/com.android.inputmethod.latin.LatinIME`))} raw=${enabled.trim()}`)
  await adbPassthrough(['shell', 'input', 'keyevent', 'KEYCODE_HOME'])
  log('done')
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
    process.exit(1)
  },
)
