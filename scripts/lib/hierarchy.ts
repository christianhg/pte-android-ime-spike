// Parse uiautomator XML hierarchy dumps. A strict little parser for the dump's shape: nested elements
// with quoted attributes and the five XML entities. Malformed input throws, as ElementTree did.

export type XmlNode = {tag: string; attrs: Record<string, string>}

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
  let rootSeen = false
  const tag = /<(\?[\s\S]*?\?>|!--[\s\S]*?-->|\/([\w:.-]+)\s*>|([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>)/g
  let at = 0
  for (let m = tag.exec(xml); m; m = tag.exec(xml)) {
    if (xml.slice(at, m.index).includes('<')) throw new Error(`malformed XML near offset ${at}`)
    at = tag.lastIndex
    if (m[1]!.startsWith('?') || m[1]!.startsWith('!')) continue
    if (m[2]) {
      if (stack.pop() !== m[2]) throw new Error(`mismatched </${m[2]}> at offset ${m.index}`)
      continue
    }
    if (stack.length === 0 && rootSeen) throw new Error('junk after document element')
    rootSeen = true
    const attrs: Record<string, string> = {}
    for (const a of m[4]!.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]!] = unescape(a[2] ?? a[3] ?? '')
    nodes.push({tag: m[3]!, attrs})
    if (!m[5]) stack.push(m[3]!)
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
