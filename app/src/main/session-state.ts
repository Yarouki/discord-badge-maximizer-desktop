import type {
  AccountResult,
  AltStatus,
  ClaimArgs,
  ClaimDoneSnapshot,
  ClaimSnapshot,
  EventChannel,
  EventPayloads,
  LogEntry,
  LogTone,
  SessionSnapshot,
  StreamArgs,
  StreamSnapshot,
  TraySnapshot
} from '../shared/ipc'

export const LOG_LIMIT = 300
export const MAX_LINE = 2000

export const isBusyRefusal = (error: string | undefined): boolean =>
  /still stopping/i.test(error ?? '')

export type BridgeEvent = {
  [K in EventChannel]: { channel: K; data: EventPayloads[K] }
}[EventChannel]

export type SessionAction =
  | { type: 'event'; event: BridgeEvent; at: number }
  | { type: 'stream-start'; args: StreamArgs; serverName: string; channelName: string; at: number }
  | { type: 'stream-start-result'; run: number; ok: boolean; error?: string; willRetry?: boolean }
  | { type: 'stream-stop'; run?: number; restart?: boolean }
  | { type: 'claim-start'; args: ClaimArgs; at: number }
  | { type: 'claim-start-result'; run: number; ok: boolean; error?: string; willRetry?: boolean }
  | { type: 'claim-stop'; run?: number }
  | { type: 'claim-dismiss' }
  | { type: 'accounts'; result: AccountResult }
  | { type: 'auto-watch'; enabled: boolean }
  | { type: 'note'; text: string; tone: LogTone; at: number }
  | { type: 'page-gone'; inFlight: { stream: boolean; claim: boolean } }

export function initialSession(): SessionSnapshot {
  return {
    accounts: { main: null, alt: null },
    stream: null,
    claim: null,
    claimDone: null,
    autoWatch: true,
    lastRun: 0,
    log: []
  }
}

export function isRunning(state: SessionSnapshot): boolean {
  return state.stream !== null || state.claim !== null
}

export function isSettled(state: SessionSnapshot): boolean {
  const { stream, claim } = state
  const streamSettled = !stream || (stream.accepted && !stream.restarting)
  return streamSettled && (!claim || claim.accepted)
}

export function traySnapshot(state: SessionSnapshot): TraySnapshot {
  const { accounts, stream, claim, claimDone, autoWatch, lastRun } = state
  return { accounts, stream, claim, claimDone, autoWatch, lastRun }
}

function withoutPrevious<T extends { previous?: T }>(item: T): T {
  const copy = { ...item }
  delete copy.previous
  return copy
}

function replaced<T extends { run: number; accepted: boolean; previous?: T }>(
  current: T | null,
  run: number
): { previous?: T } {
  if (!current) return {}
  if (current.run !== run && current.accepted) return { previous: withoutPrevious(current) }
  return current.previous ? { previous: current.previous } : {}
}

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0

const isCurrent = (data: { run?: number }, run: number | undefined): boolean =>
  data.run === undefined || data.run === run

const withRun = (state: SessionSnapshot, run: number | undefined): SessionSnapshot =>
  typeof run === 'number' && run > state.lastRun ? { ...state, lastRun: run } : state

function withLine(
  state: SessionSnapshot,
  text: string,
  tone: LogTone,
  at: number
): SessionSnapshot {
  if (!text) return state
  const entry: LogEntry = { at, text: text.slice(0, MAX_LINE), tone }
  const log = [...state.log, entry]
  return { ...state, log: log.length > LOG_LIMIT ? log.slice(log.length - LOG_LIMIT) : log }
}

function withStream(state: SessionSnapshot, patch: Partial<StreamSnapshot>): SessionSnapshot {
  return state.stream ? { ...state, stream: { ...state.stream, ...patch } } : state
}

function withClaim(state: SessionSnapshot, patch: Partial<ClaimSnapshot>): SessionSnapshot {
  return state.claim ? { ...state, claim: { ...state.claim, ...patch } } : state
}

function startStream(
  state: SessionSnapshot,
  action: Extract<SessionAction, { type: 'stream-start' }>
): SessionSnapshot {
  const { args } = action
  if (state.stream && args.run < state.stream.run) return state
  const stream: StreamSnapshot = {
    status: 'connecting',
    mode: args.mode,
    run: args.run,
    step: 0,
    accepted: false,
    restarting: false,
    startedAt: null,
    viewers: 0,
    countedSeconds: 0,
    altStatus: 'idle',
    serverId: args.serverId,
    channelId: args.channelId,
    serverName: action.serverName,
    channelName: action.channelName,
    ...replaced(state.stream, args.run)
  }
  return { ...withRun(state, args.run), stream }
}

function startClaim(
  state: SessionSnapshot,
  action: Extract<SessionAction, { type: 'claim-start' }>
): SessionSnapshot {
  const { args } = action
  const claim: ClaimSnapshot = {
    run: args.run,
    games: args.games,
    hours: args.hours,
    all: args.all,
    batch: 0,
    total: 0,
    processed: 0,
    target: 0,
    failed: 0,
    game: '',
    startedAt: action.at,
    accepted: false,
    ...replaced(state.claim, args.run)
  }
  return { ...withRun(state, args.run), claim, claimDone: null }
}

type Result = { run: number; ok: boolean; willRetry?: boolean }

function streamStartResult(state: SessionSnapshot, result: Result): SessionSnapshot {
  const stream = state.stream
  if (!stream || stream.run !== result.run) return state
  if (result.ok) return { ...state, stream: { ...withoutPrevious(stream), accepted: true } }
  return result.willRetry ? state : { ...state, stream: stream.previous ?? null }
}

function claimStartResult(state: SessionSnapshot, result: Result): SessionSnapshot {
  const claim = state.claim
  if (!claim || claim.run !== result.run) return state
  if (result.ok) return { ...state, claim: { ...withoutPrevious(claim), accepted: true } }
  return result.willRetry ? state : { ...state, claim: claim.previous ?? null }
}

function endsPrevious<T extends { run: number; previous?: T }>(
  item: T | null,
  run?: number
): boolean {
  return item?.previous !== undefined && run !== undefined && item.previous.run === run
}

function stopStream(
  state: SessionSnapshot,
  action: Extract<SessionAction, { type: 'stream-stop' }>
): SessionSnapshot {
  const counted = withRun(state, action.run)
  if (endsPrevious(counted.stream, action.run) && counted.stream) {
    return { ...counted, stream: withoutPrevious(counted.stream) }
  }
  if (!stops(counted.stream, action.run)) return counted
  return action.restart ? withStream(counted, { restarting: true }) : { ...counted, stream: null }
}

function stopClaim(
  state: SessionSnapshot,
  action: Extract<SessionAction, { type: 'claim-stop' }>
): SessionSnapshot {
  const counted = withRun(state, action.run)
  if (endsPrevious(counted.claim, action.run) && counted.claim) {
    return { ...counted, claim: withoutPrevious(counted.claim) }
  }
  return stops(counted.claim, action.run) ? { ...counted, claim: null } : counted
}

function pageGone(
  state: SessionSnapshot,
  inFlight: { stream: boolean; claim: boolean }
): SessionSnapshot {
  let { stream, claim } = state
  if (stream?.restarting) {
    stream = stream.status === 'live' ? { ...stream, restarting: false } : null
  } else if (stream && !stream.accepted && !inFlight.stream) {
    stream = stream.previous ?? null
  }
  if (claim && !claim.accepted && !inFlight.claim) claim = claim.previous ?? null
  return stream === state.stream && claim === state.claim ? state : { ...state, stream, claim }
}

const stops = (current: { run: number } | null, run: number | undefined): boolean =>
  current !== null && (run === undefined || run === current.run)

function altStatus(
  state: SessionSnapshot,
  data: EventPayloads['bridge:alt-status']
): SessionSnapshot {
  const next = data.dropped ? { ...state, accounts: { ...state.accounts, alt: null } } : state
  const stream = next.stream
  if (!stream || !isCurrent(data, stream.run)) return next
  const status: AltStatus = stream.status === 'live' && !data.dropped ? data.status : 'idle'
  return withStream(next, { altStatus: status })
}

function streamEvent(state: SessionSnapshot, event: BridgeEvent, at: number): SessionSnapshot {
  const stream = state.stream
  switch (event.channel) {
    case 'bridge:stream-step':
      if (!stream || stream.status !== 'connecting' || !isCurrent(event.data, stream.run))
        return state
      return withStream(state, { step: count(event.data.step) })
    case 'bridge:stream-live': {
      if (!stream || stream.status !== 'connecting' || !isCurrent(event.data, stream.run))
        return state
      const mode =
        event.data.mode === 'silent' || event.data.mode === 'video' ? event.data.mode : stream.mode
      return withStream(state, { status: 'live', startedAt: at, viewers: 0, step: 4, mode })
    }
    case 'bridge:viewers':
      if (!stream || stream.status !== 'live' || !isCurrent(event.data, stream.run)) return state
      return withStream(state, {
        viewers: count(event.data.count),
        countedSeconds: count(event.data.counted)
      })
    case 'bridge:stream-ended':
      if (stream && endsPrevious(stream, event.data.run)) {
        return { ...state, stream: withoutPrevious(stream) }
      }
      if (!stream || !isCurrent(event.data, stream.run)) return state
      if (!stream.restarting) return { ...state, stream: null }
      return withStream(state, {
        status: 'connecting',
        step: 0,
        accepted: false,
        startedAt: null,
        viewers: 0,
        countedSeconds: 0,
        altStatus: 'idle'
      })
    default:
      return state
  }
}

function claimEvent(state: SessionSnapshot, event: BridgeEvent): SessionSnapshot {
  const claim = state.claim
  if (event.channel === 'bridge:claim-progress') {
    if (!claim || !isCurrent(event.data, claim.run)) return state
    const d = event.data
    return withClaim(state, {
      batch: count(d.batch),
      total: count(d.total),
      processed: count(d.processed),
      target: count(d.target),
      failed: count(d.failed),
      game: typeof d.game === 'string' ? d.game : ''
    })
  }
  if (event.channel === 'bridge:claim-done') {
    if (claim && endsPrevious(claim, event.data.run)) {
      return { ...state, claim: withoutPrevious(claim) }
    }
    if (!claim || !isCurrent(event.data, claim.run)) return state
    return { ...state, claim: null, claimDone: claimDone(claim, event.data) }
  }
  return state
}

function claimDone(
  claim: ClaimSnapshot,
  data: EventPayloads['bridge:claim-done']
): ClaimDoneSnapshot | null {
  if (data.stopped || data.error) return null
  return {
    run: claim.run,
    games: count(data.games),
    hours: count(data.hours),
    hoursEach: claim.hours,
    batches: count(data.batches) || claim.total,
    failed: count(data.failed),
    failedGames: count(data.failedGames)
  }
}

function onEvent(state: SessionSnapshot, event: BridgeEvent, at: number): SessionSnapshot {
  const run = 'run' in event.data ? event.data.run : undefined
  const counted = withRun(state, typeof run === 'number' ? run : undefined)
  switch (event.channel) {
    case 'bridge:log': {
      const tone: LogTone = event.data.type === 'info' ? '' : 'pink'
      return withLine(counted, String(event.data.text ?? ''), tone, at)
    }
    case 'bridge:alt-status':
      return altStatus(counted, event.data)
    case 'bridge:backend-restart':
      return {
        ...counted,
        stream: null,
        claim: null,
        accounts: { main: null, alt: null },
        autoWatch: true
      }
    case 'bridge:claim-progress':
    case 'bridge:claim-done':
      return claimEvent(counted, event)
    case 'bridge:stream-step':
    case 'bridge:stream-live':
    case 'bridge:viewers':
    case 'bridge:stream-ended':
      return streamEvent(counted, event, at)
    default:
      return state
  }
}

function onAccounts(state: SessionSnapshot, result: AccountResult): SessionSnapshot {
  if (!result.accounts.mainId) return { ...state, accounts: { main: null, alt: null } }
  let { main, alt } = state.accounts
  if (result.login?.ok) {
    const user = result.login.user
    main = user.displayName || user.username || 'Discord user'
  }
  if (result.alt !== undefined) alt = result.alt ? result.alt.username : null
  return { ...state, accounts: { main, alt } }
}

export function reduceSession(state: SessionSnapshot, action: SessionAction): SessionSnapshot {
  switch (action.type) {
    case 'event':
      return onEvent(state, action.event, action.at)
    case 'stream-start':
      return startStream(state, action)
    case 'stream-start-result':
      return streamStartResult(state, action)
    case 'stream-stop':
      return stopStream(state, action)
    case 'claim-start':
      return startClaim(state, action)
    case 'claim-start-result':
      return claimStartResult(state, action)
    case 'claim-stop':
      return stopClaim(state, action)
    case 'claim-dismiss':
      return state.claimDone ? { ...state, claimDone: null } : state
    case 'accounts':
      return onAccounts(state, action.result)
    case 'auto-watch':
      return { ...state, autoWatch: action.enabled }
    case 'note':
      return withLine(state, action.text, action.tone, action.at)
    case 'page-gone':
      return pageGone(state, action.inFlight)
    default:
      return state
  }
}
