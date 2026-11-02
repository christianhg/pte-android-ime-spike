import {
  defineSchema,
  EditorProvider,
  PortableTextEditable,
  useEditor,
} from '@portabletext/editor'
import {useEffect} from 'react'
import {createRoot} from 'react-dom/client'

const schemaDefinition = defineSchema({styles: [{name: 'normal'}]})

const params = new URLSearchParams(location.search)
const prefix = params.get('prefix') ?? ''
// Merge probe: two blocks, the text from a Backspace-merge report.
const merge = params.get('merge') !== null

const initialValue = merge
  ? [
      {
        _type: 'block',
        _key: 'b0',
        style: 'normal',
        markDefs: [],
        children: [{_type: 'span', _key: 's0', text: 'クロスボーダー・', marks: []}],
      },
      {
        _type: 'block',
        _key: 'b2',
        style: 'normal',
        markDefs: [],
        children: [{_type: 'span', _key: 's2', text: 'コンサルティング', marks: []}],
      },
    ]
  : [
      {
        _type: 'block',
        _key: 'b0',
        style: 'normal',
        markDefs: [],
        children: [{_type: 'span', _key: 's0', text: prefix, marks: []}],
      },
    ]

const events: Array<Record<string, unknown>> = []

function Probe() {
  const editor = useEditor()
  useEffect(() => {
    ;(window as any).__state = () => {
      const value = editor.getSnapshot().context.value ?? []
      const text = value
        .map((block: any) =>
          (block.children ?? []).map((child: any) => child.text ?? '').join(''),
        )
        .join('\n')
      const dom = document.querySelector('[contenteditable]')?.textContent
      return {text, dom, events}
    }
    ;(window as any).__caretToSecond = () => {
      const point = {path: [{_key: 'b2'}, 'children', {_key: 's2'}], offset: 0}
      editor.send({type: 'select', at: {anchor: point, focus: point}} as any)
    }
  }, [editor])
  return null
}

function App() {
  return (
    <EditorProvider initialConfig={{schemaDefinition, initialValue} as any}>
      <Probe />
      <PortableTextEditable
        style={{border: '1px solid #888', minHeight: '3em', fontSize: 20}}
      />
    </EditorProvider>
  )
}

createRoot(document.getElementById('root')!).render(<App />)

const log = document.getElementById('log')!
for (const t of [
  'keydown',
  'beforeinput',
  'input',
  'compositionstart',
  'compositionupdate',
  'compositionend',
]) {
  document.addEventListener(
    t,
    (e: any) => {
      events.push({type: t, inputType: e.inputType, data: e.data, key: e.key, keyCode: e.keyCode})
      log.textContent = events.map((x) => JSON.stringify(x)).join('\n')
    },
    true,
  )
}
