import { call, notify } from '../neovim-client'
import { cc } from '../../utils'
import * as uiInput from '../input'
import * as glob from 'globby'
import { basename, dirname } from 'path'
import * as Fuse from 'fuse.js'
import huu from 'huu'
const { h: hs, app } = require('hyperapp')
const { cmd } = notify
const h = huu(hs)

const formatDir = (dir: string) => dir === '.' ? '' : `${dir}/`

interface SearchEntry {
  name: string,
  base: string,
  modified?: boolean,
  dir: string
}

const getProjectFiles = (cwd: string): Promise<string[]> => glob('**', {
  cwd,
  nosort: true,
  nodir: true,
  ignore: [
    '**/node_modules/**',
    '**/*.png',
    '**/*.jpg',
    '**/*.gif',
  ]
})

const getFiles = async (cwd: string): Promise<SearchEntry[]> => {
  const [ currentFile, files ] = await cc(call.expand('%f'), getProjectFiles(cwd))

  return files
    .filter((m: string) => m !== currentFile)
    .map((name: string) => ({
      name,
      base: basename(name),
      key: name,
      dir: formatDir(dirname(name))
    }))
}

let filesList: Fuse
let filesRay: any[]

const state = {
  val: '',
  files: [],
  vis: false
}

let elRef: any

const hidden = { display: 'none' }
const container = {
  display: 'flex',
  width: '100%',
  'justify-content': 'center',
  'align-items': 'flex-start',
}

const pretty = {
  width: '400px',
  background: '#333',
  'margin-top': '15%'
}

const view = ({ val, files, vis }: any, { update, hide }: any) => h('#files', {
  style: vis ? container : hidden
}, [
  h('div', { style: pretty }, [
    h('input', {
      oninsert: (e: any) => elRef = e,
      value: val,
      onkeydown: update,
      onblur: hide,
    }),
    h('ul', files.slice(0, 10).map((f: any) => h('li', f.name))),
  ])
])

const actions = {
  show: (s: any) => {
    uiInput.blur()
    setTimeout(() => elRef && elRef.focus && elRef.focus())
    return { ...s, vis: true, files: filesRay.slice(0, 10).sort((a, b) => a.name.length - b.name.length) }
  },
  hide: (s: any) => {
    setImmediate(() => uiInput.focus())
    return { ...s, val: '', vis: false }
  },
  update: (s: any, a: any, e: KeyboardEvent) => {
    if (e.key === 'Escape') return a.hide()

    if (e.key === 'Enter') {
      if (s.val) cmd(`e ${s.files[0].name}`)
      return a.hide()
    }

    if (e.key === 'Backspace') return { ...s, val: s.val.slice(0, -1) }
    if (e.metaKey && e.key === 'w') {
      const val = s.val.split(' ').slice(0, -1).join(' ')
      return {
        ...s, val, files: val
          ? s.files
          : filesRay.slice(0, 10).sort((a, b) => a.name.length - b.name.length)
      }
    }

    const key = e.key.length > 1 ? '' : e.key
    const val = s.val + key
    if (val) {
      const files = filesList.search(val)
      return { ...s, val, files }
    }
    const files = filesRay.slice(0, 10).sort((a, b) => a.name.length - b.name.length)
    return { ...s, val, files }
  }
}

const events = {
  show: (_s: any, actions: any) => actions.show()
}

const emit = app({ state, view, actions, events, root: document.getElementById('plugins') })

export default async () => {
  const cwd = await call.getcwd().catch(e => console.log(e))
  if (!cwd) return
  const files = await getFiles(cwd).catch(e => console.log(e))

  filesRay = files || []
  filesList = new Fuse(files || [], { keys: ['name'] })
  // other opts to consider:
  // includeMatches (for highlighting)
  // fine tune other params to be more like sequential search

  emit('show')
}
