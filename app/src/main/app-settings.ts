import { randomUUID } from 'crypto'
import { readFileSync, renameSync, rmSync } from 'fs'
import { writeDurably } from './account-store'

export interface AppSettings {
  trayHintShown: boolean
}

export const DEFAULT_SETTINGS: Readonly<AppSettings> = Object.freeze({ trayHintShown: false })

export function readSettings(file: string): AppSettings {
  let data: unknown
  try {
    data = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data))
    return { ...DEFAULT_SETTINGS }
  const { trayHintShown } = data as Record<string, unknown>
  return { trayHintShown: typeof trayHintShown === 'boolean' ? trayHintShown : false }
}

export function writeSettings(file: string, settings: AppSettings): void {
  const body = JSON.stringify({ trayHintShown: settings.trayHintShown === true })
  const temp = `${file}.${randomUUID()}.tmp`
  writeDurably(temp, body)
  try {
    renameSync(temp, file)
  } catch (e) {
    rmSync(temp, { force: true })
    throw e
  }
}
