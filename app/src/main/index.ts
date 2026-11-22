import {
  app,
  shell,
  BrowserWindow,
  dialog,
  ipcMain,
  Notification,
  safeStorage,
  session
} from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'crypto'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { PythonBridge } from './bridge'
import {
  afterPageCrash,
  createQuitHandler,
  focusExistingWindow,
  pendingTrayOutcome,
  quitsWhenAllClosed,
  type TrayAsk
} from './app-lifecycle'
import { appWindowOpenHandler, isAllowedSender, isAppPage } from './app-page'
import { readSettings, writeSettings } from './app-settings'
import { LogFile } from './log-file'
import { removeOldLoginPartitions } from './old-partitions'
import {
  exposingEnvironment,
  exposingSwitches,
  isInstalledApp,
  refusalMessage
} from './command-line'
import { loginWithDiscord, type DiscordLoginResult } from './discord-login'
import {
  parseAccountId,
  parseClaimArgs,
  parseGuildId,
  parseLogNote,
  parseRole,
  parseStopRun,
  parseStreamArgs
} from './ipc-args'
import { AccountManager } from './account-manager'
import { AccountStore, type Cipher } from './account-store'
import { fetchIdentity } from './discord-identity'
import { redactSecrets } from './discord-auth'
import { errorMessage } from './errors'
import {
  isRunning,
  isSettled,
  traySnapshot,
  type BridgeEvent,
  type SessionAction
} from './session-state'
import { SessionCalls } from './session-calls'
import { SessionTracker, sessionClock } from './session-tracker'
import { TrayController } from './tray'
import {
  APP_NAME,
  minimizedStartNotice,
  PAGE_CRASH_QUIT,
  PAGE_CRASH_TRAY,
  TRAY_HINT
} from './tray-text'
import { VoiceNames } from './voice-names'
import { installTestHooks, testHooksWanted } from './test-hooks'
import type { AccountResult, AccountRole, EventChannel, EventPayloads } from '../shared/ipc'

const installed = isInstalledApp(app.isPackaged, __dirname)
let mainWindow: BrowserWindow | null = null
let bridge: PythonBridge | null = null
let logFile: LogFile | null = null
let accounts: AccountManager | null = null
let tray: TrayController | null = null
let quitting = false
let inTray = false
let windowGeneration = 0
let pageListening = false
let pendingTray: { ask: TrayAsk; timer: NodeJS.Timeout } | null = null
const TRAY_WAIT_MS = 20_000
let calls: SessionCalls | null = null

const voiceNames = new VoiceNames()
const testHooks = __E2E_BUILD__ && testHooksWanted(installed, process.env)
let restoreAnswer: AccountResult | null = null
const notices: string[] = []
const openNotifications = new Set<Notification>()

const DEV_URL = installed ? undefined : process.env['ELECTRON_RENDERER_URL']
const PAGE_FILE = join(__dirname, '../renderer/index.html')
const PAGE_URL = DEV_URL ?? pathToFileURL(PAGE_FILE).toString()
const PANEL_FILE = join(__dirname, '../renderer/tray.html')
const DEV_PANEL_URL = DEV_URL
  ? new URL('tray.html', `${DEV_URL.replace(/\/$/, '')}/`).href
  : undefined
const PANEL_URL = DEV_PANEL_URL ?? pathToFileURL(PANEL_FILE).toString()

const isOwnPage = (url: string | undefined): boolean => isAppPage(url, PAGE_URL, DEV_URL)
const isPanelPage = (url: string | undefined): boolean => isAppPage(url, PANEL_URL, DEV_PANEL_URL)
const hasMainWindow = (): boolean => mainWindow !== null && !mainWindow.isDestroyed()

const tracker = new SessionTracker({
  now: sessionClock,
  hasWindow: () => pageListening,
  isQuitting: () => quitting,
  notify: (body) => notify(body),
  onChange: () => {
    tray?.update()
    finishPendingTray()
  }
})

function createWindow(reopened = false): void {
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
  windowGeneration++
  pageListening = false
  inTray = false
  win.on('ready-to-show', () => {
    if (reopened && win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })
  win.on('closed', () => {
    if (mainWindow !== win) return
    mainWindow = null
    pageListening = false
    cancelPendingTray()
    tracker.apply({ type: 'page-gone', inFlight: calls?.inFlight() ?? NOTHING_IN_FLIGHT })
  })
  win.on('minimize', () => minimizeToTray(win))
  win.on('restore', () => cancelPendingTray())

  const contents = win.webContents
  contents.on('render-process-gone', (_event, details) => onPageCrash(win, details.reason))
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

const NOTHING_IN_FLIGHT = { stream: false, claim: false }
let crashTimes: number[] = []

function onPageCrash(win: BrowserWindow, reason: string): void {
  if (mainWindow !== win || quitting || reason === 'clean-exit') return
  warn(`The app's page stopped (${reason}).`)
  pageListening = false
  cancelPendingTray()
  tracker.apply({ type: 'page-gone', inFlight: calls?.inFlight() ?? NOTHING_IN_FLIGHT })
  const { times, action } = afterPageCrash(crashTimes, Date.now())
  crashTimes = times
  if (action === 'rebuild') {
    createWindow()
    win.destroy()
    return
  }
  if (tray && isRunning(tracker.snapshot)) {
    inTray = true
    win.destroy()
    notify(PAGE_CRASH_TRAY)
    return
  }
  dialog.showErrorBox(APP_NAME, PAGE_CRASH_QUIT)
  app.quit()
}

function runningNow(): { settled: boolean; stream: boolean; claim: boolean } {
  const { stream, claim } = tracker.snapshot
  return { settled: isSettled(tracker.snapshot), stream: stream !== null, claim: claim !== null }
}

function minimizeToTray(win: BrowserWindow): void {
  if (mainWindow !== win || !tray || quitting || pendingTray) return
  const now = runningNow()
  if (now.settled) {
    toTrayNow()
    return
  }
  const ask: TrayAsk = { wanted: { stream: now.stream, claim: now.claim } }
  pendingTray = { ask, timer: setTimeout(() => finishPendingTray(true), TRAY_WAIT_MS) }
  win.webContents.send('app:hide-waiting', {})
}

function cancelPendingTray(): void {
  if (!pendingTray) return
  clearTimeout(pendingTray.timer)
  pendingTray = null
}

function finishPendingTray(force = false): void {
  if (!pendingTray) return
  const now = runningNow()
  const { ask } = pendingTray
  const outcome = pendingTrayOutcome(ask, now, force)
  if (outcome === 'wait') return
  cancelPendingTray()
  if (!hasMainWindow() || quitting) return
  if (outcome === 'tray') {
    toTrayNow()
    return
  }
  const notice = minimizedStartNotice(ask.wanted, now)
  if (notice) notify(notice)
}

function toTrayNow(): void {
  const win = mainWindow
  if (!win) return
  inTray = true
  pageListening = false
  setImmediate(() => {
    if (!win.isDestroyed()) win.destroy()
  })
  showTrayHintOnce()
}

function showMainWindow(): void {
  if (quitting || !app.isReady()) return
  cancelPendingTray()
  inTray = false
  if (!focusExistingWindow(mainWindow)) createWindow(true)
}

function trayIconPath(): string {
  return installed
    ? join(process.resourcesPath, 'icon.ico')
    : join(__dirname, '../../build/icon.ico')
}

function notify(body: string): void {
  if (testHooks) {
    notices.push(body)
    return
  }
  if (!Notification.isSupported()) return
  const note = new Notification({ title: APP_NAME, body, icon: trayIconPath() })
  openNotifications.add(note)
  const forget = (): void => {
    openNotifications.delete(note)
  }
  note.on('click', () => {
    forget()
    showMainWindow()
  })
  note.on('close', forget)
  note.show()
}

function showTrayHintOnce(): void {
  const file = join(app.getPath('userData'), 'settings.json')
  const settings = readSettings(file)
  if (settings.trayHintShown) return
  notify(TRAY_HINT)
  try {
    writeSettings(file, { ...settings, trayHintShown: true })
  } catch (e) {
    warn(`The settings file could not be saved: ${errorMessage(e)}`)
  }
}

function getScriptsDir(): string {
  if (!installed) {
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
  try {
    tracker.apply({ type: 'event', event: { channel, data } as BridgeEvent, at: sessionClock() })
  } catch (e) {
    warn(`The session snapshot could not take ${channel}: ${errorMessage(e)}`)
  }
  if (channel === 'bridge:log') {
    const { type, text } = data as EventPayloads['bridge:log']
    logFile?.write(type, text)
  } else if (channel === 'bridge:backend-restart') {
    const { reason, final } = data as EventPayloads['bridge:backend-restart']
    if (final) logFile?.write('error', `Backend gave up: ${reason}`)
  } else if (channel === 'bridge:alt-status') {
    forgetDroppedAlt(data as EventPayloads['bridge:alt-status'])
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data)
  }
}

function forgetDroppedAlt(data: EventPayloads['bridge:alt-status']): void {
  if (!data.dropped || !accounts) return
  accounts.forgetAppliedAlt()
  if (pageListening) return
  void accounts.clearAlt().then((result) => tracker.apply({ type: 'accounts', result }))
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

function createTray(): void {
  try {
    tray = new TrayController({
      iconPath: trayIconPath(),
      panelPreload: join(__dirname, '../preload/tray.js'),
      panelFile: PANEL_FILE,
      panelDevUrl: DEV_PANEL_URL,
      isPanelPage,
      snapshot: () => traySnapshot(tracker.snapshot),
      now: sessionClock,
      openApp: showMainWindow,
      quit: () => app.quit(),
      log: warn
    })
  } catch (e) {
    warn(`The tray icon could not be made, so the app closes with its window: ${errorMessage(e)}`)
  }
}

function installHooksForTests(): void {
  if (!testHooks) return
  installTestHooks({
    apply: (action: SessionAction) => tracker.apply(action),
    answerRestoreWith: (result: AccountResult | null) => {
      restoreAnswer = result
    },
    trayClick: () => tray?.click(),
    trayMenu: (label: string) => tray?.menuItem(label)?.click(),
    notices: () => [...notices],
    snapshot: () => tracker.snapshot,
    state: () => ({
      inTray,
      hasWindow: hasMainWindow(),
      pageListening,
      trayPending: pendingTray !== null,
      panelOpen: tray?.panelWindow != null,
      tooltip: tray?.tooltipText ?? ''
    })
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

  const backendExe = installed ? join(process.resourcesPath, 'backend', 'badge-backend.exe') : null
  const ffmpegDir = installed ? join(process.resourcesPath, 'ffmpeg') : null
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
  const manager = new AccountManager(
    store,
    b,
    openLogin,
    fetchIdentity,
    warn,
    () => tracker.snapshot.stream !== null
  )
  accounts = manager

  const handleAccounts = (
    channel: string,
    fn: (...args: unknown[]) => Promise<AccountResult>
  ): void =>
    handle(channel, async (...args) => {
      let result: AccountResult
      try {
        result = await fn(...args)
      } catch (e) {
        result = manager.refuse(errorMessage(e))
      }
      tracker.apply({ type: 'accounts', result })
      return result
    })
  handleAccounts('accounts:restore', () =>
    restoreAnswer ? Promise.resolve(restoreAnswer) : manager.restore()
  )
  handleAccounts('accounts:login', (role) => manager.login(parseRole(role)))
  handleAccounts('accounts:add', () => manager.add())
  handleAccounts('accounts:use', (id, role) => manager.use(parseAccountId(id), parseRole(role)))
  handleAccounts('accounts:clear-alt', () => manager.clearAlt())
  handleAccounts('accounts:remove', (id) => manager.remove(parseAccountId(id)))
  handleAccounts('accounts:logout', () => manager.logout())

  const runs = new SessionCalls({
    tracker,
    names: voiceNames,
    bridge: b,
    page: () => ({ generation: windowGeneration, listening: pageListening }),
    send,
    now: sessionClock
  })
  calls = runs
  handle('bridge:start-claim', (args) => runs.startClaim(parseClaimArgs(args)))
  handle('bridge:stop-claim', (run) => runs.stopClaim(parseStopRun(run)))
  handle('bridge:start-stream', (args) => runs.startStream(parseStreamArgs(args)))
  handle('bridge:stop-stream', (run, restart) =>
    runs.stopStream(parseStopRun(run), restart === true)
  )
  handle('bridge:badges', () => b.badges())
  handle('bridge:voice-servers', async () => {
    const res = await b.voiceServers()
    voiceNames.rememberServers(res)
    return res
  })
  handle('bridge:voice-channels', async (guildId) => {
    const res = await b.voiceChannels(parseGuildId(guildId))
    voiceNames.rememberChannels(res)
    return res
  })
  handle('bridge:set-auto-watch', async (enabled) => {
    const res = await b.setAutoWatch(enabled === true)
    if (res.ok) tracker.apply({ type: 'auto-watch', enabled: res.enabled !== false })
    return res
  })
  handle('app:open-log-folder', () => logs.openFolder((path) => shell.openPath(path)))
  handle('app:retry-backend', () => {
    b.retry()
    return { ok: true }
  })
  handle('session:snapshot', () => {
    pageListening = true
    return { ...tracker.snapshot, now: sessionClock() }
  })
  handle('session:log', (text, tone) => {
    tracker.apply({ type: 'note', ...parseLogNote(text, tone, redactSecrets), at: sessionClock() })
    return { ok: true }
  })
  handle('session:claim-dismiss', () => {
    tracker.apply({ type: 'claim-dismiss' })
    return { ok: true }
  })

  createWindow()
  createTray()
  if (__E2E_BUILD__) installHooksForTests()

  app.on('activate', () => {
    if (!hasMainWindow()) showMainWindow()
  })
}

app.commandLine.appendSwitch('force-prefers-no-reduced-motion')

const refusedSwitches = installed ? exposingSwitches((name) => app.commandLine.hasSwitch(name)) : []
const refusedVariables = installed ? exposingEnvironment(process.env) : []

if (refusedSwitches.length > 0 || refusedVariables.length > 0) {
  console.error(refusalMessage(refusedSwitches, refusedVariables))
  app.exit(1)
} else if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (quitting) return
    showMainWindow()
  })
  app
    .whenReady()
    .then(startApp)
    .catch((e: unknown) => {
      warn(`The app could not start: ${errorMessage(e)}`)
      app.quit()
    })

  app.on('window-all-closed', () => {
    if (quitsWhenAllClosed(inTray)) app.quit()
  })

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
        tray?.destroy()
        tray = null
      }
    })
  )
}
