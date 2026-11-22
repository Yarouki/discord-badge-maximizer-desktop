import { defineConfig } from 'electron-vite'
import { resolve } from 'path'

export default defineConfig(({ mode }) => ({
  main: {
    define: {
      __E2E_BUILD__: JSON.stringify(mode === 'e2e')
    }
  },
  preload: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          'discord-login': resolve(__dirname, 'src/preload/discord-login.ts'),
          tray: resolve(__dirname, 'src/preload/tray.ts')
        }
      }
    }
  },
  renderer: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          tray: resolve(__dirname, 'src/renderer/tray.html')
        }
      }
    },
    publicDir: resolve(__dirname, 'src/renderer/public')
  }
}))
