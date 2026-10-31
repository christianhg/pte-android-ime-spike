// A plain Slate editor from upstream slate-react: one empty paragraph, no placeholder, no plugins.
import {useMemo} from 'react'
import {createRoot} from 'react-dom/client'
import {createEditor, type Descendant} from 'slate'
import {Editable, Slate, withReact} from 'slate-react'

const params = new URLSearchParams(location.search)
const prefix = params.get('prefix') ?? ''

const initialValue: Descendant[] = [
  {type: 'paragraph', children: [{text: prefix}]} as Descendant,
]

const events: Array<Record<string, unknown>> = []

function App() {
  const editor = useMemo(() => withReact(createEditor()), [])
  ;(window as any).__state = () => {
    const text = editor.children
      .map((block: any) =>
        (block.children ?? []).map((child: any) => child.text ?? '').join(''),
      )
      .join('\n')
    const dom = document.querySelector('[contenteditable]')?.textContent
    return {text, dom, events}
  }
  return (
    <Slate editor={editor} initialValue={initialValue}>
      <Editable style={{border: '1px solid #888', minHeight: '3em', fontSize: 20}} />
    </Slate>
  )
}

createRoot(document.getElementById('root')!).render(<App />)

const log = document.getElementById('log')!
for (const t of [
  'beforeinput',
  'input',
  'compositionstart',
  'compositionupdate',
  'compositionend',
]) {
  document.addEventListener(
    t,
    (e: any) => {
      events.push({type: t, inputType: e.inputType, data: e.data})
      log.textContent = events.map((x) => JSON.stringify(x)).join('\n')
    },
    true,
  )
}
