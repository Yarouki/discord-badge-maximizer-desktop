export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export type TaskbarEdge = 'top' | 'bottom' | 'left' | 'right'

const MARGIN = 8

export function taskbarEdge(display: Rect, workArea: Rect, tray: Rect): TaskbarEdge {
  if (workArea.y > display.y) return 'top'
  if (workArea.x > display.x) return 'left'
  if (workArea.width < display.width) return 'right'
  if (workArea.height < display.height) return 'bottom'
  const cx = tray.x + tray.width / 2
  const cy = tray.y + tray.height / 2
  const distances: [TaskbarEdge, number][] = [
    ['bottom', display.y + display.height - cy],
    ['top', cy - display.y],
    ['left', cx - display.x],
    ['right', display.x + display.width - cx]
  ]
  return distances.reduce((best, next) => (next[1] < best[1] ? next : best))[0]
}

function within(start: number, size: number, min: number, max: number): number {
  return Math.max(min, Math.min(start, max - size))
}

export interface PanelPlacement {
  tray: Rect
  size: { width: number; height: number }
  display: Rect
  workArea: Rect
}

export function panelPosition({ tray, size, display, workArea }: PanelPlacement): {
  x: number
  y: number
} {
  const hasIcon = tray.width > 0 && tray.height > 0
  const edge = hasIcon ? taskbarEdge(display, workArea, tray) : 'bottom'
  let left = workArea.x + MARGIN
  let top = workArea.y + MARGIN
  let right = workArea.x + workArea.width - MARGIN
  let bottom = workArea.y + workArea.height - MARGIN
  if (hasIcon) {
    if (edge === 'bottom') bottom = Math.min(bottom, tray.y - MARGIN)
    if (edge === 'top') top = Math.max(top, tray.y + tray.height + MARGIN)
    if (edge === 'left') left = Math.max(left, tray.x + tray.width + MARGIN)
    if (edge === 'right') right = Math.min(right, tray.x - MARGIN)
  }
  const clampX = (x: number): number => Math.round(within(x, size.width, left, right))
  const clampY = (y: number): number =>
    Math.round(within(y, size.height, size.height > workArea.height ? workArea.y : top, bottom))

  if (!hasIcon) {
    return { x: clampX(right - size.width), y: clampY(bottom - size.height) }
  }
  const cx = tray.x + tray.width / 2
  const cy = tray.y + tray.height / 2
  switch (edge) {
    case 'top':
      return { x: clampX(cx - size.width / 2), y: clampY(top) }
    case 'left':
      return { x: clampX(left), y: clampY(cy - size.height / 2) }
    case 'right':
      return { x: clampX(right - size.width), y: clampY(cy - size.height / 2) }
    default:
      return { x: clampX(cx - size.width / 2), y: clampY(bottom - size.height) }
  }
}
