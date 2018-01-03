import { codeAction, onDiagnostics, executeCommand } from '../langserv/adapter'
import { on, action, getCurrent, current as vim } from '../core/neovim'
import { Command, Diagnostic } from 'vscode-languageserver-types'
import { positionWithinRange } from '../support/neovim-utils'
import * as codeActionUI from '../components/code-actions'
import { merge, uriToPath } from '../support/utils'
import { setCursorColor } from '../core/cursor'

const cache = {
  uri: '',
  diagnostics: [] as Diagnostic[],
  actions: [] as Command[],
  visibleConcerns: new Map<string, () => void>(),
}

onDiagnostics(async m => {
  const path = uriToPath(m.uri)
  merge(cache, m)

  const clearPreviousConcerns = cache.visibleConcerns.get(path)
  if (clearPreviousConcerns) clearPreviousConcerns()
  if (!m.diagnostics.length) return

  // TODO: handle severity (errors vs warnings, etc.)
  const concerns = m.diagnostics.map((d: Diagnostic) => ({
    line: d.range.start.line,
    columnStart: d.range.start.character,
    columnEnd: d.range.end.character,
  }))

  const buffer = await getCurrent.buffer
  const name = await buffer.name

  if (name !== path) return

  const clearToken = await buffer.highlightConcerns(concerns)
  cache.visibleConcerns.set(name, clearToken)
})

on.cursorMove(async state => {
  const { line, column } = state

  const relevantDiagnostics = cache
    .diagnostics
    .filter(d => positionWithinRange(line - 1, column - 1, d.range))

  const actions = await codeAction(state, relevantDiagnostics)

  // TODO: what is the stuff on the columnbar? code lens?
  if (actions && actions.length) {
    cache.actions = actions
    setCursorColor('red')
  }
})

export const runCodeAction = (action: Command) => executeCommand(vim, action)

action('code-action', () => codeActionUI.show(vim.line, vim.column, cache.actions))
