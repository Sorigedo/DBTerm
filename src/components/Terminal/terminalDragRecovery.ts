/** xterm relies on mouseup alone; recover a lost release without cancelling real drags. */
export function createTerminalDragRecovery(release: () => void) {
  let dragging = false
  const finish = () => {
    if (!dragging) return
    dragging = false
    release()
  }
  return {
    down: (event: Pick<MouseEvent, 'button'>) => {
      if (event.button === 0) dragging = true
    },
    up: (event: Pick<MouseEvent, 'button'>) => {
      if (event.button === 0) dragging = false
    },
    move: (event: Pick<MouseEvent, 'buttons'>) => {
      if (event.buttons === undefined) return
      if ((event.buttons & 1) === 0) finish()
    },
    blur: finish,
  }
}

export function installTerminalDragRecovery(
  terminal: EventTarget,
  document: EventTarget,
  window: EventTarget,
  release: () => void,
): () => void {
  const recovery = createTerminalDragRecovery(release)
  const down = (event: Event) => recovery.down(event as MouseEvent)
  const up = (event: Event) => recovery.up(event as MouseEvent)
  const move = (event: Event) => recovery.move(event as MouseEvent)
  const capture = { capture: true }
  terminal.addEventListener('mousedown', down, capture)
  document.addEventListener('mouseup', up, capture)
  document.addEventListener('mousemove', move, capture)
  window.addEventListener('blur', recovery.blur)
  return () => {
    recovery.blur()
    terminal.removeEventListener('mousedown', down, capture)
    document.removeEventListener('mouseup', up, capture)
    document.removeEventListener('mousemove', move, capture)
    window.removeEventListener('blur', recovery.blur)
  }
}
