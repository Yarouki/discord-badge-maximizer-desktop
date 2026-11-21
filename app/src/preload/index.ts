import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type { BridgeAPI, EventChannel, EventPayloads, Listener } from '../shared/ipc'

export type { BridgeAPI }

function makeListener<K extends EventChannel>(channel: K): Listener<K> {
  return (cb) => {
    const handler = (_e: IpcRendererEvent, data: EventPayloads[K]): void => cb(data)
    ipcRenderer.on(channel, handler)
    return () => {
      ipcRenderer.removeListener(channel, handler)
    }
  }
}

const api: BridgeAPI = {
  restoreAccounts: () => ipcRenderer.invoke('accounts:restore'),
  accountLogin: (role) => ipcRenderer.invoke('accounts:login', role),
  addAccount: () => ipcRenderer.invoke('accounts:add'),
  useAccount: (id, role) => ipcRenderer.invoke('accounts:use', id, role),
  clearAlt: () => ipcRenderer.invoke('accounts:clear-alt'),
  removeAccount: (id) => ipcRenderer.invoke('accounts:remove', id),
  logout: () => ipcRenderer.invoke('accounts:logout'),

  startClaim: (opts) => ipcRenderer.invoke('bridge:start-claim', opts),
  stopClaim: (run) => ipcRenderer.invoke('bridge:stop-claim', run),
  startStream: (opts) => ipcRenderer.invoke('bridge:start-stream', opts),
  stopStream: (run) => ipcRenderer.invoke('bridge:stop-stream', run),
  badges: () => ipcRenderer.invoke('bridge:badges'),
  voiceServers: () => ipcRenderer.invoke('bridge:voice-servers'),
  voiceChannels: (guildId) => ipcRenderer.invoke('bridge:voice-channels', guildId),
  setAutoWatch: (enabled) => ipcRenderer.invoke('bridge:set-auto-watch', enabled),
  openLogFolder: () => ipcRenderer.invoke('app:open-log-folder'),
  retryBackend: () => ipcRenderer.invoke('app:retry-backend'),

  onLog: makeListener('bridge:log'),
  onClaimProgress: makeListener('bridge:claim-progress'),
  onClaimDone: makeListener('bridge:claim-done'),
  onStreamStep: makeListener('bridge:stream-step'),
  onStreamLive: makeListener('bridge:stream-live'),
  onStreamEnded: makeListener('bridge:stream-ended'),
  onViewers: makeListener('bridge:viewers'),
  onAltStatus: makeListener('bridge:alt-status'),
  onBackendRestart: makeListener('bridge:backend-restart')
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  ;(window as unknown as { api: BridgeAPI }).api = api
}
