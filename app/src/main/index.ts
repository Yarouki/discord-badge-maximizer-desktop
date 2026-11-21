import { app, shell, BrowserWindow, ipcMain, safeStorage, session } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'crypto'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { PythonBridge } from './bridge'
import { createQuitHandler, focusExistingWindow } from './app-lifecycle'
import { appWindowOpenHandler, isAllowedSender, isAppPage } from './app-page'
import { LogFile } from './log-file'
import { removeOldLoginPartitions } from './old-partitions'
import { exposingEnvironment, exposingSwitches, refusalMessage } from './command-line'
import { loginWithDiscord, type DiscordLoginResult } from './discord-login'
import {
  parseAccountId,
  parseClaimArgs,
  parseGuildId,
  parseRole,
  parseStopRun,
  parseStreamArgs
} from './ipc-args'
import { AccountManager } from './account-manager'
import { AccountStore, type Cipher } from './account-store'
import { fetchIdentity } from './discord-identity'
import { redactSecrets } from './discord-auth'
import { errorMessage } from './errors'
import type { AccountResult, AccountRole, EventChannel, EventPayloads } from '../shared/ipc'

let mainWindow: BrowserWindow | null = null
let bridge: PythonBridge | null = null
let logFile: LogFile | null = null
let quitting = false

const DEV_URL = is.dev ? process.env['ELECTRON_RENDERER_URL'] : undefined
const PAGE_FILE = join(__dirname, '../renderer/index.html')
const PAGE_URL = DEV_URL ?? pathToFileURL(PAGE_FILE).toString()

const isOwnPage = (url: string | undefined): boolean => isAppPage(url, PAGE_URL, DEV_URL)

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#15162B',
    titleBarStyle: 'hidden',
    titleBarOverlay:
      process.platform === 'win32'
        ? { color: '#121327', symbolColor: '#B5BAC1', height: 52 }
        : undefined,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow = win
  win.on('ready-to-show', () => win.show())
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  const contents = win.webContents
  contents.setWindowOpenHandler(appWindowOpenHandler)
  const stayOnAppPage = (event: { url: string; preventDefault: () => void }): void => {
    if (!isOwnPage(event.url)) event.preventDefault()
  }
  contents.on('will-navigate', stayOnAppPage)
  contents.on('will-redirect', stayOnAppPage)
  contents.on('will-frame-navigate', stayOnAppPage)

  if (DEV_URL) {
    win.loadURL(DEV_URL)
  } else {
    win.loadFile(PAGE_FILE)
  }
}

function getScriptsDir(): string {
  if (is.dev) {
    return join(__dirname, '../../..', 'scripts')
  }
  return join(process.resourcesPath, 'scripts')
}

function warn(message: string): void {
  const text = redactSecrets(message)
  console.warn(text)
  logFile?.write('warning', text)
}

function send<K extends EventChannel>(channel: K, data: EventPayloads[K]): void {
  if (channel === 'bridge:log') {
    const { type, text } = data as EventPayloads['bridge:log']
    logFile?.write(type, text)
  } else if (channel === 'bridge:backend-restart') {
    const { reason, final } = data as EventPayloads['bridge:backend-restart']
    if (final) logFile?.write('error', `Backend gave up: ${reason}`)
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data)
  }
}

function handle(channel: string, fn: (...args: unknown[]) => unknown): void {
  ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
    if (!isAllowedSender(event, mainWindow, isOwnPage)) return { ok: false, error: 'Not allowed' }
    try {
      return await fn(...args)
    } catch (e) {
      return { ok: false, error: redactSecrets(errorMessage(e)) }
    }
  })
}

function startApp(): void {
  const logs = new LogFile(join(app.getPath('userData'), 'logs'))
  logFile = logs
  removeOldLoginPartitions(app.getPath('userData'), warn)
  electronApp.setAppUserModelId('com.yarouki.badge-maximizer')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) =>
    callback(false)
  )

  const backendExe = app.isPackaged
    ? join(process.resourcesPath, 'backend', 'badge-backend.exe')
    : null
  const ffmpegDir = app.isPackaged ? join(process.resourcesPath, 'ffmpeg') : null
  const b = new PythonBridge({
    scriptsDir: getScriptsDir(),
    dataDir: app.getPath('userData'),
    send,
    backendExe,
    ffmpegDir,
    log: warn
  })
  bridge = b

  const windowsCipher: Cipher = {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (text) => safeStorage.encryptString(text).toString('base64'),
    decrypt: (data) => safeStorage.decryptString(Buffer.from(data, 'base64'))
  }
  const store = new AccountStore(
    join(app.getPath('userData'), 'accounts.json'),
    windowsCipher,
    warn
  )
  const openLogin = (role: AccountRole): Promise<DiscordLoginResult> =>
    loginWithDiscord({
      parent: mainWindow,
      partition: `discord-login-${randomUUID()}`,
      title: role === 'alt' ? 'Log in with your alt account' : 'Log in to Discord'
    })
  const accounts = new AccountManager(store, b, openLogin, fetchIdentity, warn)

  const handleAccounts = (
    channel: string,
    fn: (...args: unknown[]) => Promise<AccountResult>
  ): void =>
    handle(channel, (...args) => {
      try {
        return fn(...args)
      } catch (e) {
        return accounts.refuse(errorMessage(e))
      }
    })
  handleAccounts('accounts:restore', () => accounts.restore())
  handleAccounts('accounts:login', (role) => accounts.login(parseRole(role)))
  handleAccounts('accounts:add', () => accounts.add())
  handleAccounts('accounts:use', (id, role) => accounts.use(parseAccountId(id), parseRole(role)))
  handleAccounts('accounts:clear-alt', () => accounts.clearAlt())
  handleAccounts('accounts:remove', (id) => accounts.remove(parseAccountId(id)))
  handleAccounts('accounts:logout', () => accounts.logout())

  handle('bridge:start-claim', (args) => b.startClaim(parseClaimArgs(args)))
  handle('bridge:stop-claim', (run) => b.stopClaim(parseStopRun(run)))
  handle('bridge:start-stream', (args) => b.startStream(parseStreamArgs(args)))
  handle('bridge:stop-stream', (run) => b.stopStream(parseStopRun(run)))
  handle('bridge:badges', () => b.badges())
  handle('bridge:voice-servers', () => b.voiceServers())
  handle('bridge:voice-channels', (guildId) => b.voiceChannels(parseGuildId(guildId)))
  handle('bridge:set-auto-watch', (enabled) => b.setAutoWatch(enabled === true))
  handle('app:open-log-folder', () => logs.openFolder((path) => shell.openPath(path)))
  handle('app:retry-backend', () => {
    b.retry()
    return { ok: true }
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}

app.commandLine.appendSwitch('force-prefers-no-reduced-motion')

const refusedSwitches = app.isPackaged
  ? exposingSwitches((name) => app.commandLine.hasSwitch(name))
  : []
const refusedVariables = app.isPackaged ? exposingEnvironment(process.env) : []

if (refusedSwitches.length > 0 || refusedVariables.length > 0) {
  console.error(refusalMessage(refusedSwitches, refusedVariables))
  app.exit(1)
} else if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (quitting) return
    if (!focusExistingWindow(mainWindow) && app.isReady()) createWindow()
  })
  app
    .whenReady()
    .then(startApp)
    .catch((e: unknown) => {
      warn(`The app could not start: ${errorMessage(e)}`)
      app.quit()
    })

  app.on('window-all-closed', () => app.quit())

  app.on(
    'before-quit',
    createQuitHandler({
      shutdown: async () => {
        await bridge?.shutdown()
      },
      quit: () => app.quit(),
      exit: () => app.exit(0),
      destroyWindows: () => BrowserWindow.getAllWindows().forEach((w) => w.destroy()),
      flushLog: async () => {
        await logFile?.flush()
      },
      log: warn,
      onStop: () => {
        quitting = true
        BrowserWindow.getAllWindows().forEach((w) => w.hide())
      }
    })
  )
}
