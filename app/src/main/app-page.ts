export function isAppPage(
  url: string | undefined,
  pageUrl: string,
  devUrl: string | undefined
): boolean {
  if (!url) return false
  const base = url.split('#')[0]
  if (!devUrl) return base === pageUrl
  try {
    return new URL(base).href === new URL(devUrl).href
  } catch {
    return false
  }
}

export interface SenderFrame {
  readonly url: string
}

export interface SenderWindow {
  isDestroyed(): boolean
  readonly webContents: { readonly mainFrame: SenderFrame }
}

export function isAllowedSender(
  event: { readonly senderFrame: SenderFrame | null },
  window: SenderWindow | null,
  isOwnPage: (url: string | undefined) => boolean
): boolean {
  const frame = event.senderFrame
  if (!frame || !window || window.isDestroyed()) return false
  return frame === window.webContents.mainFrame && isOwnPage(frame.url)
}

export function appWindowOpenHandler(): { action: 'deny' } {
  return { action: 'deny' }
}
