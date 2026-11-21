import { BrowserWindow, session, shell } from 'electron'
import { join } from 'path'
import {
  buildCookieHeader,
  isDiscordUrl,
  isFromDiscordPage,
  isPlausibleUserToken,
  readAuthorizationHeader
} from './discord-auth'
import { errorMessage } from './errors'

export type DiscordLoginResult =
  { ok: true; token: string; cookie: string } | { ok: false; error: string }

export interface DiscordLoginOptions {
  parent: BrowserWindow | null
  partition: string
  title: string
}

const DISCORD_LOGIN_URL = 'https://discord.com/login'
const DISCORD_ORIGIN = 'https://discord.com'
const DISCORD_API_FILTER = { urls: ['https://discord.com/api/*'] }
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000
const ERR_ABORTED = -3

interface PendingLogin {
  win: BrowserWindow
  promise: Promise<DiscordLoginResult>
}

const pending = new Map<string, PendingLogin>()

export function loginWithDiscord(options: DiscordLoginOptions): Promise<DiscordLoginResult> {
  const existing = pending.get(options.partition)
  if (existing) {
    if (!existing.win.isDestroyed()) existing.win.focus()
    return existing.promise
  }

  const win = createLoginWindow(options)
  const promise = runLogin(win, options.partition)
  pending.set(options.partition, { win, promise })
  return promise
}

function createLoginWindow(options: DiscordLoginOptions): BrowserWindow {
  const parent = options.parent && !options.parent.isDestroyed() ? options.parent : undefined
  return new BrowserWindow({
    width: 480,
    height: 720,
    parent,
    modal: true,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#313338',
    title: options.title,
    webPreferences: {
      session: session.fromPartition(options.partition),
      preload: join(__dirname, '../preload/discord-login.js'),
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true
    }
  })
}

function restrictNavigation(win: BrowserWindow): void {
  const contents = win.webContents
  const openOutside = (url: string): void => {
    if (!url.startsWith('https://')) return
    shell
      .openExternal(url)
      .catch((e: unknown) => console.warn(`Could not open the link: ${errorMessage(e)}`))
  }

  contents.setWindowOpenHandler(({ url }) => {
    openOutside(url)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event) => {
    if (isDiscordUrl(event.url)) return
    event.preventDefault()
    openOutside(event.url)
  })
  contents.on('will-redirect', (event) => {
    if (event.isMainFrame && !isDiscordUrl(event.url)) event.preventDefault()
  })
}

function runLogin(win: BrowserWindow, partition: string): Promise<DiscordLoginResult> {
  const loginSession = win.webContents.session
  loginSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  const popupId = win.webContents.id

  return new Promise((resolve) => {
    let settled = false
    let capturing = false

    const timeout = setTimeout(() => {
      finish({ ok: false, error: 'Login timed out after 10 minutes. Try again.' })
    }, LOGIN_TIMEOUT_MS)

    const finish = (result: DiscordLoginResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      loginSession.webRequest.onBeforeSendHeaders(null)
      pending.delete(partition)
      loginSession
        .clearStorageData()
        .catch((e) => console.warn('Could not clear the login session:', e))
      if (!win.isDestroyed()) win.destroy()
      resolve(result)
    }

    const capture = async (token: string): Promise<void> => {
      if (capturing || settled) return
      capturing = true
      try {
        const cookies = await loginSession.cookies.get({ url: DISCORD_ORIGIN })
        finish({ ok: true, token, cookie: buildCookieHeader(cookies) })
      } catch (error: unknown) {
        const reason = errorMessage(error)
        finish({ ok: false, error: `Logged in, but reading Discord's cookies failed: ${reason}` })
      }
    }

    loginSession.webRequest.onBeforeSendHeaders(DISCORD_API_FILTER, (details, callback) => {
      callback({ requestHeaders: details.requestHeaders })
      if (!isFromDiscordPage(details, popupId)) return
      const token = readAuthorizationHeader(details.requestHeaders)
      if (token && isPlausibleUserToken(token)) void capture(token)
    })

    restrictNavigation(win)
    win.on('page-title-updated', (event) => event.preventDefault())
    win.once('ready-to-show', () => win.show())
    win.on('closed', () => {
      if (capturing) return
      finish({ ok: false, error: 'The login window was closed before you finished logging in.' })
    })

    win.loadURL(DISCORD_LOGIN_URL).catch((error: unknown) => {
      if (settled || capturing) return
      const errno = (error as { errno?: number }).errno
      if (errno === ERR_ABORTED) return
      finish({ ok: false, error: `Couldn't open Discord's login page: ${errorMessage(error)}` })
    })
  })
}
