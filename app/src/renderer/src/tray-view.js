import { claimEtaMs, clock, etaText, fmt, stepsDone } from './logic.js'

export const EMPTY_TEXT = 'Nothing is running. Streams and claims are started in the app.'

export const clockOffset = (snap, nowWall) => (Number.isFinite(snap.now) ? snap.now - nowWall : 0)

function altText(snap, stream) {
  if (!snap.accounts.alt) return 'Not connected'
  if (stream.altStatus === 'watching') return 'Watching'
  if (stream.altStatus === 'joined') return 'In the channel'
  return snap.autoWatch ? 'Waiting to join' : 'Auto-watch is off'
}

function placeText(stream) {
  if (stream.channelName && stream.serverName)
    return `${stream.channelName} on ${stream.serverName}`
  return stream.channelName || 'The voice channel you picked'
}

function streamView(snap, now) {
  const stream = snap.stream
  const place = [
    ['Channel', placeText(stream)],
    ['Sends', stream.mode === 'silent' ? 'Silent keepalive' : 'Video']
  ]
  if (stream.status !== 'live') {
    return {
      live: false,
      tag: 'Connecting',
      headline: `Step ${stepsDone(stream.step, 0)} of 4`,
      rows: place
    }
  }
  return {
    live: true,
    tag: 'LIVE',
    headline: clock(now - (stream.startedAt ?? now)),
    rows: [
      ['Viewers', `${fmt(stream.viewers)} watching`],
      ['Alt viewer', altText(snap, stream)],
      ...place
    ]
  }
}

function claimView(claim, now) {
  const pct = claim.total ? Math.round((claim.batch / claim.total) * 100) : 0
  const eta = etaText(
    claimEtaMs({ batch: claim.batch, total: claim.total, elapsedMs: now - claim.startedAt })
  )
  let failed = ''
  if (claim.failed === 1) failed = '1 batch failed so far and will not be counted'
  else if (claim.failed > 1)
    failed = `${fmt(claim.failed)} batches failed so far and will not be counted`
  return {
    title:
      claim.batch > 0
        ? `Batch ${fmt(claim.batch)} of ${fmt(claim.total)}`
        : 'Preparing the first batch',
    pct,
    detail: eta ? `${pct}%, ${eta}` : `${pct}%`,
    failed
  }
}

export function panelView(snap, now) {
  if (!snap.stream && !snap.claim) return { empty: true, text: EMPTY_TEXT }
  return {
    empty: false,
    stream: snap.stream ? streamView(snap, now) : null,
    streamIdle: 'No stream is running.',
    claim: snap.claim ? claimView(snap.claim, now) : null,
    claimIdle: 'No claim is running.'
  }
}
