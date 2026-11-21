export const GAMES = [
  'Minecraft',
  'Valorant',
  'Fortnite',
  'Rocket League',
  'Apex Legends',
  'Counter-Strike 2',
  'League of Legends',
  'Overwatch 2',
  'Elden Ring',
  'Terraria',
  'Stardew Valley',
  'Rainbow Six Siege',
  'Dota 2',
  'GTA V',
  'Cyberpunk 2077',
  'Hades II',
  "Baldur's Gate 3",
  'Deep Rock Galactic',
  'Factorio',
  'Celeste',
  'Hollow Knight',
  'Lethal Company',
  'Palworld',
  'Sea of Thieves',
  'Warframe',
  'Destiny 2',
  'Path of Exile 2',
  'Phasmophobia'
]
export const STEP_NAMES = ['Gateway', 'Voice server', 'Stream server', 'Encryption (DAVE)']
export const SECTIONS = ['account', 'games', 'stream', 'alt', 'badges', 'activity']
export const MAX_TIER = 10
export const MAX_HOURS_PER_GAME = 1000
export const STREAM_TIERS = [
  [1, 'Newcomer'],
  [5, 'Fledgling'],
  [20, 'Breakout'],
  [75, 'Standout'],
  [150, 'Trendsetter'],
  [300, 'Headliner'],
  [500, 'Star'],
  [1000, 'Sensation'],
  [2000, 'Visionary'],
  [5000, 'Phenomenon']
]

export const fmt = (n) => n.toLocaleString('en-US')
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v))
export const smooth = (t) => t * t * (3 - 2 * t)
export const pad = (n) => String(n).padStart(2, '0')

export function clock(ms) {
  const s = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`
}

export function stamp(date) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

export const isCurrent = (d, run) => !d || d.run === undefined || d.run === run

export const firstLetter = (text) => ([...String(text ?? '').trim()][0] || '?').toUpperCase()

const WHOLE_NUMBER = /^\d+$/
const wholeNumber = (text) =>
  WHOLE_NUMBER.test(String(text).trim()) ? Number(String(text).trim()) : NaN

export function parseGamesInput({ countText, hoursText, all, catalog }) {
  const count = all ? catalog : wholeNumber(countText)
  const hours = wholeNumber(hoursText)
  return {
    count,
    hours,
    countOk: Number.isInteger(count) && count >= 1 && (catalog > 0 ? count <= catalog : !all),
    hoursOk: Number.isInteger(hours) && hours >= 1 && hours <= MAX_HOURS_PER_GAME
  }
}

const STEP_DONE = { 0: 0, 1: 1, 2: 1, 3: 2, 4: 4 }
export const stepsDone = (backendStep, current) => STEP_DONE[backendStep] ?? current

export function claimSummary(d, hoursEach, plannedBatches = 0) {
  const games = d.games || 0
  const hours = d.hours || 0
  const batches = d.batches || plannedBatches
  const failed = d.failed || 0
  if (games === 0) {
    return {
      kind: 'failed',
      share: 0,
      text: 'No batch went through, so nothing was claimed. Check your connection and start again.'
    }
  }
  if (failed === 0) {
    const text =
      games === 1
        ? `Batch sent. ${fmt(hours)} h claimed for 1 game.`
        : `All ${fmt(batches)} batches sent. ${fmt(hours)} h claimed across ${countOf(games, 'game')} at ${fmt(hoursEach)} h each.`
    return { kind: 'done', share: 1, text }
  }
  const missed = d.failedGames || 0
  const missedText =
    missed > 0
      ? `${countOf(missed, 'game')} ${missed === 1 ? 'was' : 'were'} not claimed, so start another claim to pick ${missed === 1 ? 'it' : 'them'} up.`
      : 'Some games were not claimed, so start another claim to pick them up.'
  return {
    kind: 'partial',
    share: batches > 0 ? (batches - failed) / batches : 0,
    text: `${fmt(batches - failed)} of ${fmt(batches)} batches went through. ${fmt(hours)} h claimed across ${countOf(games, 'game')}. ${missedText}`
  }
}

export function countOf(n, singular, plural = `${singular}s`) {
  return `${fmt(n)} ${n === 1 ? singular : plural}`
}

export function claimEtaMs({ batch, total, elapsedMs }) {
  if (!(batch >= 1) || !(total >= batch)) return null
  return Math.round((elapsedMs / batch) * (total - batch))
}

export function etaText(ms) {
  if (ms === null || ms === undefined) return ''
  const minutes = Math.round(ms / 60_000)
  if (ms < 60_000) return 'under a minute left'
  if (minutes < 90) return `about ${minutes} min left`
  const rest = minutes % 60
  return rest
    ? `about ${Math.floor(minutes / 60)} h ${rest} min left`
    : `about ${minutes / 60} h left`
}

export function streamTierName(tier) {
  return tier >= 1 && tier <= STREAM_TIERS.length ? STREAM_TIERS[tier - 1][1] : ''
}

const BADGE_RANGE = {
  gametime: 'Tiers run from Casual to Eternal',
  variety: 'Tiers run from Sampler to Universalist'
}

export function badgeView({ kind, tier, earned, loggedIn, totals, streamedHours }) {
  const known = loggedIn && tier ? tier : 0
  let tierText = 'Log in to see your badges'
  if (loggedIn) {
    if (known)
      tierText = `Tier ${known} of ${MAX_TIER}${kind === 'stream' ? `, ${streamTierName(known)}` : ''}`
    else tierText = earned ? 'Earned on your profile' : 'Not on your profile yet'
  }
  let nextText = ''
  if (loggedIn) {
    if (kind === 'gametime')
      nextText = `${fmt(Math.round(totals.gameHours))} h claimed with this app`
    else if (kind === 'variety') nextText = `${fmt(totals.games)} games claimed with this app`
    else nextText = `${streamedHours.toFixed(1)} h streamed with this app`
  }
  let rangeText = BADGE_RANGE[kind] ?? ''
  if (kind === 'stream') {
    const next = STREAM_TIERS[known]
    rangeText = next
      ? `Tier ${known + 1} ${next[1]} is reached at ${fmt(next[0])} h`
      : 'Top tier reached'
  }
  if (loggedIn && earned && !known) rangeText = 'Discord shows the tier on the badge icon only'
  return {
    tierText,
    nextText,
    rangeText,
    showBar: known > 0,
    barPct: (known / MAX_TIER) * 100,
    tier: known
  }
}

const nameOf = (acct) => acct.displayName || acct.username || 'Discord user'

export function accountRows({ accounts, mainId, altId, loggedIn, confirmSwitch }) {
  const mainLabel = (acct) => (confirmSwitch === acct.id ? 'Click again to switch' : 'Use as main')
  const row = (acct, actions) => ({
    id: acct.id,
    name: nameOf(acct),
    initial: firstLetter(nameOf(acct)),
    isMain: acct.id === mainId,
    isAlt: acct.id === altId,
    actions
  })
  const useMain = (acct, label, primary = false) => ({
    label,
    action: 'useAccount',
    role: 'main',
    primary
  })
  const useAlt = { label: 'Use as alt', action: 'useAccount', role: 'alt', primary: false }
  const remove = { label: 'Remove', action: 'removeAccount', role: '', primary: false }

  const rank = (a) => (a.id === mainId ? 0 : a.id === altId ? 1 : 2)
  const menu = [...accounts]
    .sort((a, b) => rank(a) - rank(b))
    .map((acct) => {
      const actions = []
      if (acct.id !== mainId) actions.push(useMain(acct, mainLabel(acct)))
      if (acct.id !== mainId && acct.id !== altId) actions.push(useAlt)
      actions.push(remove)
      return row(acct, actions)
    })
  const others = accounts.filter((a) => a.id !== mainId || !loggedIn)
  const hero = {
    label: loggedIn ? 'Your other accounts' : 'Saved accounts',
    rows: others.map((acct) =>
      row(acct, [useMain(acct, loggedIn ? mainLabel(acct) : 'Continue', !loggedIn)])
    )
  }
  const alt = accounts
    .filter((a) => a.id !== mainId && a.id !== altId)
    .map((acct) => row(acct, [useAlt]))
  return { menu, hero, alt }
}

export function accountsSignature({ accounts, mainId, altId, loggedIn, confirmSwitch }) {
  return JSON.stringify([
    accounts.map((a) => [a.id, nameOf(a)]),
    mainId,
    altId,
    loggedIn,
    confirmSwitch
  ])
}

export function altHint({ account, autoWatch, live, status }) {
  if (account !== 'in') return 'Connect an alt account, then start the stream.'
  if (!autoWatch) return 'Auto-watch is off. Turn it on so the alt joins when you go live.'
  if (!live) return 'Ready. The alt joins as soon as your stream is live.'
  if (status === 'joined') return 'In your voice channel. Opening the stream.'
  if (status === 'watching') return 'Watching. Your streaming hours are counting.'
  return 'Your stream is live. Waiting for the alt to join.'
}

export const isBusyRefusal = (error) => /still stopping/i.test(String(error ?? ''))

export function startResultAction({ ok, error, sameRun, status, attempt, maxAttempts }) {
  if (ok) return sameRun && status !== 'off' ? 'accepted' : 'stop'
  if (!sameRun || status !== 'connecting') return 'ignore'
  if (isBusyRefusal(error)) return attempt < maxAttempts ? 'retry' : 'giveUp'
  return 'fail'
}

export function claimStartAction({ ok, error, sameRun, running, attempt, maxAttempts }) {
  if (ok) return sameRun && running ? 'accepted' : 'stop'
  if (!sameRun || !running) return 'ignore'
  return isBusyRefusal(error) && attempt < maxAttempts ? 'retry' : 'fail'
}

export function modeChangeAction({ status, accepted, mode, restartAs }) {
  if (status === 'off') return 'none'
  if (status === 'connecting' && !accepted) return 'retarget'
  return mode === restartAs ? 'none' : 'switch'
}

const hoursOrZero = (n) => (Number.isFinite(n) ? n : 0)

const SOFTWARE_RENDERER = /swiftshader|basic render|llvmpipe|softpipe|software/i

export function isSoftwareRenderer(name) {
  return SOFTWARE_RENDERER.test(String(name ?? ''))
}

export function streamedHours({ savedHours, live, countedSeconds, endedHours }) {
  const liveHours = live ? hoursOrZero(countedSeconds) / 3600 : 0
  return hoursOrZero(savedHours) + liveHours + hoursOrZero(endedHours)
}
