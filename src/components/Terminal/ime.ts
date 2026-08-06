const ASCII_COMPOSITION_RE = /^[\x20-\x7e]+$/

export function isAsciiCompositionCommit(data: string): boolean {
  return data.length > 0 && ASCII_COMPOSITION_RE.test(data)
}

export function shouldSuppressImeAsciiCommit(lastKey: string, data: string): boolean {
  if (!isAsciiCompositionCommit(data)) return false
  const key = lastKey.trim()
  if (key === 'Enter' || key === ' ') return false
  if (key === 'Shift' || key === 'ShiftLeft' || key === 'ShiftRight' || key === 'CapsLock') return false
  return true
}

export function shouldCommitCanceledAsciiComposition(lastKey: string, data: string): boolean {
  if (!isAsciiCompositionCommit(data)) return false
  const key = lastKey.trim()
  return key === 'Enter' || key === 'Shift' || key === 'ShiftLeft' || key === 'ShiftRight' || key === 'CapsLock'
}

export function shouldSuppressReturnAfterCanceledAsciiCommit(lastKey: string, data: string): boolean {
  return lastKey.trim() === 'Enter' && isAsciiCompositionCommit(data)
}
