export const TEST_HOOKS_VARIABLE = 'BADGE_E2E_HOOKS'

export function testHooksWanted(isPackaged: boolean, env: NodeJS.ProcessEnv): boolean {
  return !isPackaged && env[TEST_HOOKS_VARIABLE] === '1'
}

export function installTestHooks(hooks: object): void {
  ;(globalThis as Record<string, unknown>).__badgeTest = hooks
}
