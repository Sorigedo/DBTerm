export type ResultCopyInput = {
  inputSelection: boolean
  editorOrInput: boolean
  textSelection: boolean
  selectedRows: boolean
  cellSelection: boolean
  focusedCell: boolean
}

export type ResultCopyMode =
  | 'input-selection'
  | 'ignore-editor'
  | 'text-selection'
  | 'rows'
  | 'cells'
  | 'focused-cell'
  | 'none'

export function resolveResultCopyMode(input: ResultCopyInput): ResultCopyMode {
  if (input.inputSelection) return 'input-selection'
  if (input.editorOrInput) return 'ignore-editor'
  if (input.textSelection) return 'text-selection'
  if (input.selectedRows) return 'rows'
  if (input.cellSelection) return 'cells'
  if (input.focusedCell) return 'focused-cell'
  return 'none'
}
