// Type on the iOS Simulator's software keyboard in Mobile Safari by tapping its keys natively, then
// read what the page ended up with.
// Usage: node ios/drive.ts <page> <prefix> <en|ja> <out> <case>
// Cases: kyou (two words, space or 今日 candidate), autocorrect (teh + space), edit (ab, delete, return, c)
import {mkdirSync, writeFileSync} from 'node:fs'
import {remote} from 'webdriverio'

const [page, prefix, lang, out, caseName] = process.argv.slice(2) as [string, string, 'en' | 'ja', string, string]
mkdirSync(out, {recursive: true})
const tag = `${lang}-${caseName}-${page.replace('.html', '').replace(/[?=&/]/g, '-')}-${prefix || 'empty'}`
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
  const el = browser.$(`-ios predicate string:(type == "XCUIElementTypeCell" OR type == "XCUIElementTypeMenuItem") AND name == "${label}"`)
  if (!(await el.isExisting())) return false
  await el.click()
  return true
}
async function state() {
  await web()
  return (await browser.execute(() => (window as any).__state())) as {text: string; events: unknown[]}
}
async function typeLetters(word: string) {
  // Only English: a composing Japanese field may not report the text until conversion.
  if (lang === 'ja') {
    for (const letter of word) await tap(letter)
    return
  }
  const before = (await state()).text.length
  await tap(word[0]!)
  // The page can lag the tap, so give it a second before calling the tap dropped.
  let landed = false
  for (let i = 0; i < 5 && !landed; i++) {
    await browser.pause(200)
    landed = (await state()).text.length > before
  }
  if (!landed) {
    result.droppedFirstTap = ((result.droppedFirstTap as number) ?? 0) + 1
    phase(`DROPPED first tap of ${word}, tapping again`)
    await tap(word[0]!)
  }
  for (const letter of word.slice(1)) await tap(letter)
}

const result: Record<string, unknown> = {tag, page, prefix, lang, caseName}
const steps: Array<Record<string, unknown>> = []
let failed = false
try {
  await web()
  await browser.url(`http://localhost:8765/${page}${page.includes("?") ? "&" : "?"}prefix=${encodeURIComponent(prefix)}`)
  await browser.$('[contenteditable="true"]').waitForExist({timeout: 20_000})
  phase('page loaded')
  // nativeWebTap turns this click into a real tap, which raises the software keyboard.
  await browser.$('[contenteditable="true"]').click()
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
    // The simulator opens on English even when Japanese is listed first. Tap the globe ("Next
    // keyboard", a button under the keys) until the delete key is labelled 削除.
    const deleteLabel = async () => {
      await native()
      return browser.$('-ios predicate string:type == "XCUIElementTypeKey" AND name == "delete"').getAttribute('label')
    }
    let label = await deleteLabel()
    for (let i = 0; i < 3 && label !== '削除'; i++) {
      await tap('Next keyboard')
      label = await deleteLabel()
    }
    result.deleteLabel = label
    phase(`keyboard delete label ${JSON.stringify(label)}`)
    if (label !== '削除') throw new Error(`not the Japanese keyboard, delete is ${label}`)
  }
  // The keyboard drops taps that land before it has settled.
  await browser.pause(1500)
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
  } else if (caseName === 'actions') {
    // One run through the action list: type, select by long-press, paste from the callout,
    // background and return, then type again.
    const actions: Record<string, unknown> = {}
    result.actions = actions
    await typeLetters('hello')
    await tap('space')
    await typeLetters('world')
    actions.typed = (await state()).text
    await native()
    await browser.execute('mobile: setPasteboard', {content: 'pasted', encoding: 'utf8'})
    // Select the last word: double-tap it at its on-screen position, read from the page.
    await web()
    const box = (await browser.execute(() => {
      const field = document.querySelector('[contenteditable="true"]')!
      const walker = document.createTreeWalker(field, NodeFilter.SHOW_TEXT)
      let last: Text | null = null
      while (walker.nextNode()) if ((walker.currentNode as Text).data.includes('world')) last = walker.currentNode as Text
      if (!last) return null
      const range = document.createRange()
      const start = last.data.indexOf('world')
      range.setStart(last, start)
      range.setEnd(last, start + 5)
      const r = range.getBoundingClientRect()
      return {x: r.left + r.width / 2, y: r.top + r.height / 2, vv: visualViewport?.offsetTop ?? 0}
    })) as {x: number; y: number; vv: number} | null
    await native()
    const webView = browser.$('//XCUIElementTypeWebView')
    const wv = await browser.getElementRect(await webView.elementId)
    if (box) {
      await browser.execute('mobile: doubleTap', {x: wv.x + box.x, y: wv.y + box.y})
      await browser.pause(800)
    }
    actions.selectBox = box
    await snapshot('long-press')
    await web()
    actions.selection = await browser.execute(() => getSelection()?.toString())
    // Paste over the selection from the edit menu the double-tap raises.
    await native()
    const pasteShown = await tapLabel('Paste')
    if (!pasteShown) {
      await native()
      const paste = browser.$('-ios predicate string:(label == "Paste" OR name == "Paste") AND (type == "XCUIElementTypeMenuItem" OR type == "XCUIElementTypeButton")')
      if (await paste.isExisting()) {
        await paste.click()
        actions.paste = 'menu item'
      } else actions.paste = 'no Paste in the edit menu'
    }
    await browser.pause(1000)
    await snapshot('after-paste')
    actions.afterPaste = (await state()).text
    // Background Safari and come back.
    await native()
    await browser.execute('mobile: backgroundApp', {seconds: 2})
    await browser.pause(1500)
    await snapshot('after-background')
    actions.keyboardAfterBackground = await browser.$('//XCUIElementTypeKeyboard').isExisting()
    if (!actions.keyboardAfterBackground) {
      await web()
      await browser.$('[contenteditable="true"]').click()
      await native()
      await browser.$('//XCUIElementTypeKeyboard').waitForExist({timeout: 10_000})
    }
    await tap('space')
    await typeLetters('again')
    actions.afterBackground = (await state()).text
    // Shake to undo (iPhone has no undo key).
    await native()
    await browser.execute('mobile: shake').catch((e: unknown) => (actions.shake = String(e).split('\n')[0]))
    await browser.pause(1000)
    await snapshot('after-shake')
    const undo = browser.$('-ios predicate string:type == "XCUIElementTypeButton" AND label == "Undo"')
    actions.undoOffered = await undo.isExisting()
    if (actions.undoOffered) {
      await undo.click()
      await browser.pause(800)
    }
    actions.afterUndo = (await state()).text
    result.actions = actions
  } else if (caseName === 'interrupt') {
    // Tap outside the editor while a word is composing, then read what was committed.
    await typeLetters('kyou')
    await snapshot('composing')
    const before = await state()
    await web()
    await browser.$('#outside').click()
    await browser.pause(1000)
    const after = await state()
    steps.push({before: before.text, after: after.text})
    await snapshot('after-outside')
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
