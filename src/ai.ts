import { fullBufferUpdate, partialBufferUpdate, references, definition, rename, signatureHelp, hover, symbols, workspaceSymbols } from './langserv/adapter'
import { g, ex, action, autocmd, until, cwdir, call, expr, getCurrentLine, feedkeys } from './ui/neovim'
import { cc, debounce, merge, hasUpperCase, findIndexRight } from './utils'
import * as harvester from './ui/plugins/keyword-harvester'
import * as completionUI from './ui/plugins/autocomplete'
import * as symbolsUI from './ui/plugins/symbols'
import * as hoverUI from './ui/plugins/hover'
import { filter } from 'fuzzaldrin-plus'
import vimUI from './ui/canvasgrid'
import { sub } from './dispatch'

interface Cache { startIndex: number, completionItems: string[], filetype: string, file: string, revision: number, cwd: string }
export const cache: Cache = { filetype: '', file: '', revision: -1, cwd: '', startIndex: 0, completionItems: [] }
const maxResults = 8
let pauseUpdate = false

// TODO: get from lang server
const completionTriggers = new Map<string, RegExp>()
// TODO: $$$$ sign, reallY?
completionTriggers.set('javascript', /[^\w\$\-]/)
completionTriggers.set('typescript', /[^\w\$\-]/)

const fileInfo = () => {
  const { cwd, file, filetype, revision } = cache
  return { cwd, file, filetype, revision }
}

const orderCompletions = (m: string[], query: string) =>
  m.slice().sort(a => hasUpperCase(a) ? -1 : a.startsWith(query) ? -1 : 1)

const calcMenuPosition = (startIndex: number, column: number, count: number) => {
  // anchor menu above row if the maximum results are going to spill out of bounds.
  // why maxResults instead of the # of items in options? because having the menu jump
  // around over-under as you narrow down results by typing or undo is kinda annoying
  const row = vimUI.cursor.row + maxResults > vimUI.rows
    ? vimUI.cursor.row - count
    : vimUI.cursor.row + 1

  const start = Math.max(0, startIndex)
  const col = vimUI.cursor.col - (column - start)
  return { y: vimUI.rowToY(row), x: vimUI.colToX(col) }
}

const findQuery = (filetype: string, line: string, column: number) => {
  const pattern = completionTriggers.get(filetype) || /[^\w\-]/
  const start = findIndexRight(line, pattern, column - 2) || 0
  const startIndex = start ? start + 1 : 0
  const query = line.slice(startIndex, column - 1) || ''
  const leftChar = line[start]
  // TODO: should startIndex be modified for leftChar?
  return { startIndex, query, leftChar }
}

const getPos = async () => {
  // TODO: use nvim_window_* api instead or ui.cursor position?
  const [ buffer, line, column, offset ] = await call.getpos('.')
  return { buffer, line, column, offset }
}

const updateVim = (items: string[]) => {
  cache.completionItems = items
  g.veonim_completions = items
}

const updateServer = async (lineChange = false) => {
  // TODO: better, more async
  const [ , line, column ] = await call.getpos('.')

  if (lineChange) partialBufferUpdate({
    ...fileInfo(),
    line,
    column,
    buffer: [ await getCurrentLine() ]
  })

  else {
    // TODO: buffer.getLines api built-in
    const buffer = await call.getline(1, '$') as string[]
    harvester.update(cache.cwd, cache.file, buffer)
    fullBufferUpdate({ ...fileInfo(), line, column, buffer })
  }
}

const attemptUpdate = async (lineChange = false) => {
  if (pauseUpdate) return
  // TODO: buffer.changedtick api built-in
  const chg = await expr('b:changedtick')
  if (chg > cache.revision) updateServer(lineChange)
  cache.revision = chg
}

const getCompletions = async () => {
  // TODO: use neovim api built-ins? better perf? line is slowest. ui.cursor not work as it's global
  const [ lineData, { column } ] = await cc(getCurrentLine(), getPos())
  const { startIndex, query } = findQuery(cache.filetype, lineData, column)

  // TODO: if (left char is . or part of the completionTriggers defined per filetype) 
  if (query.length) {
    const words = await harvester.getKeywords(cache.cwd, cache.file)
    if (!words || !words.length) return
    // TODO: call keywords + semantic = combine -> filter against query
    // TODO: call once per startIndex. don't repeat call if startIndex didn't change?
    // TODO: only call this if query has changed 

    // query.toUpperCase() allows the filter engine to rank camel case functions higher
    // aka: saveUserAccount > suave for query: 'sua'
    const completions = filter(words, query.toUpperCase(), { maxResults })

    if (!completions.length) {
      updateVim([])
      completionUI.hide()
      return
    }

    const orderedCompletions = orderCompletions(completions, query)
    updateVim(orderedCompletions)
    const options = orderedCompletions.map((text, id) => ({ id, text }))
    const { x, y } = calcMenuPosition(startIndex, column, options.length)
    completionUI.show({ options, x, y })

    // TODO: do we always need to update this?
    // TODO: cache last position in insert session
    // only update vim if (changed) 
    // use cache - if (same) dont re-ask for keyword/semantic completions from avo
    //if (cache.startIndex !== startIndex) {
    //setVar('veonim_complete_pos', startIndex)
    //ui.show()
    //}
    g.veonim_complete_pos = startIndex
  } else {
    completionUI.hide()
    updateVim([])
  }
}

autocmd.bufEnter(debounce(async () => {
  const [ cwd, file, filetype ] = await cc(cwdir(), call.expand(`%f`), expr(`&filetype`))
  // TODO: changedtick -> revision
  merge(cache, { cwd, file, filetype, revision: -1 })
  updateServer()
}, 100))

autocmd.textChanged(debounce(() => attemptUpdate(), 200))
autocmd.textChangedI(() => attemptUpdate(true))
autocmd.cursorMoved(() => hoverUI.hide())
autocmd.cursorMovedI(() => {
  hoverUI.hide()
  getCompletions()
})

autocmd.insertLeave(() => {
  cache.startIndex = 0
  completionUI.hide()
  !pauseUpdate && updateServer()
})

autocmd.completeDone(async () => {
  g.veonim_completing = 0
  const { word } = await expr(`v:completed_item`)
  harvester.addWord(cache.cwd, cache.file, word)
  updateVim([])
})

sub('pmenu.select', ix => completionUI.select(ix))
sub('pmenu.hide', () => completionUI.hide())

action('references', async () => {
  const [ , line, column ] = await call.getpos('.')
  const refs = await references({ ...fileInfo(), line, column })

  await call.setloclist(0, refs.map(m => ({
    lnum: m.line,
    col: m.column,
    text: m.desc
  })))

  ex('lopen')
  ex('wincmd p')
})

action('definition', async () => {
  const [ , line, column ] = await call.getpos('.')
  const loc = await definition({ ...fileInfo(), line, column })
  if (!loc || !loc.line || !loc.column) return
  await call.cursor(loc.line, loc.column)
})

action('rename', async () => {
  const [ , line, column ] = await call.getpos('.')
  pauseUpdate = true
  await feedkeys('ciw')
  await until.insertLeave()
  const newName = await expr('@.')
  await feedkeys('u')
  pauseUpdate = false
  const patches = await rename({ ...fileInfo(), line, column, newName })
  // TODO: change other files besides current buffer. using fs operations if not modified?
  patches.forEach(({ operations }) => call.PatchCurrentBuffer(operations))
})

action('hover', async () => {
  const [ , line, column ] = await call.getpos('.')
  const html = await hover({ ...fileInfo(), line, column })
  // TODO: get start column of the object
  // TODO: if multi-line html, anchor from bottom
  const y = vimUI.rowToY(vimUI.cursor.row - 1)
  const x = vimUI.colToX(column)
  hoverUI.show({ html, x, y })
})

// TODO: this will be auto-triggered. get triggerChars from server.canDo
// TODO: try to figure out if we are inside func call? too much work? (so this func is not called when outside func)
action('signature-help', async () => {
  const [ , line, column ] = await call.getpos('.')
  const hint = await signatureHelp({ ...fileInfo(), line, column })
  if (!hint.signatures.length) return
  // TODO: support list of signatures
  const { label } = hint.signatures[0]
  const y = vimUI.rowToY(vimUI.cursor.row - 1)
  const x = vimUI.colToX(column)
  hoverUI.show({ html: label, x, y })
  // TODO: highlight params
})

action('symbols', async () => {
  const listOfSymbols = await symbols(fileInfo())
  listOfSymbols && symbolsUI.show(listOfSymbols)
})

action('workspace-symbols', async () => {
  const listOfSymbols = await workspaceSymbols(fileInfo())
  listOfSymbols && symbolsUI.show(listOfSymbols)
})