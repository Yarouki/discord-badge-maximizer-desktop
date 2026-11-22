import { registerFonts } from './fonts.js'
import { clockOffset, panelView } from './tray-view.js'

registerFonts(['Onest'])

const api = window.trayApi
const $ = (id) => document.getElementById(id)
let snapshot = null
let offset = 0
const warn = (err) => console.warn('Tray panel call failed:', err)

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text
}

function renderRows(rows) {
  const list = $('streamRows')
  const signature = JSON.stringify(rows)
  if (list.dataset.rows === signature) return
  list.dataset.rows = signature
  list.replaceChildren(
    ...rows.flatMap(([label, value]) => {
      const dt = document.createElement('dt')
      dt.textContent = label
      const dd = document.createElement('dd')
      dd.textContent = value
      dd.title = value
      return [dt, dd]
    })
  )
}

function renderStream(view) {
  const stream = view.stream
  $('streamTag').hidden = !stream
  $('streamHeadline').hidden = !stream
  $('streamRows').hidden = !stream
  $('streamIdle').hidden = Boolean(stream)
  if (!stream) {
    setText($('streamIdle'), view.streamIdle)
    return
  }
  setText($('streamTag'), stream.tag)
  $('streamTag').classList.toggle('connecting', !stream.live)
  setText($('streamHeadline'), stream.headline)
  renderRows(stream.rows)
}

function renderClaim(view) {
  const claim = view.claim
  $('claimRun').hidden = !claim
  $('claimIdle').hidden = Boolean(claim)
  if (!claim) {
    setText($('claimIdle'), view.claimIdle)
    return
  }
  setText($('claimTitle'), claim.title)
  $('claimBar').style.width = `${claim.pct}%`
  $('claimProg').setAttribute('aria-valuenow', String(claim.pct))
  setText($('claimDetail'), claim.detail)
  $('claimFailed').hidden = !claim.failed
  setText($('claimFailed'), claim.failed)
}

function render() {
  if (!snapshot) return
  const view = panelView(snapshot, Date.now() + offset)
  $('empty').hidden = !view.empty
  $('streamBlock').hidden = view.empty
  $('claimBlock').hidden = view.empty
  if (view.empty) {
    setText($('empty'), view.text)
    return
  }
  renderStream(view)
  renderClaim(view)
}

let fitPending = false
function fit() {
  if (fitPending) return
  fitPending = true
  requestAnimationFrame(() => {
    fitPending = false
    api.fit(Math.ceil($('card').getBoundingClientRect().height)).catch(warn)
  })
}
new ResizeObserver(fit).observe($('card'))

function adopt(next) {
  snapshot = next
  offset = clockOffset(next, Date.now())
  render()
}
api.onSnapshot(adopt)
api.snapshot().then(adopt, warn)
setInterval(render, 1000)

$('openApp').addEventListener('click', () => {
  api.openApp().catch(warn)
})
$('quit').addEventListener('click', () => {
  api.quit().catch(warn)
})
addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.close()
})
