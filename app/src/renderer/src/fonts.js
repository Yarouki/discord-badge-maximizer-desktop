import anybodyLatin from '@fontsource-variable/anybody/files/anybody-latin-wdth-normal.woff2?url'
import anybodyLatinExt from '@fontsource-variable/anybody/files/anybody-latin-ext-wdth-normal.woff2?url'
import onestLatin from '@fontsource-variable/onest/files/onest-latin-wght-normal.woff2?url'
import onestLatinExt from '@fontsource-variable/onest/files/onest-latin-ext-wght-normal.woff2?url'
import onestCyrillic from '@fontsource-variable/onest/files/onest-cyrillic-wght-normal.woff2?url'

const LATIN =
  'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD'
const LATIN_EXT =
  'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF'
const CYRILLIC = 'U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116'

const FACES = [
  ['Anybody', anybodyLatin, { weight: '100 900', stretch: '50% 150%', unicodeRange: LATIN }],
  ['Anybody', anybodyLatinExt, { weight: '100 900', stretch: '50% 150%', unicodeRange: LATIN_EXT }],
  ['Onest', onestLatin, { weight: '100 900', unicodeRange: LATIN }],
  ['Onest', onestLatinExt, { weight: '100 900', unicodeRange: LATIN_EXT }],
  ['Onest', onestCyrillic, { weight: '100 900', unicodeRange: CYRILLIC }]
]

export function fontSource(url) {
  const quoted = String(url).replace(/[\\"]/g, '\\$&').replace(/\n/g, '\\a ')
  return `url("${quoted}") format('woff2')`
}

export function registerFonts() {
  for (const [family, url, descriptors] of FACES) {
    document.fonts.add(new FontFace(family, fontSource(url), { display: 'swap', ...descriptors }))
  }
}
