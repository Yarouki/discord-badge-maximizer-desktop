import { existsSync, rmSync } from 'fs'
import { join } from 'path'
import { errorMessage } from './errors'

export const OLD_LOGIN_PARTITIONS: readonly string[] = ['discord-login', 'discord-alt']

export function removeOldLoginPartitions(
  userData: string,
  log: (message: string) => void,
  remove: (path: string) => void = (path) => rmSync(path, { recursive: true, force: true })
): void {
  for (const name of OLD_LOGIN_PARTITIONS) {
    const folder = join(userData, 'Partitions', name)
    try {
      if (existsSync(folder)) remove(folder)
    } catch (e) {
      log(`Could not delete the old login data in ${folder}: ${errorMessage(e)}`)
    }
  }
}
