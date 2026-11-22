import { initialSession, reduceSession, type SessionAction } from './session-state'
import { closedWindowLines, streamEndNotice } from './tray-text'
import type { SessionSnapshot } from '../shared/ipc'

export const sessionClock = (): number => performance.timeOrigin + performance.now()

export interface SessionTrackerDeps {
  now: () => number
  hasWindow: () => boolean
  isQuitting: () => boolean
  notify: (body: string) => void
  onChange: (snapshot: SessionSnapshot) => void
}

export class SessionTracker {
  private state: SessionSnapshot = initialSession()

  constructor(private readonly deps: SessionTrackerDeps) {}

  get snapshot(): SessionSnapshot {
    return this.state
  }

  apply(action: SessionAction): void {
    const before = this.state
    let next = reduceSession(before, action)
    if (!this.deps.hasWindow()) {
      for (const line of closedWindowLines(before, action)) {
        next = reduceSession(next, { type: 'note', ...line, at: this.deps.now() })
      }
      const notice = this.deps.isQuitting() ? null : streamEndNotice(before, action)
      if (notice) this.deps.notify(notice)
    }
    this.state = next
    if (next !== before) this.deps.onChange(next)
  }
}
