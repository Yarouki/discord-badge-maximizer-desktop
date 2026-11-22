import type { AccountStore } from './account-store'
import {
  clearAlt,
  findAccount,
  publicView,
  removeAccount,
  setRole,
  upsertAccount,
  type AccountRole,
  type AccountsState
} from './accounts-model'
import type { PythonBridge } from './bridge'
import { redactSecrets } from './discord-auth'
import { DiscordRefusedError, type DiscordIdentity } from './discord-identity'
import type { DiscordLoginResult } from './discord-login'
import { errorMessage } from './errors'
import type { AccountResult, AltState, LoginResult, OkResult } from '../shared/ipc'

export type { AccountResult }

export type AccountBridge = Pick<
  PythonBridge,
  | 'validateCredentials'
  | 'connectAlt'
  | 'disconnectAlt'
  | 'legacyLogin'
  | 'legacyClear'
  | 'logout'
  | 'isRunning'
  | 'backendId'
>
type Store = Pick<AccountStore, 'get' | 'update' | 'loadProblem' | 'deleteBadCopies'>
type OpenLogin = (role: AccountRole) => Promise<DiscordLoginResult>
type Identify = (token: string) => Promise<DiscordIdentity>

interface Extra {
  login?: LoginResult
  alt?: AltState
}

interface AppliedSession {
  backend: number
  mainId: string
  altId: string | null
  login: LoginResult
  alt: AltState
}

const text = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

class Warnings {
  private readonly list: string[] = []
  private toldAboutDisk = false

  add(sentence: string | null | undefined): void {
    if (sentence && !this.list.includes(sentence)) this.list.push(sentence)
  }

  notSaved(reason: string, what: 'login' | 'change'): void {
    if (this.toldAboutDisk) return
    this.toldAboutDisk = true
    this.add(
      what === 'login'
        ? `Logged in, but the login could not be saved to disk (${reason}). It will be gone after closing the app.`
        : `Your account changes could not be saved to disk (${reason}). They will be gone after closing the app.`
    )
  }

  get text(): string | undefined {
    return this.list.length ? this.list.join(' ') : undefined
  }
}

export class AccountManager {
  private queue: Promise<unknown> = Promise.resolve()
  private loadProblemTold = false
  private applied: AppliedSession | null = null

  constructor(
    private readonly store: Store,
    private readonly bridge: AccountBridge,
    private readonly openLogin: OpenLogin,
    private readonly identify: Identify,
    private readonly warn: (message: string) => void = (m) => console.warn(m),
    private readonly streaming: () => boolean = () => false
  ) {}

  forgetAppliedAlt(): void {
    if (this.applied) this.applied = { ...this.applied, alt: null }
  }

  private serial(work: (warnings: Warnings) => Promise<AccountResult>): Promise<AccountResult> {
    const warnings = new Warnings()
    const run = (): Promise<AccountResult> =>
      work(warnings).catch((e: unknown) => this.fail(redactSecrets(errorMessage(e)), warnings))
    const next = this.queue.then(run, run)
    this.queue = next
    return next
  }

  private view(): AccountResult['accounts'] {
    return publicView(this.store.get())
  }

  refuse(error: string): AccountResult {
    return this.fail(error, new Warnings())
  }

  private ok(warnings: Warnings, extra: Extra = {}): AccountResult {
    const warning = warnings.text
    return { ok: true, ...extra, ...(warning ? { warning } : {}), accounts: this.view() }
  }

  private fail(error: string, warnings: Warnings, extra: Extra = {}): AccountResult {
    const warning = warnings.text
    return {
      ok: false,
      error: error || 'Something went wrong.',
      ...extra,
      ...(warning ? { warning } : {}),
      accounts: this.view()
    }
  }

  private apply(
    change: (s: AccountsState) => AccountsState,
    warnings: Warnings,
    what: 'login' | 'change' = 'change'
  ): boolean {
    const status = this.store.update(change)
    if (!status.saved) warnings.notSaved(status.reason, what)
    return status.saved
  }

  private async save(
    token: string,
    cookie: string,
    warnings: Warnings
  ): Promise<{ id: string; saved: boolean }> {
    const who = await this.identify(token)
    const saved = this.apply(
      (s) => upsertAccount(s, { ...who, token, cookie, addedAt: Date.now() }),
      warnings,
      'login'
    )
    return { id: who.id, saved }
  }

  private remember(login: LoginResult | undefined, alt: AltState | undefined): void {
    const backend = this.bridge.backendId()
    const previous = this.applied?.backend === backend ? this.applied : null
    const { mainId, altId } = this.store.get()
    const keptLogin = login ?? previous?.login
    const keptAlt = alt !== undefined ? alt : previous?.alt
    if (backend === null || !mainId || !keptLogin?.ok || keptAlt === undefined) {
      this.applied = null
      return
    }
    this.applied = { backend, mainId, altId, login: keptLogin, alt: keptAlt }
  }

  private keptSession(): AppliedSession | null {
    const session = this.applied
    if (!session || session.backend !== this.bridge.backendId()) return null
    const { mainId, altId } = this.store.get()
    return session.mainId === mainId && session.altId === altId ? session : null
  }

  private async applyMain(): Promise<LoginResult> {
    const main = findAccount(this.store.get(), this.store.get().mainId)
    if (!main) return { ok: false, error: 'No main account is saved.' }
    if (!main.cookie) {
      return { ok: false, error: 'Log in with this account again to use it as the main account.' }
    }
    return this.bridge.validateCredentials(main.token, main.cookie)
  }

  private async applyAlt(): Promise<AltState> {
    const alt = findAccount(this.store.get(), this.store.get().altId)
    if (!alt) {
      const res = await this.bridge.disconnectAlt()
      if (!res.ok) throw new Error(res.error || "Couldn't disconnect the alt.")
      return null
    }
    const res = await this.bridge.connectAlt(alt.token)
    if (!res.ok) throw new Error(res.error || "Couldn't connect the alt.")
    return { username: text(res.username) ?? alt.displayName }
  }

  private async changeRoles(
    change: (s: AccountsState) => AccountsState,
    force: AccountRole | null,
    warnings: Warnings
  ): Promise<AccountResult> {
    const before = this.store.get()
    const after = change(before)
    this.apply(() => after, warnings)
    const extra: Extra = {}
    const mainChanged = after.mainId !== before.mainId || force === 'main'
    if (mainChanged) {
      const login = await this.applyMain()
      if (!login.ok) {
        this.applied = null
        this.apply(() => before, warnings)
        if (login.unanswered) await this.resyncMain()
        return this.fail(login.error || "Couldn't log in with that account.", warnings, { login })
      }
      extra.login = login
    }
    if (mainChanged || after.altId !== before.altId || force === 'alt') {
      try {
        extra.alt = await this.applyAlt()
      } catch (e) {
        if (mainChanged) this.applied = null
        return this.altFailed(errorMessage(e), before.altId, warnings, extra)
      }
    }
    this.remember(extra.login, extra.alt)
    return this.ok(warnings, extra)
  }

  private async resyncMain(): Promise<void> {
    if (!this.bridge.isRunning()) return
    const res = this.store.get().mainId ? await this.applyMain() : await this.bridge.logout()
    if (!res.ok)
      this.warn(`Putting the backend back on the saved main after a late switch: ${res.error}`)
  }

  private async altFailed(
    error: string,
    oldAltId: string | null,
    warnings: Warnings,
    extra: Extra
  ): Promise<AccountResult> {
    const keepOld = oldAltId !== null && oldAltId !== this.store.get().mainId
    this.apply((s) => ({ ...s, altId: keepOld ? oldAltId : null }), warnings)
    if (keepOld) return this.fail(error, warnings, extra)
    if (oldAltId !== null) {
      const res = await this.dropBackendAlt()
      if (!res.ok) this.warn(`Dropping the old alt after a failed alt change: ${res.error}`)
    }
    return this.fail(error, warnings, { ...extra, alt: null })
  }

  restore(): Promise<AccountResult> {
    return this.serial(async (warnings) => {
      if (!this.loadProblemTold) warnings.add(this.store.loadProblem)
      this.loadProblemTold = true
      await this.importLegacy(warnings)
      const state = this.store.get()
      if (!state.mainId) {
        this.applied = null
        const warning = warnings.text
        return {
          ok: false,
          nothingSaved: true,
          ...(warning ? { warning } : {}),
          accounts: this.view()
        }
      }
      const kept = this.keptSession()
      if (kept) return this.ok(warnings, { login: kept.login, alt: kept.alt })
      this.applied = null
      const login = await this.applyMain()
      if (!login.ok) return this.fail(login.error || "Couldn't log back in.", warnings)
      const alt = state.altId ? await this.restoreAlt(warnings) : null
      this.remember(login, alt)
      return this.ok(warnings, { login, alt })
    })
  }

  private async restoreAlt(warnings: Warnings): Promise<AltState> {
    if (this.streaming()) {
      const alt = findAccount(this.store.get(), this.store.get().altId)
      warnings.add(
        'The alt account was not connected again while your stream runs. Pick it again under Alt viewer after the stream ends if it does not watch.'
      )
      return alt ? { username: alt.displayName } : null
    }
    try {
      return await this.applyAlt()
    } catch (e) {
      this.apply(clearAlt, warnings)
      warnings.add(
        `Couldn't reconnect the alt: ${errorMessage(e)} Pick it again under Alt viewer to try once more.`
      )
      return null
    }
  }

  private async importLegacy(warnings: Warnings): Promise<void> {
    const legacy = await this.bridge.legacyLogin()
    if (!legacy.ok) {
      this.warn(`Reading the old login: ${legacy.error}`)
      return
    }
    if (legacy.found !== true) return
    if (this.store.get().legacyImported) return this.wipeLegacy()
    const token = text(legacy.token)
    if (!token) {
      this.warn('Reading the old login: the backend sent no token')
      return
    }
    const altToken = text(legacy.altToken)
    const fillRoles = !this.store.get().mainId
    const cookie = text(legacy.cookie) ?? ''
    const mainDone = await this.importOne(token, cookie, 'main', fillRoles, warnings)
    const altDone = altToken ? await this.importOne(altToken, '', 'alt', fillRoles, warnings) : true
    if (!mainDone || !altDone) return
    if (!this.apply((s) => ({ ...s, legacyImported: true }), warnings, 'login')) return
    await this.wipeLegacy()
  }

  private async wipeLegacy(): Promise<void> {
    const cleared = await this.bridge.legacyClear()
    if (!cleared.ok) this.warn(`Could not wipe the old login file: ${cleared.error}`)
  }

  private async importOne(
    token: string,
    cookie: string,
    role: AccountRole,
    fillRoles: boolean,
    warnings: Warnings
  ): Promise<boolean> {
    let who: DiscordIdentity
    try {
      who = await this.identify(token)
    } catch (e) {
      this.warn(`Importing the old ${role} login: ${redactSecrets(errorMessage(e))}`)
      return e instanceof DiscordRefusedError
    }
    if (findAccount(this.store.get(), who.id)) return true
    const saved = this.apply(
      (s) => upsertAccount(s, { ...who, token, cookie, addedAt: Date.now() }),
      warnings,
      'login'
    )
    if (!fillRoles) return saved
    const { mainId, altId } = this.store.get()
    let roleSaved = true
    if (role === 'main' && !mainId) {
      roleSaved = this.apply((s) => setRole(s, who.id, 'main'), warnings, 'login')
    } else if (role === 'alt' && !altId && who.id !== mainId) {
      roleSaved = this.apply((s) => setRole(s, who.id, 'alt'), warnings, 'login')
    }
    return saved && roleSaved
  }

  login(role: AccountRole): Promise<AccountResult> {
    return this.serial(async (warnings) => {
      const popup = await this.openLogin(role)
      if (!popup.ok) return this.fail(popup.error || 'Login cancelled.', warnings)
      const { id } = await this.save(popup.token, popup.cookie, warnings)
      if (role === 'alt' && id === this.store.get().mainId) {
        return this.fail(
          'That is your main account. Log in with a different account for the alt.',
          warnings
        )
      }
      return this.changeRoles((s) => setRole(s, id, role), role, warnings)
    })
  }

  add(): Promise<AccountResult> {
    return this.serial(async (warnings) => {
      const popup = await this.openLogin('main')
      if (!popup.ok) return this.fail(popup.error || 'Login cancelled.', warnings)
      const { id } = await this.save(popup.token, popup.cookie, warnings)
      if (this.store.get().mainId) return this.ok(warnings)
      return this.changeRoles((s) => setRole(s, id, 'main'), 'main', warnings)
    })
  }

  use(id: string, role: AccountRole): Promise<AccountResult> {
    return this.serial(async (warnings) => {
      const { mainId, altId } = this.store.get()
      const again = id === (role === 'main' ? mainId : altId) ? role : null
      return this.changeRoles((s) => setRole(s, id, role), again, warnings)
    })
  }

  private dropBackendAlt(): Promise<OkResult> {
    return this.bridge.isRunning() ? this.bridge.disconnectAlt() : Promise.resolve({ ok: true })
  }

  private logoutBackend(): Promise<OkResult> {
    return this.bridge.isRunning() ? this.bridge.logout() : Promise.resolve({ ok: true })
  }

  clearAlt(): Promise<AccountResult> {
    return this.serial(async (warnings) => {
      const res = await this.dropBackendAlt()
      if (!res.ok) return this.fail(res.error || "Couldn't disconnect the alt.", warnings)
      this.apply(clearAlt, warnings)
      this.remember(undefined, null)
      return this.ok(warnings, { alt: null })
    })
  }

  remove(id: string): Promise<AccountResult> {
    return this.serial((warnings) => this.removeNow(id, warnings))
  }

  logout(): Promise<AccountResult> {
    return this.serial(async (warnings) => {
      const { mainId } = this.store.get()
      return mainId ? this.removeNow(mainId, warnings) : this.ok(warnings)
    })
  }

  private async removeNow(id: string, warnings: Warnings): Promise<AccountResult> {
    const { mainId, altId } = this.store.get()
    if (id === mainId) {
      const res = await this.logoutBackend()
      if (!res.ok) return this.fail(res.error || "Couldn't log out.", warnings)
      this.applied = null
      this.apply((s) => clearAlt(removeAccount(s, id)), warnings)
      this.store.deleteBadCopies()
      return this.ok(warnings, { alt: null })
    }
    if (id === altId) {
      const res = await this.dropBackendAlt()
      if (!res.ok) return this.fail(res.error || "Couldn't disconnect the alt.", warnings)
    }
    this.apply((s) => removeAccount(s, id), warnings)
    this.store.deleteBadCopies()
    if (id === altId) this.remember(undefined, null)
    return this.ok(warnings, id === altId ? { alt: null } : {})
  }
}
