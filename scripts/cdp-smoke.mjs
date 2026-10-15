import {chromium, devices} from 'playwright-core'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
const root = process.argv[2]
const server = http.createServer((req, res) => {
  const p = path.join(root, new URL(req.url, 'http://x').pathname)
  if (!fs.existsSync(p)) { res.writeHead(404); return res.end() }
  res.writeHead(200, {'content-type': p.endsWith('.js') ? 'text/javascript' : 'text/html'})
  fs.createReadStream(p).pipe(res)
}).listen(8765)
const browser = await chromium.launch({executablePath: '/workspace/home/pw-browsers/chromium-1234/chrome-linux64/chrome'})
for (const [ua, name] of [[devices['Pixel 7'], 'android'], [{}, 'desktop']]) {
  for (const prefix of ['', 'x']) {
    const ctx = await browser.newContext(ua)
    const page = await ctx.newPage()
    await page.goto(`http://localhost:8765/editor.html?prefix=${prefix}`)
    await page.locator('[contenteditable]').click()
    await page.keyboard.press('End')
    const cdp = await ctx.newCDPSession(page)
    for (const text of ['き', 'きょ', 'きょう']) {
      await cdp.send('Input.imeSetComposition', {text, selectionStart: text.length, selectionEnd: text.length})
      await page.waitForTimeout(50)
    }
    await cdp.send('Input.insertText', {text: '今日'})
    await page.waitForTimeout(300)
    const s = await page.evaluate(() => window.__state())
    console.log(name, JSON.stringify(prefix), '->', JSON.stringify(s.text), 'compositionstart x', s.events.filter(e => e.type === 'compositionstart').length)
    await ctx.close()
  }
}
await browser.close(); server.close()
