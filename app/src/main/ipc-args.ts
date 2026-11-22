import type { AccountRole, ClaimArgs, LogTone, StreamArgs } from '../shared/ipc'

export type { ClaimArgs, StreamArgs }

const MAX_GAMES = 100_000
const MAX_HOURS = 1000
const MAX_RUN = 1_000_000_000
const DISCORD_ID = /^\d{17,20}$/
export const ACCOUNT_ID = /^\d{5,25}$/

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) throw new Error('Expected an object.')
  return value as Record<string, unknown>
}

function wholeNumber(value: unknown, min: number, max: number, problem: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(problem)
  }
  return value
}

const isId = (value: unknown, pattern: RegExp): value is string =>
  typeof value === 'string' && pattern.test(value)

export function parseRole(value: unknown): AccountRole {
  if (value !== 'main' && value !== 'alt') throw new Error('The account role must be main or alt.')
  return value
}

export function parseAccountId(value: unknown): string {
  if (!isId(value, ACCOUNT_ID)) throw new Error('That is not an account ID.')
  return value
}

export function parseGuildId(value: unknown): string {
  if (!isId(value, DISCORD_ID)) throw new Error('Pick a server from the list.')
  return value
}

export function parseRun(value: unknown): number {
  return wholeNumber(value, 0, MAX_RUN, 'The run number is out of range.')
}

export function parseStopRun(value: unknown): number | undefined {
  return value === undefined ? undefined : parseRun(value)
}

export function parseClaimArgs(value: unknown): ClaimArgs {
  const v = record(value)
  return {
    games: wholeNumber(v.games, 1, MAX_GAMES, 'Pick 1 to 100,000 games.'),
    hours: wholeNumber(v.hours, 1, MAX_HOURS, 'Pick 1 to 1,000 hours per game.'),
    all: v.all === true,
    run: parseRun(v.run)
  }
}

export const MAX_LOG_NOTE = 2000
const LOG_TONES: readonly LogTone[] = ['', 'gold', 'pink']

const MAX_LOG_NOTE_INPUT = 64 * 1024

export function parseLogNote(
  text: unknown,
  tone: unknown,
  redact: (text: string) => string = (t) => t
): { text: string; tone: LogTone } {
  if (typeof text !== 'string' || !text) throw new Error('A log line must be text.')
  if (typeof tone !== 'string' || !LOG_TONES.includes(tone as LogTone)) {
    throw new Error('The log line tone is not known.')
  }
  return {
    text: redact(text.slice(0, MAX_LOG_NOTE_INPUT)).slice(0, MAX_LOG_NOTE),
    tone: tone as LogTone
  }
}

export const MIN_PANEL_HEIGHT = 80
export const MAX_PANEL_HEIGHT = 900

export function parsePanelHeight(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < MIN_PANEL_HEIGHT ||
    value > MAX_PANEL_HEIGHT
  ) {
    throw new Error('The panel height is out of range.')
  }
  return Math.ceil(value)
}

export function parseStreamArgs(value: unknown): StreamArgs {
  const v = record(value)
  const { serverId, channelId, mode } = v
  if (!isId(serverId, DISCORD_ID) || !isId(channelId, DISCORD_ID)) {
    throw new Error('Pick a server and a voice channel from the lists.')
  }
  if (mode !== 'video' && mode !== 'silent') {
    throw new Error('The stream mode must be video or silent.')
  }
  return { serverId, channelId, mode, run: parseRun(v.run) }
}
