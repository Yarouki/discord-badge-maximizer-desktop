import { claimSummary, stamp, stepsDone } from './logic.js'

const TONES = new Set(['', 'gold', 'pink'])
const RUN_EPOCH = Date.UTC(2025, 0, 1)

export const toPagetime = (at, now, nowPerf) => nowPerf - (now - at)

export function runAfterBoot(adopted, nowWall) {
  return adopted ? adopted.lastRun : Math.max(1, Math.floor((nowWall - RUN_EPOCH) / 1000))
}

function adoptDone(d) {
  const summary = claimSummary(d, d.hoursEach, d.batches)
  if (summary.kind === 'failed') return null
  return {
    status: 'done',
    count: d.games,
    hours: d.hoursEach,
    all: false,
    batch: d.batches,
    total: d.batches,
    failed: d.failed,
    game: '',
    startedAt: 0,
    summary,
    run: d.run
  }
}

function adoptStream(s, nowWall, nowPerf) {
  const live = s.status === 'live'
  return {
    status: live ? 'live' : 'connecting',
    step: live ? 4 : stepsDone(s.step, 0),
    mode: s.mode,
    liveMode: s.mode,
    startedAt: live && s.startedAt !== null ? toPagetime(s.startedAt, nowWall, nowPerf) : 0,
    viewers: s.viewers,
    counted: s.countedSeconds,
    run: s.run,
    accepted: s.accepted,
    restartAs: null
  }
}

function adoptClaim(c, nowWall, nowPerf, batchSize) {
  return {
    status: 'running',
    count: c.games,
    hours: c.hours,
    all: c.all,
    batch: c.batch,
    total: c.total || Math.ceil(c.games / batchSize),
    failed: c.failed,
    game: c.game,
    startedAt: toPagetime(c.startedAt, nowWall, nowPerf),
    summary: null,
    run: c.run
  }
}

function adoptLog(entries) {
  const usable = (Array.isArray(entries) ? entries : []).filter(
    (e) => e && typeof e.text === 'string' && e.text && Number.isFinite(e.at)
  )
  return usable
    .map((e) => ({
      time: stamp(new Date(e.at)),
      text: e.text,
      cls: TONES.has(e.tone) ? e.tone : ''
    }))
    .reverse()
}

export function adoptSnapshot(snap, { nowWall, nowPerf, batchSize }) {
  if (!snap) return null
  const now = Number.isFinite(snap.now) ? snap.now : nowWall
  const stream = snap.stream ? adoptStream(snap.stream, now, nowPerf) : null
  let claim = snap.claim ? adoptClaim(snap.claim, now, nowPerf, batchSize) : null
  if (!claim && snap.claimDone) claim = adoptDone(snap.claimDone)
  return {
    stream,
    claim,
    altStatus: stream?.status === 'live' ? snap.stream.altStatus : 'idle',
    autoWatch: snap.autoWatch !== false,
    lastRun: snap.lastRun || 0,
    target: snap.stream
      ? { serverId: snap.stream.serverId, channelId: snap.stream.channelId }
      : null,
    log: adoptLog(snap.log)
  }
}
