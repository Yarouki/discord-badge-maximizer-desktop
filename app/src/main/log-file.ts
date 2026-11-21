import { appendFile, mkdir, rename, stat } from 'fs/promises'
import { join } from 'path'
import { redactSecrets } from './discord-auth'
import { errorMessage } from './errors'
import type { OkResult } from '../shared/ipc'

const MAX_BYTES = 1024 * 1024
const BATCH_MS = 250
const MAX_QUEUED_BYTES = 4 * 1024 * 1024

export interface LogFileOptions {
  maxBytes?: number
  now?: () => Date
}

export class LogFile {
  readonly file: string
  readonly oldFile: string
  private readonly maxBytes: number
  private readonly now: () => Date
  private queue: string[] = []
  private queuedBytes = 0
  private timer: NodeJS.Timeout | null = null
  private writing: Promise<void> = Promise.resolve()
  private size: number | null = null
  private reported = false

  constructor(
    readonly folder: string,
    options: LogFileOptions = {}
  ) {
    this.file = join(folder, 'badge-maximizer.log')
    this.oldFile = join(folder, 'badge-maximizer.old.log')
    this.maxBytes = options.maxBytes ?? MAX_BYTES
    this.now = options.now ?? (() => new Date())
  }

  write(type: string, text: string): void {
    try {
      const clean = redactSecrets(String(text)).replace(/[\r\n]+/g, ' ')
      const line = `${this.now().toISOString()} [${type}] ${clean}\n`
      this.queue.push(line)
      this.queuedBytes += Buffer.byteLength(line)
      while (this.queuedBytes > MAX_QUEUED_BYTES && this.queue.length > 1) {
        this.queuedBytes -= Buffer.byteLength(this.queue.shift()!)
      }
      this.timer ??= setTimeout(() => {
        this.timer = null
        void this.drain()
      }, BATCH_MS)
    } catch (e) {
      this.report(e)
    }
  }

  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    return this.drain()
  }

  async openFolder(openPath: (path: string) => Promise<string>): Promise<OkResult> {
    try {
      await mkdir(this.folder, { recursive: true })
      const problem = await openPath(this.folder)
      return problem
        ? { ok: false, error: `Couldn't open the log folder (${problem}).` }
        : { ok: true }
    } catch (e) {
      return { ok: false, error: `Couldn't open the log folder (${errorMessage(e)}).` }
    }
  }

  private drain(): Promise<void> {
    this.writing = this.writing.then(() => this.writeQueued()).catch((e: unknown) => this.report(e))
    return this.writing
  }

  private async writeQueued(): Promise<void> {
    if (!this.queue.length) return
    const lines = this.queue
    this.queue = []
    this.queuedBytes = 0
    await mkdir(this.folder, { recursive: true })
    this.size ??= await stat(this.file).then(
      (s) => s.size,
      () => 0
    )
    let batch = ''
    let batchBytes = 0
    let canRotate = true
    for (const line of lines) {
      const bytes = Buffer.byteLength(line)
      const before = this.size + batchBytes
      if (canRotate && before > 0 && before + bytes > this.maxBytes) {
        if (batch) await appendFile(this.file, batch, 'utf8')
        this.size += batchBytes
        batch = ''
        batchBytes = 0
        canRotate = await this.rotate()
      }
      batch += line
      batchBytes += bytes
    }
    await appendFile(this.file, batch, 'utf8')
    this.size += batchBytes
  }

  private async rotate(): Promise<boolean> {
    try {
      await rename(this.file, this.oldFile)
      this.size = 0
      return true
    } catch (e) {
      this.report(e)
      return false
    }
  }

  private report(e: unknown): void {
    if (this.reported) return
    this.reported = true
    console.error(`Badge Maximizer could not write its log file (${errorMessage(e)}).`)
  }
}
