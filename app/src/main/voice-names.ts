import type { VoiceChannelsResult, VoiceServersResult } from '../shared/ipc'

export const MAX_NAMES = 1000

function remember(book: Map<string, string>, list: unknown): void {
  if (!Array.isArray(list)) return
  for (const item of list) {
    const { id, name } = (item ?? {}) as { id?: unknown; name?: unknown }
    if (typeof id !== 'string' || typeof name !== 'string') continue
    book.delete(id)
    book.set(id, name)
  }
  for (const oldest of book.keys()) {
    if (book.size <= MAX_NAMES) break
    book.delete(oldest)
  }
}

export class VoiceNames {
  private readonly servers = new Map<string, string>()
  private readonly channels = new Map<string, string>()

  rememberServers(result: VoiceServersResult): void {
    if (result.ok) remember(this.servers, result.servers)
  }

  rememberChannels(result: VoiceChannelsResult): void {
    if (result.ok) remember(this.channels, result.channels)
  }

  server(id: string): string {
    return this.servers.get(id) ?? ''
  }

  channel(id: string): string {
    return this.channels.get(id) ?? ''
  }
}
