export interface CookieLike {
  name: string
  value: string
}

const MAX_TOKEN_LENGTH = 512

export function readAuthorizationHeader(headers: Record<string, string>): string | null {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === 'authorization' && typeof value === 'string') {
      return value.trim()
    }
  }
  return null
}

export function isPlausibleUserToken(value: string): boolean {
  if (value.length > MAX_TOKEN_LENGTH) return false
  return /^[A-Za-z0-9_-]{18,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{20,}$/.test(value)
}

export function isDiscordUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:') return false
  return parsed.hostname === 'discord.com' || parsed.hostname.endsWith('.discord.com')
}

export interface ApiRequestInfo {
  webContentsId?: number
  initiatorOrigin?: string
  resourceType: string
}

export function isFromDiscordPage(request: ApiRequestInfo, popupWebContentsId: number): boolean {
  return (
    request.webContentsId === popupWebContentsId &&
    request.initiatorOrigin === 'https://discord.com' &&
    request.resourceType === 'xhr'
  )
}

const REDACTED = '[redacted]'
const TOKEN_PATTERN =
  /(?<![A-Za-z0-9_+/-])[A-Za-z0-9_+/-]{18,}={0,2}(?:\.|%2[Ee])[A-Za-z0-9_+/-]{5,}={0,2}(?:\.|%2[Ee])[A-Za-z0-9_+/-]{20,}={0,2}/g
const MFA_TOKEN_PATTERN = /\bmfa(?:\.|%2[Ee])[A-Za-z0-9_+/-]{20,}={0,2}/g

export function redactTokens(text: string): string {
  return text.replace(TOKEN_PATTERN, REDACTED).replace(MFA_TOKEN_PATTERN, REDACTED)
}

const COOKIE_PATTERN =
  /\b(cf_clearance|__dcfduid|__sdcfduid|__cfruid|__cf_bm|_cfuvid|dbind|locale)=[^;\s'"]+/g
const COOKIE_HEADER_PATTERN = /(\\?['"]?cookie\\?['"]?\s*[:=]\s*\\?['"]?)[^'"\n}\\]+/gi
const AUTH_HEADER_PATTERN =
  /(\\?['"]?authorization\\?['"]?\s*[:=]\s*\\?['"]?(?:(?:bearer|bot|basic)\s+)?)[^'"\s,;&}\\]+/gi
const TOKEN_FIELD_PATTERN = /(\b[a-z_]*token\\?['"]?\s*[:=]\s*\\?['"]?)[^'"\s,;&}\\]+/gi

export function redactSecrets(text: string): string {
  try {
    const line = typeof text === 'string' ? text : String(text)
    return redactTokens(line)
      .replace(COOKIE_HEADER_PATTERN, `$1${REDACTED}`)
      .replace(COOKIE_PATTERN, `$1=${REDACTED}`)
      .replace(AUTH_HEADER_PATTERN, `$1${REDACTED}`)
      .replace(TOKEN_FIELD_PATTERN, `$1${REDACTED}`)
  } catch {
    return REDACTED
  }
}

export function buildCookieHeader(cookies: readonly CookieLike[]): string {
  const seen = new Set<string>()
  const parts: string[] = []
  for (const { name, value } of cookies) {
    if (!name || seen.has(name)) continue
    seen.add(name)
    parts.push(`${name}=${value}`)
  }
  return parts.join('; ')
}
