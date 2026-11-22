export type AccountRole = 'main' | 'alt'
export type LogType = 'info' | 'warning' | 'error'
export type StreamMode = 'video' | 'silent'
export type AltStatus = 'idle' | 'joined' | 'watching'

export type Result<T extends object = object, F extends object = object> =
  ({ ok: true } & T) | ({ ok: false; error: string } & F)

export interface EventPayloads {
  'bridge:log': { type: LogType; text: string }
  'bridge:claim-progress': {
    batch: number
    total: number
    game: string
    processed: number
    target: number
    run: number
    failed?: number
  }
  'bridge:claim-done': {
    games: number
    hours: number
    run: number
    stopped?: boolean
    error?: string
    batches?: number
    failed?: number
    failedGames?: number
  }
  'bridge:stream-step': { step: number; label: string; run: number }
  'bridge:stream-live': { mode: StreamMode; run: number; fallback?: string }
  'bridge:stream-ended': { hours: number; seconds?: number; run: number; error?: string }
  'bridge:viewers': { count: number; counted?: number; run: number }
  'bridge:alt-status': { status: AltStatus; run?: number; error?: string; dropped?: boolean }
  'bridge:backend-restart': { reason: string; final: boolean }
  'app:hide-waiting': Record<string, never>
  'app:stream-accepted': { run: number }
}

export type EventChannel = keyof EventPayloads

export interface PublicAccounts {
  mainId: string | null
  altId: string | null
  accounts: { id: string; username: string; displayName: string }[]
}

export type AltState = { username: string } | null

export interface Totals {
  games: number
  gameHours: number
  streamHours: number
  streamSessions: number
}

export type LoginResult = Result<
  {
    user: { id: string; username: string; displayName: string }
    catalog_size: number
    batch_size: number
    last_guild_id: string
    last_channel_id: string
    totals: Totals
  },
  { unanswered?: boolean }
>

interface AccountFields {
  accounts: PublicAccounts
  login?: LoginResult
  alt?: AltState
}

export type AccountResult =
  | ({ ok: true; warning?: string } & AccountFields)
  | ({ ok: false; error: string; warning?: string } & AccountFields)
  | ({ ok: false; nothingSaved: true; error?: ''; warning?: string } & AccountFields)

export interface ClaimArgs {
  games: number
  hours: number
  all: boolean
  run: number
}

export interface StreamArgs {
  serverId: string
  channelId: string
  mode: StreamMode
  run: number
}

export interface VoiceServer {
  id: string
  name: string
  icon: string
}

export interface VoiceChannel {
  id: string
  name: string
}

export type LogTone = '' | 'gold' | 'pink'

export interface LogEntry {
  at: number
  text: string
  tone: LogTone
}

export interface StreamSnapshot {
  status: 'connecting' | 'live'
  mode: StreamMode
  run: number
  step: number
  accepted: boolean
  restarting: boolean
  startedAt: number | null
  viewers: number
  countedSeconds: number
  altStatus: AltStatus
  serverId: string
  channelId: string
  serverName: string
  channelName: string
  previous?: StreamSnapshot
}

export interface ClaimSnapshot {
  run: number
  games: number
  hours: number
  all: boolean
  batch: number
  total: number
  processed: number
  target: number
  failed: number
  game: string
  startedAt: number
  accepted: boolean
  previous?: ClaimSnapshot
}

export interface ClaimDoneSnapshot {
  run: number
  games: number
  hours: number
  hoursEach: number
  batches: number
  failed: number
  failedGames: number
}

export interface SessionSnapshot {
  accounts: { main: string | null; alt: string | null }
  stream: StreamSnapshot | null
  claim: ClaimSnapshot | null
  claimDone: ClaimDoneSnapshot | null
  autoWatch: boolean
  lastRun: number
  log: LogEntry[]
}

export type TraySnapshot = Omit<SessionSnapshot, 'log'>

export type Clocked<T> = T & { now: number }

export type RunResult = Result<{ run: number }>
export type OkResult = Result
export type BadgesResult = Result<
  { tiers: Record<string, number | null>; earned: Record<string, string>; totals: Totals },
  { totals?: Totals }
>
export type VoiceServersResult = Result<{
  servers: VoiceServer[]
  withAlt: boolean
  lastGuildId: string
  lastChannelId: string
  altProblem?: string
}>
export type VoiceChannelsResult = Result<{ channels: VoiceChannel[] }>
export type AutoWatchResult = Result<{ enabled: boolean }>

export type Listener<K extends EventChannel> = (cb: (data: EventPayloads[K]) => void) => () => void

export interface BridgeAPI {
  restoreAccounts(): Promise<AccountResult>
  accountLogin(role: AccountRole): Promise<AccountResult>
  addAccount(): Promise<AccountResult>
  useAccount(id: string, role: AccountRole): Promise<AccountResult>
  clearAlt(): Promise<AccountResult>
  removeAccount(id: string): Promise<AccountResult>
  logout(): Promise<AccountResult>

  startClaim(opts: ClaimArgs): Promise<RunResult>
  stopClaim(run: number): Promise<OkResult>
  startStream(opts: StreamArgs): Promise<RunResult>
  stopStream(run?: number, restart?: boolean): Promise<OkResult>
  badges(): Promise<BadgesResult>
  voiceServers(): Promise<VoiceServersResult>
  voiceChannels(guildId: string): Promise<VoiceChannelsResult>
  setAutoWatch(enabled: boolean): Promise<AutoWatchResult>
  openLogFolder(): Promise<OkResult>
  retryBackend(): Promise<OkResult>
  sessionSnapshot(): Promise<Clocked<SessionSnapshot>>
  dismissClaim(): Promise<OkResult>
  noteLog(text: string, tone: LogTone): Promise<OkResult>

  onLog: Listener<'bridge:log'>
  onClaimProgress: Listener<'bridge:claim-progress'>
  onClaimDone: Listener<'bridge:claim-done'>
  onStreamStep: Listener<'bridge:stream-step'>
  onStreamLive: Listener<'bridge:stream-live'>
  onStreamEnded: Listener<'bridge:stream-ended'>
  onViewers: Listener<'bridge:viewers'>
  onAltStatus: Listener<'bridge:alt-status'>
  onBackendRestart: Listener<'bridge:backend-restart'>
  onHideWaiting: Listener<'app:hide-waiting'>
  onStreamAccepted: Listener<'app:stream-accepted'>
}

export interface TrayAPI {
  snapshot(): Promise<Clocked<TraySnapshot>>
  onSnapshot(cb: (snapshot: Clocked<TraySnapshot>) => void): () => void
  fit(height: number): Promise<OkResult>
  openApp(): Promise<OkResult>
  quit(): Promise<OkResult>
}
