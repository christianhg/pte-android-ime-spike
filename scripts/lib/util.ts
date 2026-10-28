// Small helpers shared by the driver scripts. Formatting mirrors Python so log lines stay comparable with
// runs of the Python driver.

const T0 = Date.now()

export function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000))
}

export function phase(msg: string): void {
  const elapsed = ((Date.now() - T0) / 1000).toFixed(1).padStart(5)
  console.log(`PHASE +${elapsed}s ${msg}`)
}

// The call the driver is blocked on, so the watchdog can say where a hang sits.
let inFlight = ''

export async function tracked<T>(label: string, run: () => Promise<T>): Promise<T> {
  const previous = inFlight
  inFlight = label
  try {
    return await run()
  } finally {
    inFlight = previous
  }
}

/** Log what the driver is waiting on shortly before the shell's timeout kills it. */
export function watchdog(seconds: number): void {
  setTimeout(() => phase(`WATCHDOG still running after ${seconds}s, waiting on: ${inFlight || 'nothing tracked'}`), seconds * 1000).unref()
}

/** Python's sorted() order for strings: by code point, not by UTF-16 unit. */
export function pySorted(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => {
    const ca = [...a]
    const cb = [...b]
    for (let i = 0; i < Math.min(ca.length, cb.length); i++) {
      const d = ca[i]!.codePointAt(0)! - cb[i]!.codePointAt(0)!
      if (d !== 0) return d
    }
    return ca.length - cb.length
  })
}

/** Python's len() for a string, in code points. */
export function pyLen(value: string): number {
  return [...value].length
}

// Characters Python's str.isprintable() rejects, apart from the plain space.
const NON_PRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u

function reprString(value: string): string {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'"
  let out = quote
  for (const ch of value) {
    if (ch === quote || ch === '\\') out += '\\' + ch
    else if (ch === '\n') out += '\\n'
    else if (ch === '\r') out += '\\r'
    else if (ch === '\t') out += '\\t'
    else if (ch !== ' ' && NON_PRINTABLE.test(ch)) {
      const cp = ch.codePointAt(0)!
      if (cp < 0x100) out += '\\x' + cp.toString(16).padStart(2, '0')
      else if (cp < 0x10000) out += '\\u' + cp.toString(16).padStart(4, '0')
      else out += '\\U' + cp.toString(16).padStart(8, '0')
    } else out += ch
  }
  return out + quote
}

/** Python's repr() for the JSON-like values the driver logs. */
export function pyRepr(value: unknown): string {
  if (value === null || value === undefined) return 'None'
  if (typeof value === 'string') return reprString(value)
  if (typeof value === 'boolean') return value ? 'True' : 'False'
  if (typeof value === 'number') return String(value)
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(', ')}]`
  if (typeof value === 'object') {
    return `{${Object.entries(value).map(([k, v]) => `${reprString(k)}: ${pyRepr(v)}`).join(', ')}}`
  }
  return String(value)
}

/** Python's str(): strings as they are, everything else as repr(). */
export function pyStr(value: unknown): string {
  return typeof value === 'string' ? value : pyRepr(value)
}

export function errorRepr(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? ` (${error.cause.name}: ${error.cause.message})` : ''
    return `${error.name}: ${error.message}${cause}`
  }
  return String(error)
}
