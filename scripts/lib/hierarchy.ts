// Parse uiautomator XML hierarchy dumps. A strict little parser for the dump's shape: nested elements
// with quoted attributes and the five XML entities. Malformed input throws, as ElementTree did.

/** `parent` is the index of the enclosing element in the list parseXml returns, -1 for the root. */
export type XmlNode = {tag: string; attrs: Record<string, string>; parent: number}

const ENTITIES: Record<string, string> = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'"}

// Literal tabs and newlines in an attribute value read as spaces, character references do not.
function unescape(value: string): string {
  return value.replace(/\r\n|[\t\n\r]/g, ' ').replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (whole, name: string) => {
    if (name.startsWith('#x')) return String.fromCodePoint(parseInt(name.slice(2), 16))
    if (name.startsWith('#')) return String.fromCodePoint(parseInt(name.slice(1), 10))
    const entity = ENTITIES[name]
    if (entity === undefined) throw new Error(`undefined entity ${whole}`)
    return entity
  })
}

/** Every element in document order. */
export function parseXml(xml: string): XmlNode[] {
  const nodes: XmlNode[] = []
  const stack: string[] = []
  const open: number[] = []
  let rootSeen = false
  const tag = /<(\?[\s\S]*?\?>|!--[\s\S]*?-->|\/([\w:.-]+)\s*>|([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>)/g
  let at = 0
  for (let m = tag.exec(xml); m; m = tag.exec(xml)) {
    if (xml.slice(at, m.index).includes('<')) throw new Error(`malformed XML near offset ${at}`)
    at = tag.lastIndex
    if (m[1]!.startsWith('?') || m[1]!.startsWith('!')) continue
    if (m[2]) {
      if (stack.pop() !== m[2]) throw new Error(`mismatched </${m[2]}> at offset ${m.index}`)
      open.pop()
      continue
    }
    if (stack.length === 0 && rootSeen) throw new Error('junk after document element')
    rootSeen = true
    const attrs: Record<string, string> = {}
    for (const a of m[4]!.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]!] = unescape(a[2] ?? a[3] ?? '')
    nodes.push({tag: m[3]!, attrs, parent: open.at(-1) ?? -1})
    if (!m[5]) {
      stack.push(m[3]!)
      open.push(nodes.length - 1)
    }
  }
  if (xml.slice(at).includes('<')) throw new Error(`malformed XML near offset ${at}`)
  if (!rootSeen) throw new Error('no element found')
  if (stack.length) throw new Error(`unclosed <${stack.at(-1)}>`)
  return nodes
}

/** Map of content-desc, or text when that is empty, to bounds center for every node of `pkg`. First wins. */
export function packageKeys(xml: string, pkg: string): Map<string, [number, number]> {
  const keys = new Map<string, [number, number]>()
  for (const node of parseXml(xml)) {
    if (node.tag !== 'node' || node.attrs.package !== pkg) continue
    const label = node.attrs['content-desc'] || node.attrs.text
    if (!label) continue
    const [l, t, r, b] = node.attrs.bounds!.replaceAll('][', ',').replace(/^[[\]]+|[[\]]+$/g, '').split(',').map((n) => {
      if (!/^\s*[+-]?\d+\s*$/.test(n)) throw new Error(`invalid bounds ${node.attrs.bounds}`)
      return Number(n)
    }) as [number, number, number, number]
    if (!keys.has(label)) keys.set(label, [Math.floor((l + r) / 2), Math.floor((t + b) / 2)])
  }
  return keys
}

export type Bounds = {left: number; top: number; right: number; bottom: number}

export function parseBounds(value: string): Bounds {
  const m = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(value)
  if (!m) throw new Error(`invalid bounds ${value}`)
  return {left: Number(m[1]), top: Number(m[2]), right: Number(m[3]), bottom: Number(m[4])}
}

export function center(b: Bounds): [number, number] {
  return [Math.floor((b.left + b.right) / 2), Math.floor((b.top + b.bottom) / 2)]
}

/**
 * A settings row with a switch, found by its title. The row is the nearest clickable ancestor of the
 * title, and the switch is the checkable node inside it. Undefined when no title matches.
 */
export function switchRow(xml: string, title: RegExp): {title: string; checked: boolean | undefined; x: number; y: number} | undefined {
  const nodes = parseXml(xml)
  const at = nodes.findIndex((n) => n.tag === 'node' && title.test(n.attrs.text ?? ''))
  if (at < 0) return undefined
  let row = at
  while (row >= 0 && nodes[row]!.attrs.clickable !== 'true') row = nodes[row]!.parent
  if (row < 0) row = at
  const inside = (i: number): boolean => {
    for (let p = i; p >= 0; p = nodes[p]!.parent) if (p === row) return true
    return false
  }
  const toggle = nodes.findIndex((n, i) => n.attrs.checkable === 'true' && inside(i))
  const [x, y] = center(parseBounds(nodes[row]!.attrs.bounds!))
  return {title: nodes[at]!.attrs.text!, checked: toggle < 0 ? undefined : nodes[toggle]!.attrs.checked === 'true', x, y}
}
