import type { SessionAction } from './session-state'
import type { EventPayloads, LogTone, SessionSnapshot, TraySnapshot } from '../shared/ipc'

export const APP_NAME = 'Badge Maximizer'

export const TRAY_HINT =
  'Minimizing puts Badge Maximizer in the notification area, where it keeps running. Click its icon to see the stream and the claim, or right-click it to quit.'

export const PAGE_CRASH_TRAY =
  "The app's window kept crashing, so it was closed. Your stream and claim keep running. Click the tray icon to open the app again."
export const PAGE_CRASH_QUIT =
  "The app's window kept crashing, so the app closes now. Start it again, and if that keeps happening, check the activity log file."

type Running = { stream: boolean; claim: boolean }

export function minimizedStartNotice(wanted: Running, now: Running): string | null {
  const stream = wanted.stream && !now.stream
  const claim = wanted.claim && !now.claim
  if (!stream && !claim) return null
  const what = stream && claim ? 'stream and claim' : stream ? 'stream' : 'claim'
  return `Your ${what} did not start. Open the app from the taskbar to see why.`
}

export interface LogLine {
  text: string
  tone: LogTone
}

const fmt = (n: number): string => n.toLocaleString('en-US')
const pad = (n: number): string => String(n).padStart(2, '0')
const failedBatchesText = (n: number): string => `${fmt(n)} failed ${n === 1 ? 'batch' : 'batches'}`
const gamesText = (n: number): string => `${fmt(n)} ${n === 1 ? 'game' : 'games'}`

export function clockText(ms: number): string {
  const s = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`
}

export function trayTooltip(state: TraySnapshot, now: number): string {
  const lines: string[] = []
  const { stream, claim } = state
  if (stream?.status === 'live')
    lines.push(`Live for ${clockText(now - (stream.startedAt ?? now))}`)
  else if (stream) lines.push('Stream connecting')
  if (claim) {
    lines.push(
      claim.batch > 0
        ? `Claiming, batch ${fmt(claim.batch)} of ${fmt(claim.total)}`
        : 'Claiming, preparing the first batch'
    )
  }
  return [APP_NAME, ...(lines.length ? lines : ['Idle'])].join('\n')
}

const isCurrentRun = (run: number | undefined, current: { run: number } | null): boolean =>
  current !== null && (run === undefined || run === current.run)

export function streamEndNotice(before: SessionSnapshot, action: SessionAction): string | null {
  if (action.type === 'stream-start-result') {
    if (action.ok || action.willRetry || !isCurrentRun(action.run, before.stream)) return null
    return `Your stream did not start. ${action.error ?? ''}`.trim()
  }
  if (action.type !== 'event' || !before.stream) return null
  const { event } = action
  if (event.channel === 'bridge:backend-restart') {
    return "Your stream ended because the app's backend stopped. Open the app to start it again."
  }
  if (event.channel !== 'bridge:stream-ended' || !isCurrentRun(event.data.run, before.stream)) {
    return null
  }
  if (before.stream.restarting) return null
  return event.data.error
    ? `Your stream ended. ${event.data.error}`
    : 'Your stream ended. Open the app to start it again.'
}

function claimDoneLines(data: EventPayloads['bridge:claim-done']): LogLine[] {
  if (data.error) return [{ text: `The claim stopped. ${data.error}`, tone: 'pink' }]
  const games = data.games || 0
  if (games === 0) {
    return [
      {
        text: 'No batch went through, so nothing was claimed. Check your connection and start again.',
        tone: 'pink'
      }
    ]
  }
  const claimed = `${fmt(data.hours || 0)} h claimed across ${gamesText(games)}.`
  const failed = data.failed || 0
  if (failed === 0) return [{ text: `Claim finished. ${claimed}`, tone: 'gold' }]
  return [
    {
      text: `Claim finished with ${failedBatchesText(failed)}. ${claimed} Start another claim to pick up the rest.`,
      tone: 'pink'
    }
  ]
}

function refusedStartLines(
  before: SessionSnapshot,
  action: Extract<SessionAction, { type: 'stream-start-result' | 'claim-start-result' }>
): LogLine[] {
  if (action.ok || action.willRetry) return []
  const isStream = action.type === 'stream-start-result'
  if (!isCurrentRun(action.run, isStream ? before.stream : before.claim)) return []
  const what = isStream ? 'The stream' : 'The claim'
  return [{ text: `${what} did not start. ${action.error ?? ''}`.trim(), tone: 'pink' }]
}

function droppedStartLines(
  before: SessionSnapshot,
  inFlight: { stream: boolean; claim: boolean }
): LogLine[] {
  const { stream, claim } = before
  const lines: LogLine[] = []
  const streamDropped = stream?.restarting
    ? stream.status !== 'live'
    : stream !== null && !stream.accepted && !inFlight.stream
  if (streamDropped) {
    lines.push({ text: 'The stream did not start, because the window closed first.', tone: 'pink' })
  }
  if (claim && !claim.accepted && !inFlight.claim) {
    lines.push({ text: 'The claim did not start, because the window closed first.', tone: 'pink' })
  }
  return lines
}

const ALT_LINES: Record<string, string> = {
  joined: 'Alt viewer joined the channel',
  watching: 'Alt viewer is watching your stream'
}

function altLines(before: SessionSnapshot, data: EventPayloads['bridge:alt-status']): LogLine[] {
  const lines: LogLine[] = data.error ? [{ text: data.error, tone: 'pink' }] : []
  const stream = before.stream
  if (!stream || !isCurrentRun(data.run, stream)) return lines
  const next = stream.status === 'live' && !data.dropped ? data.status : 'idle'
  if (next === stream.altStatus) return lines
  const text = ALT_LINES[next] ?? 'Alt viewer left the channel'
  return [...lines, { text, tone: '' }]
}

export function closedWindowLines(before: SessionSnapshot, action: SessionAction): LogLine[] {
  if (action.type === 'stream-start-result' || action.type === 'claim-start-result') {
    return refusedStartLines(before, action)
  }
  if (action.type === 'page-gone') return droppedStartLines(before, action.inFlight)
  if (action.type !== 'event') return []
  const { event } = action
  const stream = before.stream
  switch (event.channel) {
    case 'bridge:stream-live':
      if (!stream || stream.status !== 'connecting' || !isCurrentRun(event.data.run, stream))
        return []
      return [
        { text: `Stream is live in ${stream.channelName || 'the voice channel'}`, tone: 'pink' }
      ]
    case 'bridge:stream-ended': {
      if (!stream || !isCurrentRun(event.data.run, stream) || stream.restarting) return []
      if (event.data.error) return [{ text: `The stream ended. ${event.data.error}`, tone: 'pink' }]
      const liveMs = stream.startedAt === null ? 0 : action.at - stream.startedAt
      return [{ text: `Stream stopped after ${clockText(liveMs)}`, tone: '' }]
    }
    case 'bridge:alt-status':
      return altLines(before, event.data)
    case 'bridge:claim-done':
      if (event.data.stopped || !isCurrentRun(event.data.run, before.claim)) return []
      return claimDoneLines(event.data)
    case 'bridge:backend-restart':
      return [
        {
          text: 'The part of the app that talks to Discord stopped. Open the app to log back in.',
          tone: 'pink'
        }
      ]
    default:
      return []
  }
}
