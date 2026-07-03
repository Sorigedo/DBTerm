import type { WheelHMode } from '../stores/settingsStore.ts'

function hasScrollModifier(e: Pick<WheelEvent, 'shiftKey' | 'altKey' | 'ctrlKey'>): boolean {
  return e.shiftKey || e.altKey || e.ctrlKey
}

function matchesWheelMode(e: Pick<WheelEvent, 'shiftKey' | 'altKey' | 'ctrlKey'>, mode: WheelHMode): boolean {
  if (mode === 'horizontal-first') return true
  if (mode === 'alt') return e.altKey
  if (mode === 'ctrl') return e.ctrlKey
  return e.shiftKey
}

export function resolveWheelAction(
  e: Pick<WheelEvent, 'shiftKey' | 'altKey' | 'ctrlKey' | 'deltaX' | 'deltaY'>,
  mode: WheelHMode,
  horizontalOnly: boolean,
  canY: boolean,
): 'native' | 'horizontal' | 'block' {
  const modified = hasScrollModifier(e)
  if (modified) return matchesWheelMode(e, mode) ? 'horizontal' : 'block'
  if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return 'native'
  if (horizontalOnly || !canY || mode === 'horizontal-first') return 'horizontal'
  return 'native'
}

export function hasWheelScrollModifier(e: Pick<WheelEvent, 'shiftKey' | 'altKey' | 'ctrlKey'>): boolean {
  return hasScrollModifier(e)
}
