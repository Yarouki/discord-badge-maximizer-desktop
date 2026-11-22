import { SHUTDOWN_WAIT_MS, TASKKILL_WAIT_MS } from './bridge'
import { errorMessage } from './errors'

export const QUIT_CAP_MS = SHUTDOWN_WAIT_MS + TASKKILL_WAIT_MS + 1000
const FLUSH_WAIT_MS = 1000
const EXIT_AFTER_MS = 2000

export interface QuitHandlerOptions {
  shutdown: () => Promise<void>
  quit: () => void
  exit: () => void
  destroyWindows: () => void
  flushLog?: () => Promise<void>
  log: (message: string) => void
  onStop?: () => void
  capMs?: number
}

function settledWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    promise
      .catch(() => {})
      .finally(() => {
        clearTimeout(timer)
        resolve()
      })
  })
}

export function createQuitHandler(
  options: QuitHandlerOptions
): (event: { preventDefault: () => void }) => void {
  const capMs = options.capMs ?? QUIT_CAP_MS
  let phase: 'running' | 'stopping' | 'finishing' | 'done' = 'running'

  const finish = async (): Promise<void> => {
    if (phase !== 'stopping') return
    phase = 'finishing'
    try {
      options.destroyWindows()
    } catch (e) {
      options.log(`Closing the windows before quitting: ${errorMessage(e)}`)
    }
    if (options.flushLog) {
      await settledWithin(
        new Promise<void>((resolve) => resolve(options.flushLog?.())),
        FLUSH_WAIT_MS
      )
    }
    phase = 'done'
    options.quit()
    setTimeout(() => options.exit(), EXIT_AFTER_MS)
  }

  return (event) => {
    if (phase === 'done') return
    event.preventDefault()
    if (phase !== 'running') return
    phase = 'stopping'
    try {
      options.onStop?.()
    } catch (e) {
      options.log(`Hiding the windows before quitting: ${errorMessage(e)}`)
    }
    const cap = setTimeout(() => {
      options.log(`The backend did not shut down within ${capMs / 1000} seconds; quitting anyway`)
      void finish()
    }, capMs)
    new Promise<void>((resolve) => resolve(options.shutdown()))
      .catch((e: unknown) => options.log(`Shutting down the backend: ${errorMessage(e)}`))
      .finally(() => {
        clearTimeout(cap)
        void finish()
      })
  }
}

export interface FocusableWindow {
  isDestroyed(): boolean
  isMinimized(): boolean
  restore(): void
  show(): void
  focus(): void
}

export function focusExistingWindow(win: FocusableWindow | null): boolean {
  if (!win || win.isDestroyed()) return false
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  return true
}

export function quitsWhenAllClosed(inTray: boolean): boolean {
  return !inTray
}

export interface TrayAsk {
  wanted: { stream: boolean; claim: boolean }
}

export function pendingTrayOutcome(
  ask: TrayAsk,
  now: { settled: boolean; stream: boolean; claim: boolean },
  force: boolean
): 'wait' | 'tray' | 'stay' {
  if (!force && !now.settled) return 'wait'
  const failed = (ask.wanted.stream && !now.stream) || (ask.wanted.claim && !now.claim)
  return failed ? 'stay' : 'tray'
}

export const CRASH_LIMIT = 3
export const CRASH_WINDOW_MS = 60_000

export function afterPageCrash(
  earlier: readonly number[],
  now: number
): { times: number[]; action: 'rebuild' | 'give-up' } {
  const times = [...earlier.filter((t) => now - t < CRASH_WINDOW_MS), now]
  return { times, action: times.length >= CRASH_LIMIT ? 'give-up' : 'rebuild' }
}

export const PANEL_REOPEN_GAP_MS = 400

export function panelClickAction(facts: {
  open: boolean
  closedAt: number
  now: number
}): 'open' | 'close' | 'none' {
  if (facts.open) return 'close'
  if (facts.closedAt > 0 && facts.now - facts.closedAt < PANEL_REOPEN_GAP_MS) return 'none'
  return 'open'
}
