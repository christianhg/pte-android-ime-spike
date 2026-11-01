// Loaded before the page's own script on every test page. Collects page errors per load, and reads the
// empty line's layout for the drivers through window.__layout().
window.__errors = []
const record = (kind, message) => window.__errors.push({kind, message: String(message).slice(0, 2000), t: Date.now()})
// Safari stacks leave out the message, so record both.
window.addEventListener('error', (e) => record('error', `${e.message}\n${e.error?.stack ?? ''}`))
window.addEventListener('unhandledrejection', (e) => record('unhandledrejection', e.reason?.stack ?? e.reason))
const consoleError = console.error
console.error = (...args) => {
  record('console.error', args.map((a) => (a instanceof Error ? a.stack : typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
  consoleError.apply(console, args)
}

const box = (r) => (r ? {top: r.top, left: r.left, width: r.width, height: r.height, bottom: r.bottom} : null)

window.__layout = () => {
  const field = document.querySelector('[contenteditable="true"]')
  // In the editor, the string span: the empty line while the block is empty, the text span after typing.
  // In the plain pages there is no such span, so the field itself is the line.
  const string = field?.querySelector('[data-pt-line-break], [data-pt-text], [data-pt-zero-width]') ?? null
  const line = string ?? field
  const placeholder = field?.querySelector('[contenteditable="false"]') ?? null
  const selection = getSelection()
  let caret = null
  let caretSource = 'no selection'
  if (selection && selection.rangeCount) {
    const range = selection.getRangeAt(0)
    const rects = range.getClientRects()
    const bounding = range.getBoundingClientRect()
    if (rects.length) {
      caret = box(rects[0])
      caretSource = 'range.getClientRects'
    } else if (bounding.height > 0) {
      caret = box(bounding)
      caretSource = 'range.getBoundingClientRect'
    } else {
      caret = box(line?.getBoundingClientRect())
      caretSource = 'line rect (the collapsed range has no rect)'
    }
  }
  const style = line ? getComputedStyle(line) : null
  const anchor = selection?.anchorNode
  return {
    userAgent: navigator.userAgent,
    cssLhSupported: CSS.supports('margin-top', '-1lh'),
    devicePixelRatio,
    visualViewport: visualViewport ? {offsetTop: visualViewport.offsetTop, height: visualViewport.height, scale: visualViewport.scale} : null,
    lineSelector: string ? [...string.attributes].map((a) => a.name).join(' ') : 'field',
    line: box(line?.getBoundingClientRect()),
    lineInnerHTML: line && string ? line.innerHTML : null,
    lineParentInnerHTML: string?.parentElement?.innerHTML ?? null,
    block: box(field?.querySelector('[data-pt-block]')?.getBoundingClientRect() ?? null),
    blockInnerHTML: field?.querySelector('[data-pt-block]')?.innerHTML ?? field?.innerHTML ?? null,
    placeholder: box(placeholder?.getBoundingClientRect()),
    placeholderText: placeholder?.textContent ?? null,
    placeholderMarginTop: placeholder ? getComputedStyle(placeholder).marginTop : null,
    caret,
    caretSource,
    selection: anchor
      ? {
          anchorNode: anchor.nodeType === 3 ? `#text ${JSON.stringify(anchor.data)}` : anchor.nodeName,
          anchorParent: anchor.parentElement ? [...anchor.parentElement.attributes].map((a) => a.name).join(' ') : null,
          anchorOffset: selection.anchorOffset,
          isCollapsed: selection.isCollapsed,
        }
      : null,
    lineHeight: style?.lineHeight ?? null,
    fontSize: style?.fontSize ?? null,
    activeIsField: document.activeElement === field,
  }
}

// The DOM shape the editor sees when it maps each input's target range, captured before the editor's own handler.
window.__inputs = []
const describe = (node) => {
  if (!node) return null
  if (node.nodeType === 3) {
    const parent = node.parentElement
    return `#text ${JSON.stringify(node.data)} in ${parent ? parent.nodeName + '[' + [...parent.attributes].map((a) => a.name).join(' ') + ']' : 'detached'}`
  }
  return `${node.nodeName}[${node.attributes ? [...node.attributes].map((a) => a.name).join(' ') : ''}] connected=${node.isConnected}`
}
const captureInput = (e) => {
  if (window.__inputs.length >= 60) return
  const field = document.querySelector('[contenteditable="true"]')
  const ranges = typeof e.getTargetRanges === 'function' ? e.getTargetRanges() : []
  const selection = getSelection()
  window.__inputs.push({
    type: e.type,
    inputType: e.inputType ?? null,
    data: e.data ?? null,
    isComposing: e.isComposing ?? null,
    targetRanges: ranges.map((r) => ({start: describe(r.startContainer), startOffset: r.startOffset, end: describe(r.endContainer), endOffset: r.endOffset})),
    selection: selection && selection.rangeCount ? {anchor: describe(selection.anchorNode), anchorOffset: selection.anchorOffset} : null,
    blockInnerHTML: field?.querySelector('[data-pt-block]')?.innerHTML?.slice(0, 1500) ?? field?.innerHTML?.slice(0, 1500) ?? null,
    t: Date.now(),
  })
}
for (const type of ['beforeinput', 'input', 'compositionstart', 'compositionend']) {
  window.addEventListener(type, captureInput, true)
}
