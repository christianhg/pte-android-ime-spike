// Type on the iOS Simulator's software keyboard in Mobile Safari by tapping its keys natively, then
// read what the page ended up with.
// Usage: node ios/drive.ts <page> <prefix> <en|ja> <out> <case>
// Cases: kyou (two words, space or 今日 candidate), autocorrect (teh + space), edit (ab, delete, return, c)
import {mkdirSync, writeFileSync} from 'node:fs'
import {remote} from 'webdriverio'

const [page, prefix, lang, out, caseName] = process.argv.slice(2) as [string, string, 'en' | 'ja', string, string]
mkdirSync(out, {recursive: true})
const tag = `${lang}-${caseName}-${page.replace('.html', '')}-${prefix || 'empty'}`
const t0 = Date.now()
const phase = (msg: string) => console.log(`PHASE +${((Date.now() - t0) / 1000).toFixed(1)}s ${tag} ${msg}`)

const browser = await remote({
  hostname: '127.0.0.1',
  port: 4723,
  logLevel: 'warn',
  connectionRetryTimeout: 900_000,
  capabilities: {
    platformName: 'iOS',
    browserName: 'Safari',
    'appium:automationName': 'XCUITest',
    'appium:udid': process.env.UDID,
    'appium:platformVersion': process.env.IOS_VERSION,
    'appium:nativeWebTap': true,
    'appium:connectHardwareKeyboard': false,
    'appium:keyboardAutocorrection': true,
    'appium:keyboardPrediction': true,
    'appium:wdaLaunchTimeout': 900_000,
    'appium:newCommandTimeout': 300,
    'appium:safariIgnoreFraudWarning': true,
  } as WebdriverIO.Capabilities,
})
phase('session')

let webContext = ''
async function native() {
  await browser.switchContext('NATIVE_APP')
}
async function web() {
  if (!webContext) {
    const contexts = (await browser.getContexts()) as Array<string | {id: string}>
    const ids = contexts.map((c) => (typeof c === 'string' ? c : c.id))
    webContext = ids.find((id) => id.startsWith('WEBVIEW')) ?? ''
  }
  await browser.switchContext(webContext)
}
const shots: string[] = []
async function snapshot(name: string) {
  await native()
  writeFileSync(`${out}/${tag}-${name}.xml`, await browser.getPageSource())
  await browser.saveScreenshot(`${out}/${tag}-${name}.png`)
  shots.push(name)
}
async function keyNames(): Promise<string[]> {
  await native()
  const keys = await browser.$$('-ios predicate string:type == "XCUIElementTypeKey" AND visible == 1')
  const names: string[] = []
  for (const key of keys) names.push(await key.getAttribute('name'))
  return names
}
/** Tap a keyboard key or keyboard button (shift, return and the globe are buttons, letters are keys). */
async function tap(name: string) {
  await native()
  const el = browser.$(
    `-ios predicate string:(type == "XCUIElementTypeKey" OR type == "XCUIElementTypeButton") AND name ==[c] "${name}"`,
  )
  await el.waitForExist({timeout: 5000})
  await el.click()
}
/** Tap whatever element is labelled `label` outside the keys, e.g. a candidate or a suggestion. */
async function tapLabel(label: string): Promise<boolean> {
  await native()
  const el = browser.$(`-ios predicate string:(label == "${label}" OR name == "${label}") AND type != "XCUIElementTypeKey"`)
  if (!(await el.isExisting())) return false
  await el.click()
  return true
}
async function state() {
  await web()
  return (await browser.execute(() => (window as any).__state())) as {text: string; events: unknown[]}
}
async function typeLetters(word: string) {
  for (const letter of word) await tap(letter)
}

const result: Record<string, unknown> = {tag, page, prefix, lang, caseName}
const steps: Array<Record<string, unknown>> = []
let failed = false
try {
  await web()
  await browser.url(`http://localhost:8765/${page}?prefix=${encodeURIComponent(prefix)}`)
  await browser.$('[contenteditable]').waitForExist({timeout: 20_000})
  phase('page loaded')
  // nativeWebTap turns this click into a real tap, which raises the software keyboard.
  await browser.$('[contenteditable]').click()
  await native()
  const keyboard = browser.$('//XCUIElementTypeKeyboard')
  try {
    await keyboard.waitForExist({timeout: 15_000})
  } catch {
    phase('no keyboard after web tap, tapping the text view natively')
    await browser.$('//XCUIElementTypeWebView//XCUIElementTypeTextView').click()
    await keyboard.waitForExist({timeout: 15_000})
  }
  phase('keyboard shown')
  let keys = await keyNames()
  result.initialKeys = keys
  if (lang === 'ja') {
    // The globe ("Next keyboard") is a button in the bar under the keys. Cycle until the space key's
    // label changes from the English one.
    const spaceLabel = async () => {
      await native()
      return browser.$('-ios predicate string:type == "XCUIElementTypeKey" AND name == "space"').getAttribute('label')
    }
    const english = await spaceLabel()
    for (let i = 0; i < 3 && (await spaceLabel()) === english; i++) await tap('Next keyboard')
    result.spaceLabel = await spaceLabel()
    result.jaKeys = await keyNames()
    phase(`keyboard switched, space label ${JSON.stringify(result.spaceLabel)}`)
  }
  await snapshot('keyboard')

  if (caseName === 'kyou') {
    for (const i of [1, 2]) {
      await typeLetters('kyou')
      await snapshot(`word${i}`)
      if (lang === 'ja') {
        const picked = await tapLabel('今日')
        steps.push({word: i, candidate: '今日', picked})
        if (!picked) {
          // Fall back to the conversion key, then confirm with return.
          await tap('space')
          await snapshot(`word${i}-convert`)
          await tap('Return')
        }
      } else {
        await tap('space')
      }
      steps.push({after: `word ${i}`, text: (await state()).text})
    }
  } else if (caseName === 'autocorrect') {
    await typeLetters('teh')
    await snapshot('typed')
    await tap('space')
    steps.push({after: 'teh space', text: (await state()).text})
    await typeLetters('cat')
    await tap('space')
  } else if (caseName === 'edit') {
    await typeLetters('ab')
    await tap('delete')
    steps.push({after: 'ab delete', text: (await state()).text})
    await tap('Return')
    steps.push({after: 'return', text: (await state()).text})
    await typeLetters('c')
  }
  const final = await state()
  result.text = final.text
  result.events = final.events
  result.steps = steps
  await snapshot('final')
  phase(`RESULT ${JSON.stringify(final.text)}`)
} catch (error) {
  failed = true
  result.error = String(error)
  result.steps = steps
  phase(`ERROR ${String(error).split('\n')[0]}`)
  try {
    await snapshot('error')
  } catch {}
} finally {
  result.seconds = (Date.now() - t0) / 1000
  writeFileSync(`${out}/${tag}.json`, JSON.stringify(result, null, 2))
  await browser.deleteSession().catch(() => {})
}
process.exit(failed ? 1 : 0)
