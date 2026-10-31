// Type on the iOS Simulator's software keyboard in Mobile Safari by tapping its keys natively, then
// read what the page ended up with. Usage: node ios/drive.ts <page> <prefix> <en|ja> <out>
import {mkdirSync, writeFileSync} from 'node:fs'
import {remote} from 'webdriverio'

const [page, prefix, lang, out] = process.argv.slice(2) as [string, string, 'en' | 'ja', string]
mkdirSync(out, {recursive: true})
const tag = `${lang}-${page.replace('.html', '')}-${prefix || 'empty'}`
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
async function snapshot(name: string) {
  await native()
  writeFileSync(`${out}/${tag}-${name}.xml`, await browser.getPageSource())
  await browser.saveScreenshot(`${out}/${tag}-${name}.png`)
}
async function keyboardKeys(): Promise<string[]> {
  await native()
  const keys = await browser.$$('-ios predicate string:type == "XCUIElementTypeKey"')
  const names: string[] = []
  for (const key of keys) names.push(await key.getAttribute('name'))
  return names
}
async function tapKey(name: string) {
  await native()
  const key = browser.$(`-ios predicate string:type == "XCUIElementTypeKey" AND name ==[c] "${name}"`)
  await key.waitForExist({timeout: 5000})
  await key.click()
}
async function tapAny(name: string) {
  await native()
  const el = browser.$(`-ios predicate string:(label == "${name}" OR name == "${name}") AND type != "XCUIElementTypeKey"`)
  await el.waitForExist({timeout: 5000})
  await el.click()
}

const result: Record<string, unknown> = {tag, page, prefix, lang}
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
  let keys = await keyboardKeys()
  result.initialKeys = keys
  if (lang === 'ja') {
    // Cycle keyboards until the Japanese one shows. Its space key is not named "space".
    for (let i = 0; i < 4 && keys.some((k) => k.toLowerCase() === 'space'); i++) {
      await tapKey('Next keyboard')
      keys = await keyboardKeys()
    }
    result.jaKeys = keys
  }
  await snapshot('keyboard')
  const words = ['kyou', 'kyou']
  const suggestions: unknown[] = []
  for (const [i, word] of words.entries()) {
    for (const letter of word) await tapKey(letter)
    phase(`typed ${word} #${i + 1}`)
    await snapshot(`word${i + 1}`)
    if (lang === 'ja') {
      await tapAny('今日')
      phase(`picked 今日 #${i + 1}`)
    } else {
      await tapKey('space')
    }
    await web()
    suggestions.push(await browser.execute(() => (window as any).__state()))
  }
  await web()
  const state = (await browser.execute(() => (window as any).__state())) as {text: string; events: unknown[]}
  result.text = state.text
  result.state = state
  result.afterEachWord = suggestions
  await snapshot('final')
  phase(`RESULT ${JSON.stringify(state.text)}`)
} catch (error) {
  failed = true
  result.error = String(error)
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
