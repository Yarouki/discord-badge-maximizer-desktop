import type { AccountRole, PublicAccounts } from '../shared/ipc'

export type { AccountRole, PublicAccounts }

export interface StoredAccount {
  readonly id: string
  readonly username: string
  readonly displayName: string
  readonly token: string
  readonly cookie: string
  readonly addedAt: number
}

export interface AccountsState {
  readonly mainId: string | null
  readonly altId: string | null
  readonly accounts: readonly StoredAccount[]
  readonly legacyImported?: true
}

export function emptyAccounts(): AccountsState {
  return { mainId: null, altId: null, accounts: [] }
}

const has = (state: AccountsState, id: string | null): boolean =>
  id !== null && state.accounts.some((a) => a.id === id)

export function upsertAccount(state: AccountsState, account: StoredAccount): AccountsState {
  const exists = state.accounts.some((a) => a.id === account.id)
  const replace = (a: StoredAccount): StoredAccount => ({
    ...account,
    cookie: account.cookie || a.cookie,
    addedAt: a.addedAt
  })
  return {
    ...state,
    accounts: exists
      ? state.accounts.map((a) => (a.id === account.id ? replace(a) : a))
      : [...state.accounts, account]
  }
}

export function setRole(state: AccountsState, id: string, role: AccountRole): AccountsState {
  if (!has(state, id)) throw new Error('That account is not saved.')
  if (role === 'main') {
    return id === state.altId
      ? { ...state, mainId: id, altId: state.mainId }
      : { ...state, mainId: id }
  }
  if (id === state.mainId) {
    if (!state.altId) throw new Error('Pick another main account first.')
    return { ...state, mainId: state.altId, altId: id }
  }
  return { ...state, altId: id }
}

export function clearAlt(state: AccountsState): AccountsState {
  return { ...state, altId: null }
}

export function removeAccount(state: AccountsState, id: string): AccountsState {
  return {
    ...state,
    mainId: state.mainId === id ? null : state.mainId,
    altId: state.altId === id ? null : state.altId,
    accounts: state.accounts.filter((a) => a.id !== id)
  }
}

export function findAccount(state: AccountsState, id: string | null): StoredAccount | undefined {
  return id === null ? undefined : state.accounts.find((a) => a.id === id)
}

export function publicView(state: AccountsState): PublicAccounts {
  return {
    mainId: state.mainId,
    altId: state.altId,
    accounts: state.accounts.map(({ id, username, displayName }) => ({ id, username, displayName }))
  }
}

export function assertValidState(state: AccountsState): void {
  const ids = new Set(state.accounts.map((a) => a.id))
  const valid =
    ids.size === state.accounts.length &&
    (state.mainId === null || ids.has(state.mainId)) &&
    (state.altId === null || ids.has(state.altId)) &&
    (state.altId === null || state.altId !== state.mainId)
  if (!valid) {
    throw new Error(
      'Something went wrong with the saved account roles, so nothing was changed. Try again, and restart the app if it keeps happening.'
    )
  }
}

const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0

function parseAccount(value: unknown): StoredAccount | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if (!isText(v.id) || !isText(v.token)) return null
  return {
    id: v.id,
    username: typeof v.username === 'string' ? v.username : '',
    displayName: typeof v.displayName === 'string' ? v.displayName : '',
    token: v.token,
    cookie: typeof v.cookie === 'string' ? v.cookie : '',
    addedAt: typeof v.addedAt === 'number' ? v.addedAt : 0
  }
}

export function parseStoredState(value: unknown): AccountsState {
  if (typeof value !== 'object' || value === null) return emptyAccounts()
  const v = value as Record<string, unknown>
  const accounts: StoredAccount[] = []
  for (const entry of Array.isArray(v.accounts) ? v.accounts : []) {
    const account = parseAccount(entry)
    if (account && !accounts.some((a) => a.id === account.id)) accounts.push(account)
  }
  const state: AccountsState = { mainId: null, altId: null, accounts }
  return {
    ...state,
    mainId: isText(v.mainId) && has(state, v.mainId) ? v.mainId : null,
    altId: isText(v.altId) && has(state, v.altId) && v.altId !== v.mainId ? v.altId : null,
    ...(v.legacyImported === true ? { legacyImported: true } : {})
  }
}
