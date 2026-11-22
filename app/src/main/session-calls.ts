import { isBusyRefusal } from './session-state'
import type { SessionTracker } from './session-tracker'
import type { VoiceNames } from './voice-names'
import type { PythonBridge } from './bridge'
import type { ClaimArgs, EventPayloads, OkResult, RunResult, StreamArgs } from '../shared/ipc'

export interface SessionCallsDeps {
  tracker: Pick<SessionTracker, 'apply' | 'snapshot'>
  names: Pick<VoiceNames, 'server' | 'channel'>
  bridge: Pick<PythonBridge, 'startStream' | 'stopStream' | 'startClaim' | 'stopClaim'>
  page: () => { generation: number; listening: boolean }
  send: <K extends 'bridge:stream-ended' | 'bridge:claim-done' | 'app:stream-accepted'>(
    channel: K,
    data: EventPayloads[K]
  ) => void
  now: () => number
}

export class SessionCalls {
  private waiting: { stream: number | null; claim: number | null } = { stream: null, claim: null }

  constructor(private readonly deps: SessionCallsDeps) {}

  inFlight(): { stream: boolean; claim: boolean } {
    const { stream, claim } = this.deps.tracker.snapshot
    return {
      stream: stream !== null && this.waiting.stream === stream.run,
      claim: claim !== null && this.waiting.claim === claim.run
    }
  }

  async startStream(args: StreamArgs): Promise<RunResult> {
    const { tracker, names } = this.deps
    const asked = this.deps.page().generation
    tracker.apply({
      type: 'stream-start',
      args,
      serverName: names.server(args.serverId),
      channelName: names.channel(args.channelId),
      at: this.deps.now()
    })
    this.waiting.stream = args.run
    const res = await this.deps.bridge.startStream(args)
    if (this.waiting.stream === args.run) this.waiting.stream = null
    const current = tracker.snapshot.stream?.run === args.run
    const retry = !res.ok && this.pageRetries(asked, res.error)
    tracker.apply({
      type: 'stream-start-result',
      run: args.run,
      ok: res.ok,
      ...(res.ok ? {} : { error: res.error, willRetry: retry })
    })
    if (current && asked !== this.deps.page().generation) {
      if (res.ok) this.deps.send('app:stream-accepted', { run: args.run })
      else this.deps.send('bridge:stream-ended', { hours: 0, run: args.run, error: res.error })
    }
    return res
  }

  stopStream(run: number | undefined, restart: boolean): Promise<OkResult> {
    this.deps.tracker.apply({ type: 'stream-stop', run, restart })
    return this.deps.bridge.stopStream(run)
  }

  async startClaim(args: ClaimArgs): Promise<RunResult> {
    const { tracker } = this.deps
    const asked = this.deps.page().generation
    tracker.apply({ type: 'claim-start', args, at: this.deps.now() })
    this.waiting.claim = args.run
    const res = await this.deps.bridge.startClaim(args)
    if (this.waiting.claim === args.run) this.waiting.claim = null
    const current = tracker.snapshot.claim?.run === args.run
    const retry = !res.ok && this.pageRetries(asked, res.error)
    tracker.apply({
      type: 'claim-start-result',
      run: args.run,
      ok: res.ok,
      ...(res.ok ? {} : { error: res.error, willRetry: retry })
    })
    if (!res.ok && current && asked !== this.deps.page().generation) {
      this.deps.send('bridge:claim-done', { games: 0, hours: 0, run: args.run, error: res.error })
    }
    return res
  }

  stopClaim(run: number | undefined): Promise<OkResult> {
    this.deps.tracker.apply({ type: 'claim-stop', run })
    return this.deps.bridge.stopClaim(run)
  }

  private pageRetries(asked: number, error: string): boolean {
    const page = this.deps.page()
    return isBusyRefusal(error) && page.listening && page.generation === asked
  }
}
