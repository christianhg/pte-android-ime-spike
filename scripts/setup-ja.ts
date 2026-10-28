// Add the Japanese QWERTY (romaji) layout to Gboard through its settings UI.
//
// Play images have no root, so the locale route is closed. Every step dumps the screen to out/ja-setup-*.
//
// Usage: node scripts/setup-ja.ts <outdir>

import {writeFileSync} from 'node:fs'
import {adbOutput, adbPassthrough} from './lib/adb.ts'
import {Device, type UiObject} from './lib/u2.ts'
import {pySorted, sleep} from './lib/util.ts'

const GBOARD = 'com.google.android.inputmethod.latin'
const out = process.argv[2]!
let step = 0

function log(line: string): void {
  console.log(line)
}

async function snap(d: Device, name: string): Promise<void> {
  step += 1
  const base = `${out}/ja-setup-${String(step).padStart(2, '0')}-${name}`
  writeFileSync(`${base}.xml`, await d.dumpHierarchy())
  await d.screenshot(base)
  log(`JA_SETUP step ${step} ${name}`)
}

async function tapText(d: Device, pattern: string, name: string, scroll = false): Promise<void> {
  const sel = d.find({textMatches: `(?i)${pattern}`})
  if (!(await sel.exists()) && scroll && (await d.find({scrollable: true}).exists())) {
    for (let i = 0; i < 12; i++) {
      await d.find({scrollable: true}).scrollForward(30)
      if (await sel.exists()) break
    }
  }
  if (!(await sel.wait(15))) {
    await snap(d, `missing-${name}`)
    throw new Error(`no node matching ${JSON.stringify(pattern)} for ${name}`)
  }
  await sel.click()
  await sleep(1.5)
  await snap(d, name)
}

// Gboard preselects 12 keys (kana flick) and opens on it, so keep QWERTY (romaji) as the only layout.
// Gboard v12 labels the tiles in English, v15 in Japanese (12 キー, 手書き).
const TWELVE = '^12 (keys|キー)$'
const QWERTY = '^QWERTY$'
const HANDWRITING = '^(Handwriting|手書き)$'

async function main(): Promise<void> {
  const d = await Device.connect()
  await adbPassthrough(['shell', 'am', 'start', '-n', `${GBOARD}/com.google.android.apps.inputmethod.latin.preference.SettingsActivity`])
  await sleep(4)
  await snap(d, 'settings')
  await tapText(d, '^Languages$', 'languages')
  await tapText(d, '^Add keyboard$', 'add-keyboard')
  // The list holds hundreds of languages. Use its search instead of scrolling.
  // The same Gboard build shows one of two screens: a search button that opens an AutoCompleteTextView
  // (search_src_text), or an inline EditText with the hint "Search language".
  const inline = d.find({className: 'android.widget.EditText', text: 'Search language'})
  const button = d.find({description: 'Search for a language'})
  let search: UiObject
  if (await inline.exists()) {
    search = inline
  } else {
    if (!(await button.wait(8))) {
      await snap(d, 'missing-search-button')
      throw new Error('no language search on the Add keyboard screen')
    }
    await button.click()
    await sleep(1.5)
    search = d.find({resourceId: `${GBOARD}:id/search_src_text`})
    if (!(await search.wait(8))) {
      await snap(d, 'missing-search-field')
      throw new Error('no search field after tapping Search for a language')
    }
  }
  await search.click()
  await adbPassthrough(['shell', 'input', 'text', 'Japanese'])
  await sleep(2)
  await snap(d, 'search-typed')
  // Gboard v12 keeps the query when Back hides the keyboard. Gboard v15 closes the search on Back and
  // shows the full list again, so only press Back when the result row is hidden under the keyboard.
  const row = d.find({resourceId: 'android:id/title', textMatches: '^(Japanese|日本語)$'})
  if (!(await row.exists())) {
    await adbPassthrough(['shell', 'input', 'keyevent', 'KEYCODE_BACK'])
    await sleep(1)
  }
  await snap(d, 'search')
  // The search field also reads "Japanese", so tap the result row (android:id/title) instead.
  if (!(await row.exists()) && (await d.find({scrollable: true}).exists())) {
    // Fall back to the alphabetical All languages list.
    for (let i = 0; i < 60; i++) {
      if (await row.exists()) break
      await d.find({scrollable: true}).scrollForward(20)
    }
  }
  if (!(await row.wait(15))) {
    await snap(d, 'missing-japanese-row')
    throw new Error('no Japanese row in the search results')
  }
  await row.click()
  await sleep(2)
  await snap(d, 'japanese')

  const tile = (pattern: string) => d.find({descriptionMatches: pattern})
  const layoutSelected = async (pattern: string) => (await tile(pattern).exists()) && Boolean((await tile(pattern).info()).selected)

  for (const [pattern, want] of [[QWERTY, true], [TWELVE, false], [HANDWRITING, false]] as const) {
    // A tap sometimes does not take, so check the tile state and tap again.
    for (let i = 0; i < 3; i++) {
      if (!(await tile(pattern).exists()) || (await layoutSelected(pattern)) === want) break
      await tile(pattern).click()
      await sleep(1)
    }
  }
  if (!(await tile(TWELVE).exists())) {
    await snap(d, 'layouts-unknown')
    throw new Error('no 12 keys tile, the layout labels changed')
  }
  if (!(await layoutSelected(QWERTY)) || (await layoutSelected(TWELVE))) {
    await snap(d, 'layouts-wrong')
    throw new Error('could not leave QWERTY as the only Japanese layout')
  }
  await snap(d, 'layouts')
  await tapText(d, '^(Done|Add)$', 'done')
  const subtypes = await adbOutput(['shell', 'dumpsys', 'input_method'])
  log('JA_SETUP subtypes: ' + pySorted(new Set(subtypes.match(/mSubtypeName=[^ }]+|locale=[\p{L}\p{N}\p{Mn}\p{Pc}]+/gu) ?? [])).join(' | '))
  await adbPassthrough(['shell', 'input', 'keyevent', 'KEYCODE_HOME'])
  log('JA_SETUP done')
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
    process.exit(1)
  },
)
