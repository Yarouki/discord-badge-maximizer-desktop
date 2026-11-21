import { contextBridge } from 'electron'

function disableWebAuthn(): void {
  const blocked = (): Promise<never> =>
    Promise.reject(
      new DOMException(
        'Security keys and passkeys are turned off in Badge Maximizer.',
        'NotAllowedError'
      )
    )

  delete (window as { PublicKeyCredential?: unknown }).PublicKeyCredential

  const credentials = navigator.credentials
  if (!credentials) return
  const originalGet = credentials.get.bind(credentials)
  const originalCreate = credentials.create.bind(credentials)
  Object.defineProperty(credentials, 'get', {
    value: (options?: CredentialRequestOptions) =>
      options && 'publicKey' in options ? blocked() : originalGet(options),
    writable: false,
    configurable: false
  })
  Object.defineProperty(credentials, 'create', {
    value: (options?: CredentialCreationOptions) =>
      options && 'publicKey' in options ? blocked() : originalCreate(options),
    writable: false,
    configurable: false
  })
}

contextBridge.executeInMainWorld({ func: disableWebAuthn })
