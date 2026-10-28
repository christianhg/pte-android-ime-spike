// Chrome DevTools protocol over `adb forward`: the target list through fetch, one Runtime.evaluate per
// connection through the global WebSocket.

import {adb} from './adb.ts'
import {errorRepr, phase, sleep, tracked} from './util.ts'

export const CDP_PORT = 9222

/** No page target matches the current URL. Not retried, like the StopIteration it replaces. */
export class NoTargetError extends Error {
  override name = 'StopIteration'
}

/** The page answered with a protocol error. Not retried, like the KeyError it replaces. */
export class ProtocolError extends Error {
  override name = 'ProtocolError'
}

export class WebSocketError extends Error {
  override name = 'WebSocketError'
}

/** The target list did not answer in time, like requests' ReadTimeout. */
export class ReadTimeout extends Error {
  override name = 'ReadTimeout'
}

export type Target = {type?: string; url?: string; attached?: boolean; webSocketDebuggerUrl?: string}

/** The DevTools target list. 127.0.0.1, because adb forward listens on IPv4 only. */
export async function targets(timeout: number): Promise<Target[]> {
  try {
    const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json`, {signal: AbortSignal.timeout(timeout * 1000)})
    return (await response.json()) as Target[]
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') throw new ReadTimeout(`no answer from the target list in ${timeout}s`, {cause: error})
    throw error
  }
}

let currentUrl = ''

export function setCurrentUrl(url: string): void {
  currentUrl = url
}

/** Evaluate in the page. Chrome's DevTools socket sometimes drops a connection, so retry on a fresh one. */
export async function cdpEval(expression: string): Promise<unknown> {
  let last: unknown
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await tracked(`cdp ${expression.slice(0, 40)}`, () => cdpEvalOnce(expression))
    } catch (error) {
      // The Python driver retried every requests, websocket and OS error, which covers timeouts and a target
      // list that is not JSON. A missing target or a protocol error failed at once.
      if (error instanceof NoTargetError || error instanceof ProtocolError) throw error
      last = error
      phase(`cdp dropped (${attempt + 1}): ${errorRepr(error)}, retrying`)
      await sleep(1.5)
      try {
        await adb(['forward', `tcp:${CDP_PORT}`, 'localabstract:chrome_devtools_remote'])
      } catch {}
    }
  }
  throw last
}

async function cdpEvalOnce(expression: string): Promise<unknown> {
  const page = (await targets(10)).find((t) => t.type === 'page' && (t.url ?? '').startsWith(currentUrl))
  if (!page?.webSocketDebuggerUrl) throw new NoTargetError(`no page target for ${currentUrl}`)
  // Chrome names itself localhost in the socket URL. Keep the path and talk to the forwarded IPv4 port.
  const url = new URL(page.webSocketDebuggerUrl)
  url.host = `127.0.0.1:${CDP_PORT}`
  // The global WebSocket sends no Origin header, so Chrome accepts it without --remote-allow-origins.
  const ws = new WebSocket(url)
  return await new Promise<unknown>((resolve, reject) => {
    let settled = false
    const finish = (error: Error | undefined, value?: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      ws.close()
      if (error) reject(error)
      else resolve(value)
    }
    const timer = setTimeout(() => finish(new WebSocketError('timed out after 10s')), 10_000)
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({id: 1, method: 'Runtime.evaluate', params: {expression, returnByValue: true}}))
    })
    ws.addEventListener('message', (event) => {
      let msg: {id?: number; result?: {result?: {value?: unknown}}; error?: unknown}
      try {
        msg = JSON.parse(String(event.data))
      } catch (error) {
        finish(new WebSocketError(`bad frame: ${errorRepr(error)}`))
        return
      }
      if (msg.id !== 1) return
      if (!msg.result?.result) finish(new ProtocolError(JSON.stringify(msg.error ?? msg)))
      else finish(undefined, msg.result.result.value)
    })
    ws.addEventListener('error', () => finish(new WebSocketError('connection error')))
    ws.addEventListener('close', (event) => finish(new WebSocketError(`closed before a reply, code ${event.code}`)))
  })
}
