export function shouldCloseFileMenuFromTarget(target: Element | null): boolean {
  if (!target) return true
  return !target.closest('.fm-ctx-menu, .cdlg-overlay, .fm-picker')
}
