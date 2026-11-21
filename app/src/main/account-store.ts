import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync
} from 'fs'
import { basename, dirname, join } from 'path'
import {
  assertValidState,
  emptyAccounts,
  parseStoredState,
  type AccountsState
} from './accounts-model'
import { errorMessage } from './errors'

export interface Cipher {
  available(): boolean
  encrypt(text: string): string
  decrypt(data: string): string
}

export type SaveStatus = { saved: true } | { saved: false; reason: string }

export interface AccountStoreOptions {
  copyFile?: (from: string, to: string) => void
  readFile?: (path: string) => string
  sleep?: (ms: number) => void
  now?: () => Date
  removeFile?: (path: string) => void
}

const FILE_VERSION = 1
const NO_ENCRYPTION = "Windows encryption isn't available"
const ENCRYPTION_FAILED = "Windows couldn't encrypt the saved accounts"
const MAX_COPY_NAMES = 20
const READ_RETRY_MS = 250
const LEFT_AS_IS =
  "the saved accounts file couldn't be read at start, so the app leaves it as it is"
const LOCKED_PROBLEM =
  "Your saved accounts couldn't be read (the file is locked by another program or access was denied). They are still on disk and the app won't change them. Restart the app, and if that doesn't help, check your antivirus or sync tool. Until then, logins last only until you close the app."

function blockingSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

class LoadError extends Error {}
class NoEncryptionError extends LoadError {}

const errorCode = (e: unknown): string | undefined =>
  typeof e === 'object' && e !== null && typeof (e as { code?: unknown }).code === 'string'
    ? (e as { code: string }).code
    : undefined

function describeWriteError(e: unknown): string {
  switch (errorCode(e)) {
    case 'ENOSPC':
      return 'the disk is full'
    case 'EPERM':
    case 'EACCES':
    case 'EBUSY':
    case 'EISDIR':
      return 'the file is locked or the folder is read-only'
    case 'ENOENT':
      return 'the data folder is missing'
    default:
      return `the write failed: ${errorCode(e) ?? errorMessage(e)}`
  }
}

function writeDurably(path: string, body: string): void {
  const fd = openSync(path, 'w')
  try {
    writeSync(fd, body, null, 'utf8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

const twoDigits = (n: number): string => String(n).padStart(2, '0')

function timestamp(d: Date): string {
  const day = `${d.getFullYear()}${twoDigits(d.getMonth() + 1)}${twoDigits(d.getDate())}`
  return `${day}-${twoDigits(d.getHours())}${twoDigits(d.getMinutes())}${twoDigits(d.getSeconds())}`
}

export class AccountStore {
  private state: AccountsState
  private warnedNoEncryption = false
  private keepFileAsIs: string | null = null
  readonly loadProblem: string | null = null

  constructor(
    private readonly file: string,
    private readonly cipher: Cipher,
    private readonly warn: (message: string) => void = (m) => console.warn(m),
    private readonly options: AccountStoreOptions = {}
  ) {
    const loaded = this.load()
    this.state = loaded.state
    this.loadProblem = loaded.problem
  }

  get(): AccountsState {
    return this.state
  }

  update(change: (state: AccountsState) => AccountsState): SaveStatus {
    const next = change(this.state)
    assertValidState(next)
    this.state = next
    if (this.keepFileAsIs) return { saved: false, reason: this.keepFileAsIs }
    if (!this.cipher.available()) {
      if (!this.warnedNoEncryption) this.warn(`${NO_ENCRYPTION}; accounts are kept in memory only`)
      this.warnedNoEncryption = true
      return { saved: false, reason: NO_ENCRYPTION }
    }
    return this.save(next)
  }

  private load(): { state: AccountsState; problem: string | null } {
    const empty = { state: emptyAccounts(), problem: null }
    if (!existsSync(this.file)) return empty
    let raw: string
    try {
      raw = this.readText()
    } catch (e) {
      if (errorCode(e) === 'ENOENT') return empty
      this.warn(`Saved accounts could not be read: ${errorMessage(e)}`)
      this.keepFileAsIs = LEFT_AS_IS
      return { state: emptyAccounts(), problem: LOCKED_PROBLEM }
    }
    try {
      return { state: this.parse(raw), problem: null }
    } catch (e) {
      const reason = e instanceof LoadError ? e.message : 'the file is damaged'
      this.warn(`Saved accounts could not be read: ${errorMessage(e)}`)
      if (e instanceof NoEncryptionError) {
        this.keepFileAsIs = NO_ENCRYPTION
        return {
          state: emptyAccounts(),
          problem: `Your saved accounts couldn't be read (${reason}), so you need to log in again. The file is left as it is.`
        }
      }
      const copy = this.keepCopy()
      if (!copy) this.keepFileAsIs = LEFT_AS_IS
      const kept = copy
        ? `A copy of the old file was kept as ${basename(copy)}.`
        : "A copy of the old file couldn't be kept, so the app won't save over it: new logins last only until you close the app."
      return {
        state: emptyAccounts(),
        problem: `Your saved accounts couldn't be read (${reason}), so you need to log in again. ${kept}`
      }
    }
  }

  private readText(): string {
    const readFile = this.options.readFile ?? ((path) => readFileSync(path, 'utf8'))
    try {
      return readFile(this.file)
    } catch (e) {
      if (errorCode(e) === 'ENOENT') throw e
      this.warn(`Reading the accounts file failed, trying once more: ${errorMessage(e)}`)
      ;(this.options.sleep ?? blockingSleep)(READ_RETRY_MS)
      return readFile(this.file)
    }
  }

  private parse(raw: string): AccountsState {
    let stored: unknown
    try {
      stored = JSON.parse(raw)
    } catch {
      throw new LoadError('the file is damaged')
    }
    const { version, data } = (stored ?? {}) as { version?: unknown; data?: unknown }
    if (version !== FILE_VERSION || typeof data !== 'string') {
      throw new LoadError('the file is damaged or from a newer version of the app')
    }
    if (!this.cipher.available()) throw new NoEncryptionError(NO_ENCRYPTION)
    let text: string
    try {
      text = this.cipher.decrypt(data)
    } catch (e) {
      this.warn(`Decrypting the accounts file: ${errorMessage(e)}`)
      throw new LoadError('it was saved on a different Windows account or PC')
    }
    try {
      return parseStoredState(JSON.parse(text))
    } catch {
      throw new LoadError('the file is damaged')
    }
  }

  deleteBadCopies(): void {
    const folder = dirname(this.file)
    const prefix = `${basename(this.file)}.`
    let names: string[]
    try {
      names = readdirSync(folder)
    } catch (e) {
      if (errorCode(e) !== 'ENOENT') this.warn(`Could not list ${folder}: ${errorMessage(e)}`)
      return
    }
    const remove = this.options.removeFile ?? ((path) => rmSync(path, { force: true }))
    for (const name of names) {
      if (!name.startsWith(prefix) || !name.endsWith('.bad')) continue
      if (!this.readableHere(join(folder, name))) continue
      try {
        remove(join(folder, name))
      } catch (e) {
        this.warn(`Could not delete ${name}: ${errorMessage(e)}`)
      }
    }
  }

  private readableHere(path: string): boolean {
    if (!this.cipher.available()) return false
    try {
      const { data } = (JSON.parse(readFileSync(path, 'utf8')) ?? {}) as { data?: unknown }
      if (typeof data !== 'string') return false
      this.cipher.decrypt(data)
      return true
    } catch {
      return false
    }
  }

  private keepCopy(): string | null {
    const copyFile =
      this.options.copyFile ?? ((from, to) => copyFileSync(from, to, constants.COPYFILE_EXCL))
    const stamp = timestamp((this.options.now ?? (() => new Date()))())
    for (let n = 0; n < MAX_COPY_NAMES; n++) {
      const target = `${this.file}.${stamp}${n ? `-${n}` : ''}.bad`
      try {
        copyFile(this.file, target)
        return target
      } catch (e) {
        if (errorCode(e) === 'EEXIST') continue
        this.warn(`Could not keep a copy of the unreadable accounts file: ${errorMessage(e)}`)
        return null
      }
    }
    this.warn('Could not keep a copy of the unreadable accounts file: every name was taken')
    return null
  }

  private save(state: AccountsState): SaveStatus {
    let data: string
    try {
      data = this.cipher.encrypt(JSON.stringify(state))
    } catch (e) {
      this.warn(`Saved accounts could not be encrypted: ${errorMessage(e)}`)
      return { saved: false, reason: ENCRYPTION_FAILED }
    }
    const body = JSON.stringify({ version: FILE_VERSION, data })
    const temp = `${this.file}.tmp`
    try {
      writeDurably(temp, body)
      renameSync(temp, this.file)
      return { saved: true }
    } catch (e) {
      this.warn(`Saved accounts could not be written: ${errorMessage(e)}`)
      try {
        rmSync(temp, { force: true })
      } catch (cleanupError) {
        this.warn(`Could not remove ${basename(temp)}: ${errorMessage(cleanupError)}`)
      }
      return { saved: false, reason: describeWriteError(e) }
    }
  }
}
