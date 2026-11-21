import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'child_process'
import { existsSync } from 'fs'
import { join, win32 } from 'path'
import { createInterface } from 'readline'
import { withoutExposingEnvironment } from './command-line'
import { redactSecrets } from './discord-auth'
import { errorMessage } from './errors'
import type {
  AutoWatchResult,
  BadgesResult,
  ClaimArgs,
  EventChannel,
  EventPayloads,
  LoginResult,
  OkResult,
  Result,
  RunResult,
  StreamArgs,
  VoiceChannelsResult,
  VoiceServersResult
} from '../shared/ipc'

export type SendFn = <K extends EventChannel>(channel: K, data: EventPayloads[K]) => void
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions
) => ChildProcess

export type LegacyLoginResult = Result<{
  found?: unknown
  token?: unknown
  cookie?: unknown
  altToken?: unknown
}>
export type ConnectAltResult = Result<{ username?: unknown }>

export interface BridgeOptions {
  scriptsDir: string
  dataDir: string
  send: SendFn
  backendExe?: string | null
  ffmpegDir?: string | null
  spawn?: SpawnFn
  fileExists?: (path: string) => boolean
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  log?: (message: string) => void
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

interface RunningBackend {
  proc: ChildProcess
  startedAt: number
}

export const EVENT_CHANNELS: Record<string, EventChannel> = {
  log: 'bridge:log',
  'claim-progress': 'bridge:claim-progress',
  'claim-done': 'bridge:claim-done',
  'stream-step': 'bridge:stream-step',
  'stream-live': 'bridge:stream-live',
  'stream-ended': 'bridge:stream-ended',
  viewers: 'bridge:viewers',
  'alt-status': 'bridge:alt-status'
}

export const LONG_TIMEOUT_METHODS: ReadonlySet<string> = new Set([
  'validate',
  'legacy-login',
  'badges',
  'voice-servers',
  'voice-channels',
  'connect-alt',
  'disconnect-alt',
  'set-auto-watch',
  'logout',
  'claim',
  'stream'
])
const LONG_RPC_MS = 5 * 60_000
const SHORT_RPC_MS = 30_000
const EARLY_STOP_MS = 60_000
const MAX_START_FAILURES = 3
const FAILURE_RESET_MS = 30_000
export const SHUTDOWN_WAIT_MS = 11_000
export const TASKKILL_WAIT_MS = 2000
const PY_LAUNCHER_NO_PYTHON = 103

const EXE_MISSING =
  "The app's backend (badge-backend.exe) is missing or was blocked. Check your antivirus quarantine, or install the app again."
const PYTHON_MISSING = 'Python 3.11 was not found. Install it, then start the app again.'
const keepsStopping = (cause: string, installed: boolean): string =>
  `The app's backend keeps stopping right after it starts (${cause}). ${
    installed ? 'Install the app again' : 'Check your Python 3.11 setup'
  }, or check the activity log file.`
const STOPPED_UNEXPECTEDLY = 'it stopped unexpectedly'

export function findPythonLauncher(
  env: NodeJS.ProcessEnv,
  fileExists: (path: string) => boolean
): string | null {
  const candidates = [
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs', 'Python', 'Launcher', 'py.exe'),
    env.SystemRoot && join(env.SystemRoot, 'py.exe'),
    env.ProgramFiles && join(env.ProgramFiles, 'Python Launcher', 'py.exe')
  ].filter((p): p is string => Boolean(p))
  return candidates.find((p) => fileExists(p)) ?? null
}

const errorCode = (e: unknown): string =>
  typeof e === 'object' && e !== null && typeof (e as { code?: unknown }).code === 'string'
    ? (e as { code: string }).code
    : errorMessage(e)

function redactFields(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === 'string') out[key] = redactSecrets(value)
    else if (Array.isArray(value))
      out[key] = value.map((v) => (typeof v === 'string' ? redactSecrets(v) : v))
    else out[key] = value
  }
  return out
}

class BackendRefusal extends Error {}

const LOG_TYPES = new Set(['info', 'warning', 'error'])
export const DETAIL_PREFIX = 'detail: '

export class PythonBridge {
  private running: RunningBackend | null = null
  private pending = new Map<string, Pending>()
  private nextId = 1
  private shuttingDown = false
  private startFailures = 0
  private lastFailureAt = 0
  private gaveUpWith: string | null = null

  private readonly scriptsDir: string
  private readonly dataDir: string
  private readonly send: SendFn
  private readonly backendExe: string | null
  private readonly ffmpegDir: string | null
  private readonly spawnFn: SpawnFn
  private readonly fileExists: (path: string) => boolean
  private readonly platform: NodeJS.Platform
  private readonly env: NodeJS.ProcessEnv
  private readonly log: (message: string) => void

  constructor(options: BridgeOptions) {
    this.scriptsDir = options.scriptsDir
    this.dataDir = options.dataDir
    this.send = options.send
    this.backendExe = options.backendExe ?? null
    this.ffmpegDir = options.ffmpegDir ?? null
    this.spawnFn = options.spawn ?? nodeSpawn
    this.fileExists = options.fileExists ?? existsSync
    this.platform = options.platform ?? process.platform
    this.env = options.env ?? process.env
    this.log = options.log ?? ((m) => console.warn(m))
  }

  private backendEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...withoutExposingEnvironment(this.env),
      PYTHONUNBUFFERED: '1',
      PYTHONUTF8: '1',
      BADGE_DATA_DIR: this.dataDir
    }
    if (this.backendExe) {
      env.BADGE_FFMPEG = ''
      env.BADGE_FFMPEG_ONLY = '1'
    }
    const ffmpeg = this.ffmpegDir && join(this.ffmpegDir, 'ffmpeg.exe')
    if (this.ffmpegDir && ffmpeg && this.fileExists(ffmpeg)) {
      env.BADGE_FFMPEG = ffmpeg
      const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH'
      const separator = this.platform === 'win32' ? ';' : ':'
      env[pathKey] = [this.ffmpegDir, env[pathKey]].filter(Boolean).join(separator)
    }
    return env
  }

  private backendCommand(): { command: string; args: string[] } | { problem: string } {
    if (this.backendExe) {
      return this.fileExists(this.backendExe)
        ? { command: this.backendExe, args: [] }
        : { problem: EXE_MISSING }
    }
    const adapterPath = join(this.scriptsDir, 'bridge_adapter.py')
    if (this.platform !== 'win32') return { command: 'python3', args: ['-I', adapterPath] }
    const launcher = findPythonLauncher(this.env, this.fileExists)
    return launcher
      ? { command: launcher, args: ['-3.11', '-I', adapterPath] }
      : { problem: PYTHON_MISSING }
  }

  private giveUp(reason: string): void {
    this.gaveUpWith = reason
    this.lastFailureAt = Date.now()
    this.send('bridge:backend-restart', { reason, final: true })
  }

  private ensureAdapter(): ChildProcess {
    if (this.shuttingDown) throw new Error('The app is closing.')
    if (this.running) return this.running.proc
    if (Date.now() - this.lastFailureAt >= FAILURE_RESET_MS) {
      this.startFailures = 0
      this.gaveUpWith = null
    }
    if (this.gaveUpWith) throw new Error(this.gaveUpWith)

    const command = this.backendCommand()
    if ('problem' in command) {
      this.giveUp(command.problem)
      throw new Error(command.problem)
    }
    let proc: ChildProcess
    try {
      proc = this.spawnFn(command.command, command.args, {
        cwd: this.scriptsDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: this.backendEnv()
      })
    } catch (e) {
      const cause = `couldn't start (${errorCode(e)})`
      const gaveUp = this.countStartFailure(cause, true)
      throw new Error(gaveUp ?? `The backend stopped (${cause}).`, { cause: e })
    }
    this.watch(proc)
    return proc
  }

  private watch(proc: ChildProcess): void {
    const backend: RunningBackend = { proc, startedAt: Date.now() }
    this.running = backend

    createInterface({ input: proc.stdout! }).on('line', (line) => this.handleLine(line))
    createInterface({ input: proc.stderr! }).on('line', (line) => this.handleStderr(line))
    proc.stdin!.on('error', (err) =>
      this.failPending(`The backend stopped taking commands (${redactSecrets(err.message)}).`)
    )
    proc.on('error', (err) => {
      if (proc.pid === undefined) this.onAdapterGone(backend, `couldn't start (${errorCode(err)})`)
      else this.log(`Backend process error: ${redactSecrets(errorMessage(err))}`)
    })
    proc.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (proc.pid === undefined) this.onAdapterGone(backend, "couldn't start")
      else this.onAdapterGone(backend, code !== null ? `exit code ${code}` : `stopped by ${signal}`)
    })
  }

  private failPending(message: string): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error(message))
    }
    this.pending.clear()
  }

  private countStartFailure(cause: string, couldNotSpawn: boolean): string | null {
    this.startFailures++
    this.lastFailureAt = Date.now()
    if (this.startFailures < MAX_START_FAILURES) return null
    const problem = this.startProblem(cause, couldNotSpawn)
    this.giveUp(problem)
    return problem
  }

  private startProblem(cause: string, couldNotSpawn: boolean): string {
    if (this.backendExe && couldNotSpawn) return EXE_MISSING
    if (!this.backendExe && cause === `exit code ${PY_LAUNCHER_NO_PYTHON}`) return PYTHON_MISSING
    return keepsStopping(cause, this.backendExe !== null)
  }

  private onAdapterGone(backend: RunningBackend, cause: string): void {
    if (this.running !== backend) return
    this.running = null
    if (this.shuttingDown) {
      this.failPending('The app is closing.')
      return
    }
    this.log(`Backend stopped: ${cause}`)
    const failedStart = Date.now() - backend.startedAt < EARLY_STOP_MS
    if (!failedStart) this.startFailures = 0
    const couldNotSpawn = backend.proc.pid === undefined
    const gaveUp = failedStart ? this.countStartFailure(cause, couldNotSpawn) : null
    if (gaveUp) {
      this.failPending(gaveUp)
      return
    }
    this.failPending(`The backend stopped (${cause}).`)
    this.send('bridge:backend-restart', { reason: STOPPED_UNEXPECTEDLY, final: false })
  }

  private handleStderr(line: string): void {
    const text = redactSecrets(line.trim())
    if (!text) return
    if (line.startsWith(DETAIL_PREFIX)) this.log(`Backend ${text}`)
    else this.send('bridge:log', { type: 'error', text })
  }

  private handleLine(line: string): void {
    let msg: unknown
    try {
      msg = JSON.parse(line)
    } catch {
      if (line.trim()) this.send('bridge:log', { type: 'info', text: redactSecrets(line) })
      return
    }
    if (typeof msg !== 'object' || msg === null) return
    const { id, result, error, event, data } = msg as Record<string, unknown>

    if (typeof id === 'string') {
      const p = this.pending.get(id)
      if (!p) return
      this.pending.delete(id)
      clearTimeout(p.timer)
      if (error !== undefined && error !== null) {
        p.reject(
          new BackendRefusal(redactSecrets(String(error)) || 'The backend reported a problem.')
        )
      } else p.resolve(result)
      return
    }

    const channel =
      typeof event === 'string' && Object.hasOwn(EVENT_CHANNELS, event)
        ? EVENT_CHANNELS[event]
        : undefined
    if (!channel || typeof data !== 'object' || data === null || Array.isArray(data)) return
    const fields = redactFields(data as Record<string, unknown>)
    if (channel === 'bridge:log') {
      const type = LOG_TYPES.has(fields.type as string) ? fields.type : 'info'
      const text = typeof fields.text === 'string' ? fields.text : String(fields.text ?? '')
      this.send('bridge:log', { type, text } as EventPayloads['bridge:log'])
      return
    }
    this.send(channel, fields as never)
  }

  private rpc(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const proc = this.ensureAdapter()
    const id = String(this.nextId++)
    return new Promise((resolve, reject) => {
      if (!proc.stdin || proc.stdin.destroyed) {
        reject(new Error('The backend is not running.'))
        return
      }
      const timer = setTimeout(
        () => {
          if (this.pending.delete(id)) reject(new Error('The backend took too long to answer.'))
        },
        LONG_TIMEOUT_METHODS.has(method) ? LONG_RPC_MS : SHORT_RPC_MS
      )
      this.pending.set(id, { resolve, reject, timer })
      proc.stdin.write(JSON.stringify({ id, method, params }) + '\n')
    })
  }

  private async call<R extends Result<object, object>>(
    method: string,
    params: Record<string, unknown> = {}
  ): Promise<R> {
    try {
      const result = await this.rpc(method, params)
      const fields = typeof result === 'object' && result !== null ? result : {}
      const out: Record<string, unknown> = { ok: true, ...fields }
      if (out.ok === false) {
        const error = typeof out.error === 'string' ? out.error : ''
        out.error = redactSecrets(error) || 'The backend reported a problem.'
      } else if (typeof out.error === 'string') {
        out.error = redactSecrets(out.error)
      }
      return out as R
    } catch (e) {
      const error = redactSecrets(errorMessage(e))
      return (
        e instanceof BackendRefusal ? { ok: false, error } : { ok: false, error, unanswered: true }
      ) as R
    }
  }

  retry(): void {
    this.startFailures = 0
    this.gaveUpWith = null
    this.lastFailureAt = 0
  }

  isRunning(): boolean {
    return this.running !== null
  }

  validateCredentials(token: string, cookie: string): Promise<LoginResult> {
    return this.call('validate', { token, cookie })
  }

  startClaim(args: ClaimArgs): Promise<RunResult> {
    return this.call('claim', { ...args })
  }

  stopClaim(run?: number): Promise<OkResult> {
    return this.call('stop-claim', run === undefined ? {} : { run })
  }

  startStream(args: StreamArgs): Promise<RunResult> {
    return this.call('stream', { ...args })
  }

  stopStream(run?: number): Promise<OkResult> {
    return this.call('stop-stream', run === undefined ? {} : { run })
  }

  connectAlt(token: string): Promise<ConnectAltResult> {
    return this.call('connect-alt', { token })
  }

  disconnectAlt(): Promise<OkResult> {
    return this.call('disconnect-alt')
  }

  legacyLogin(): Promise<LegacyLoginResult> {
    return this.call('legacy-login')
  }

  legacyClear(): Promise<OkResult> {
    return this.call('legacy-clear')
  }

  logout(): Promise<OkResult> {
    return this.call('logout')
  }

  badges(): Promise<BadgesResult> {
    return this.call('badges')
  }

  voiceServers(): Promise<VoiceServersResult> {
    return this.call('voice-servers')
  }

  voiceChannels(guildId: string): Promise<VoiceChannelsResult> {
    return this.call('voice-channels', { guildId })
  }

  setAutoWatch(enabled: boolean): Promise<AutoWatchResult> {
    return this.call('set-auto-watch', { enabled })
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true
    const proc = this.running?.proc
    if (!proc) return
    const ended = new Promise<boolean>((resolve) => proc.once('close', () => resolve(true)))
    try {
      proc.stdin?.write(JSON.stringify({ id: 'shutdown', method: 'shutdown' }) + '\n')
    } catch (e) {
      this.log(`Could not ask the backend to shut down: ${errorMessage(e)}`)
    }
    if (await this.within(ended, SHUTDOWN_WAIT_MS)) return
    this.log('The backend did not stop in time; ending its process tree')
    await this.killTree(proc)
  }

  private within(promise: Promise<unknown>, ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), ms)
      void promise.then(() => {
        clearTimeout(timer)
        resolve(true)
      })
    })
  }

  private async killTree(proc: ChildProcess): Promise<void> {
    if (this.platform !== 'win32' || proc.pid === undefined) {
      proc.kill('SIGKILL')
      return
    }
    const taskkill = win32.join(this.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')
    try {
      const killer = this.spawnFn(taskkill, ['/PID', String(proc.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true
      })
      const done = new Promise<void>((resolve) => {
        killer.once('close', () => resolve())
        killer.once('error', (e) => {
          this.log(`taskkill failed: ${errorMessage(e)}`)
          proc.kill()
          resolve()
        })
      })
      await this.within(done, TASKKILL_WAIT_MS)
    } catch (e) {
      this.log(`taskkill failed: ${errorMessage(e)}`)
      proc.kill()
    }
  }
}
