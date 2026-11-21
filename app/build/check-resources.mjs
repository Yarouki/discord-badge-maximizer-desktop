import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const scriptsDir = join(appDir, '..', 'scripts')
const bridgeDir = join(scriptsDir, 'bridge')
const backendExe = join(appDir, 'resources-backend', 'badge-backend.exe')
const ffmpegExe = join(appDir, 'resources-ffmpeg', 'ffmpeg.exe')

const problems = []
const backendSources = ['bridge_adapter.py', 'games.py', 'stream.py'].map((f) =>
  join(scriptsDir, f)
)
if (existsSync(bridgeDir)) {
  const modules = readdirSync(bridgeDir).filter((f) => f.endsWith('.py'))
  backendSources.push(...modules.map((f) => join(bridgeDir, f)))
} else {
  problems.push(`Missing ${bridgeDir}, the backend's Python package.`)
}

if (!existsSync(backendExe)) {
  problems.push(`Missing ${backendExe}. Build it with: npm run build:backend`)
} else {
  const builtAt = statSync(backendExe).mtimeMs
  const newer = backendSources.filter((f) => existsSync(f) && statSync(f).mtimeMs > builtAt)
  if (newer.length) {
    problems.push(
      `badge-backend.exe is older than ${newer.map((f) => relative(scriptsDir, f)).join(', ')}. Build it again with: npm run build:backend`
    )
  }
}
if (!existsSync(ffmpegExe)) {
  problems.push(
    `Missing ${ffmpegExe}. Copy a GPL build of ffmpeg.exe there (its license and notice files are already in that folder).`
  )
}

if (problems.length) {
  console.error('The installer cannot be built yet:')
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}
console.log('Backend exe and FFmpeg are in place.')
