import { BrowserWindow, Menu, Tray, ipcMain, screen } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { panelClickAction } from './app-lifecycle'
import { appWindowOpenHandler, isAllowedSender } from './app-page'
import { parsePanelHeight } from './ipc-args'
import { panelPosition } from './tray-position'
import { trayTooltip } from './tray-text'
import { redactSecrets } from './discord-auth'
import { errorMessage } from './errors'
import type { Clocked, TraySnapshot } from '../shared/ipc'

export const PANEL_WIDTH = 340
const PANEL_START_HEIGHT = 220
const PANEL_SHOW_FALLBACK_MS = 1500
const TOOLTIP_EVERY_MS = 1000

export interface TrayOptions {
  iconPath: string
  panelPreload: string
  panelFile: string
  panelDevUrl: string | undefined
  isPanelPage: (url: string | undefined) => boolean
  snapshot: () => TraySnapshot
  now: () => number
  openApp: () => void
  quit: () => void
  log: (message: string) => void
}

const PANEL_CHANNELS = ['tray:snapshot', 'tray:fit', 'tray:open-app', 'tray:quit'] as const

export class TrayController {
  private readonly tray: Tray
  private readonly menu: Menu
  private panel: BrowserWindow | null = null
  private panelShown = false
  private panelClosedAt = 0
  private tooltip = ''
  private lastSent: TraySnapshot | null = null
  private readonly timer: NodeJS.Timeout

  constructor(private readonly options: TrayOptions) {
    this.tray = new Tray(options.iconPath)
    this.menu = Menu.buildFromTemplate([
      { label: 'Open', click: () => options.openApp() },
      { type: 'separator' },
      { label: 'Quit', click: () => options.quit() }
    ])
    this.tray.setContextMenu(this.menu)
    this.tray.on('click', () => this.click())
    this.refreshTooltip()
    this.timer = setInterval(() => this.refreshTooltip(), TOOLTIP_EVERY_MS)
    this.handlePanel()
  }

  update(): void {
    const snapshot = this.options.snapshot()
    const last = this.lastSent
    if (
      last &&
      (Object.keys(snapshot) as (keyof TraySnapshot)[]).every((k) => snapshot[k] === last[k])
    ) {
      return
    }
    this.lastSent = snapshot
    this.refreshTooltip()
    const panel = this.panel
    if (panel && !panel.isDestroyed()) panel.webContents.send('tray:update', this.clocked(snapshot))
  }

  private clocked(snapshot: TraySnapshot): Clocked<TraySnapshot> {
    return { ...snapshot, now: this.options.now() }
  }

  click(): void {
    const action = panelClickAction({
      open: this.panel !== null,
      closedAt: this.panelClosedAt,
      now: Date.now()
    })
    if (action === 'open') this.openPanel()
    else if (action === 'close') this.closePanel()
  }

  menuItem(label: string): { click: () => void } | null {
    const item = this.menu.items.find((i) => i.label === label)
    return item ? { click: () => item.click() } : null
  }

  get panelWindow(): BrowserWindow | null {
    return this.panel
  }

  get tooltipText(): string {
    return this.tooltip
  }

  destroy(): void {
    clearInterval(this.timer)
    this.closePanel()
    for (const channel of PANEL_CHANNELS) ipcMain.removeHandler(channel)
    if (!this.tray.isDestroyed()) this.tray.destroy()
  }

  private refreshTooltip(): void {
    const text = trayTooltip(this.options.snapshot(), this.options.now())
    if (text === this.tooltip || this.tray.isDestroyed()) return
    this.tooltip = text
    this.tray.setToolTip(text)
  }

  private handlePanel(): void {
    const handle = (channel: string, fn: (...args: unknown[]) => unknown): void => {
      ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
        if (!isAllowedSender(event, this.panel, this.options.isPanelPage)) {
          return { ok: false, error: 'Not allowed' }
        }
        try {
          return fn(...args)
        } catch (e) {
          return { ok: false, error: redactSecrets(errorMessage(e)) }
        }
      })
    }
    handle('tray:snapshot', () => this.clocked(this.options.snapshot()))
    handle('tray:fit', (height) => {
      this.place(parsePanelHeight(height))
      return { ok: true }
    })
    handle('tray:open-app', () => {
      setImmediate(() => {
        this.closePanel()
        this.options.openApp()
      })
      return { ok: true }
    })
    handle('tray:quit', () => {
      setImmediate(() => {
        this.closePanel()
        this.options.quit()
      })
      return { ok: true }
    })
  }

  private openPanel(): void {
    const win = new BrowserWindow({
      width: PANEL_WIDTH,
      height: PANEL_START_HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      title: 'Badge Maximizer',
      webPreferences: {
        preload: this.options.panelPreload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false
      }
    })
    this.panel = win
    this.panelShown = false
    win.on('blur', () => setImmediate(() => this.panel === win && this.closePanel()))
    win.on('closed', () => {
      if (this.panel !== win) return
      this.panel = null
      this.panelClosedAt = Date.now()
    })
    const contents = win.webContents
    contents.setWindowOpenHandler(appWindowOpenHandler)
    const stayOnPanelPage = (event: { url: string; preventDefault: () => void }): void => {
      if (!this.options.isPanelPage(event.url)) event.preventDefault()
    }
    contents.on('will-navigate', stayOnPanelPage)
    contents.on('will-redirect', stayOnPanelPage)
    contents.on('will-frame-navigate', stayOnPanelPage)
    const load = this.options.panelDevUrl
      ? win.loadURL(this.options.panelDevUrl)
      : win.loadFile(this.options.panelFile)
    load.catch((e: unknown) => this.options.log(`The tray panel did not load: ${String(e)}`))
    setTimeout(() => {
      if (this.panel === win && !this.panelShown) this.place(PANEL_START_HEIGHT)
    }, PANEL_SHOW_FALLBACK_MS)
  }

  private place(height: number): void {
    const win = this.panel
    if (!win || win.isDestroyed()) return
    const trayBounds = this.tray.getBounds()
    const display = screen.getDisplayMatching(trayBounds)
    const size = { width: PANEL_WIDTH, height }
    const { x, y } = panelPosition({
      tray: trayBounds,
      size,
      display: display.bounds,
      workArea: display.workArea
    })
    win.setBounds({ x, y, ...size })
    if (this.panelShown) return
    this.panelShown = true
    win.show()
    win.focus()
  }

  private closePanel(): void {
    const win = this.panel
    if (!win) return
    this.panel = null
    this.panelClosedAt = Date.now()
    if (!win.isDestroyed()) win.destroy()
  }
}
