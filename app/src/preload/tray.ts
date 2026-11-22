import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type { Clocked, TrayAPI, TraySnapshot } from '../shared/ipc'

const trayApi: TrayAPI = {
  snapshot: () => ipcRenderer.invoke('tray:snapshot'),
  onSnapshot: (cb) => {
    const handler = (_e: IpcRendererEvent, data: Clocked<TraySnapshot>): void => cb(data)
    ipcRenderer.on('tray:update', handler)
    return () => {
      ipcRenderer.removeListener('tray:update', handler)
    }
  },
  fit: (height) => ipcRenderer.invoke('tray:fit', height),
  openApp: () => ipcRenderer.invoke('tray:open-app'),
  quit: () => ipcRenderer.invoke('tray:quit')
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('trayApi', trayApi)
  } catch (error) {
    console.error(error)
  }
}
