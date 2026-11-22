import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const bundle = join(import.meta.dirname, '..', 'out', 'main', 'index.js')
const SEAM_MARKS = ['__badgeTest', 'BADGE_E2E_HOOKS']

let code
try {
  code = readFileSync(bundle, 'utf8')
} catch (e) {
  console.error(`The main bundle could not be read (${e.message}). Build the app first.`)
  process.exit(1)
}
const found = SEAM_MARKS.filter((mark) => code.includes(mark))
if (found.length > 0) {
  console.error(
    `The main bundle holds the end-to-end test seam (${found.join(', ')}). ` +
      'It was built with --mode e2e; run npm run build for a release.'
  )
  process.exit(1)
}
console.log('The main bundle holds no test seam.')
