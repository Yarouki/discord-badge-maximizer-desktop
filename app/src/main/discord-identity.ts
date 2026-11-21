import { ACCOUNT_ID } from './ipc-args'

export interface DiscordIdentity {
  id: string
  username: string
  displayName: string
}

export class DiscordRefusedError extends Error {
  constructor() {
    super("Discord didn't accept this login.")
    this.name = 'DiscordRefusedError'
  }
}

const ME_URL = 'https://discord.com/api/v9/users/@me'
const TIMEOUT_MS = 10_000
const UNEXPECTED = 'Discord sent an unexpected account.'

export function parseIdentity(body: unknown): DiscordIdentity {
  const v = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  const id = typeof v.id === 'string' && ACCOUNT_ID.test(v.id) ? v.id : ''
  if (!id) throw new Error(UNEXPECTED)
  const clean = (x: unknown): string =>
    typeof x === 'string' ? x.replace(/[\p{Cc}\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu, '') : ''
  const username = clean(v.username)
  const displayName = clean(v.global_name) || username
  return { id, username, displayName: displayName || 'Discord user' }
}

function isHeaderValue(value: string): boolean {
  try {
    new Headers({ authorization: value })
    return true
  } catch {
    return false
  }
}

const isBadHeaderError = (e: unknown): boolean =>
  e instanceof TypeError && /header/i.test(e.message)

export async function fetchIdentity(token: string): Promise<DiscordIdentity> {
  if (!isHeaderValue(token)) throw new DiscordRefusedError()
  let res: Response
  try {
    res = await fetch(ME_URL, {
      headers: { authorization: token },
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
  } catch (e) {
    if (isBadHeaderError(e)) throw new DiscordRefusedError()
    throw new Error("Couldn't reach Discord. Check your internet connection.", { cause: e })
  }
  if (res.status === 401 || res.status === 403) throw new DiscordRefusedError()
  if (!res.ok) throw new Error(`Discord answered with HTTP ${res.status}.`)
  let body: unknown
  try {
    body = await res.json()
  } catch {
    throw new Error(UNEXPECTED)
  }
  return parseIdentity(body)
}
