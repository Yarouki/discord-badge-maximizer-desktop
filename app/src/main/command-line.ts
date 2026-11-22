export function isInstalledApp(isPackaged: boolean, codeDir: string): boolean {
  return isPackaged || /[\\/]app\.asar(?:[\\/]|$)/i.test(codeDir)
}

export const EXPOSING_SWITCHES: readonly string[] = [
  'remote-debugging-port',
  'remote-debugging-pipe',
  'remote-debugging-address',
  'log-net-log',
  'ssl-key-log-file',
  'proxy-server',
  'ignore-certificate-errors',
  'host-rules',
  'host-resolver-rules',
  'load-extension',
  'disable-web-security'
]

const EXPOSING_VARIABLES: readonly string[] = ['sslkeylogfile']

export function exposingSwitches(hasSwitch: (name: string) => boolean): string[] {
  return EXPOSING_SWITCHES.filter((name) => hasSwitch(name))
}

const isExposing = (name: string): boolean => EXPOSING_VARIABLES.includes(name.toLowerCase())

export function exposingEnvironment(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env).filter((name) => isExposing(name) && Boolean(env[name]))
}

export function withoutExposingEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !isExposing(name)))
}

export function refusalMessage(switches: readonly string[], variables: readonly string[]): string {
  const names = [
    ...switches.map((s) => `--${s}`),
    ...variables.map((v) => `the ${v} environment variable`)
  ]
  const what = names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names.at(-1)}` : names[0]
  let next = 'Start it without that option.'
  if (names.length > 1) next = 'Start it without them.'
  else if (variables.length) next = 'Remove the variable, then start it again.'
  return `Badge Maximizer does not start with ${what}. ${next}`
}
