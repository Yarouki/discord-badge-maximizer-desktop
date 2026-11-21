import { initials, moveIndex, pickInitial, typeAhead } from './picker-nav.js'

const TYPE_RESET_MS = 700
const LIST_MAX_PX = 264
const ICON_PREFIX = 'https://cdn.discordapp.com/icons/'
const SVG_NS = 'http://www.w3.org/2000/svg'

function svgUse(symbol, className) {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('class', className)
  const use = document.createElementNS(SVG_NS, 'use')
  use.setAttribute('href', symbol)
  svg.append(use)
  return svg
}

function iconFor(kind, item) {
  const el = document.createElement('span')
  el.className = `picker-ico ${kind}`
  el.setAttribute('aria-hidden', 'true')
  if (kind === 'voice') {
    el.append(svgUse('#ic-voice', 'picker-glyph'))
    return el
  }
  const fallback = () => {
    el.replaceChildren(initials(item.name))
  }
  if (typeof item.icon === 'string' && item.icon.startsWith(ICON_PREFIX)) {
    const img = new Image()
    img.alt = ''
    img.referrerPolicy = 'no-referrer'
    img.addEventListener('error', fallback, { once: true })
    img.src = item.icon
    el.append(img)
  } else {
    fallback()
  }
  return el
}

function nameSpan(text, className) {
  const s = document.createElement('span')
  s.className = className
  s.textContent = text
  return s
}

export function createPicker(root, { kind, onChange }) {
  const btn = root.querySelector('.picker-btn')
  const face = root.querySelector('.picker-face')
  const list = root.querySelector('.picker-list')
  const announcer = nameSpan('', 'sr-only')
  announcer.setAttribute('aria-live', 'polite')
  root.append(announcer)
  let items = []
  let value = ''
  let active = -1
  let isOpen = false
  let isDisabled = false
  let isUnavailable = true
  let typed = ''
  let typedAt = 0
  let movedByKey = false

  const optionId = (i) => `${list.id}-${i}`

  function renderFace(status) {
    const item = items.find((i) => i.id === value)
    if (!item) {
      face.replaceChildren(nameSpan(status ?? '', 'picker-status'))
      announcer.textContent = status ?? ''
      return
    }
    announcer.textContent = ''
    face.replaceChildren(iconFor(kind, item), nameSpan(item.name, 'picker-name'))
  }

  function renderList() {
    list.replaceChildren(
      ...items.map((item, i) => {
        const li = document.createElement('li')
        li.id = optionId(i)
        li.className = 'picker-opt'
        li.setAttribute('role', 'option')
        li.setAttribute('aria-selected', String(item.id === value))
        li.dataset.index = String(i)
        li.append(iconFor(kind, item), nameSpan(item.name, 'picker-name'))
        if (item.id === value) li.append(svgUse('#ic-tick', 'tick'))
        return li
      })
    )
  }

  function setActive(i, scroll = true) {
    active = i
    list.querySelectorAll('.picker-opt').forEach((li, n) => li.classList.toggle('active', n === i))
    if (i < 0) {
      btn.removeAttribute('aria-activedescendant')
      return
    }
    btn.setAttribute('aria-activedescendant', optionId(i))
    if (scroll) list.children[i]?.scrollIntoView({ block: 'nearest' })
  }

  function keyMove(i) {
    movedByKey = true
    setActive(i)
  }

  function syncDisabled() {
    isUnavailable = isDisabled || items.length === 0
    btn.setAttribute('aria-disabled', String(isUnavailable))
    if (isUnavailable) close(false)
  }

  function resetTyping() {
    typed = ''
    typedAt = 0
    movedByKey = false
  }

  function open() {
    if (isOpen || isUnavailable) return
    resetTyping()
    isOpen = true
    renderList()
    const r = btn.getBoundingClientRect()
    const below = innerHeight - r.bottom
    root.classList.toggle(
      'up',
      below < Math.min(LIST_MAX_PX, items.length * 40 + 20) && r.top > below
    )
    list.hidden = false
    btn.setAttribute('aria-expanded', 'true')
    setActive(
      Math.max(
        0,
        items.findIndex((i) => i.id === value)
      )
    )
  }

  function close(refocus) {
    if (!isOpen) return
    isOpen = false
    list.hidden = true
    btn.setAttribute('aria-expanded', 'false')
    setActive(-1)
    resetTyping()
    if (refocus) btn.focus()
  }

  function choose(i) {
    const item = items[i]
    close(true)
    if (!item || item.id === value) return
    value = item.id
    renderFace()
    onChange(value)
  }

  function onType(key) {
    const now = performance.now()
    typed = now - typedAt > TYPE_RESET_MS ? key : typed + key
    typedAt = now
    const hit = typeAhead(items, typed, active)
    if (hit !== null) keyMove(hit)
  }

  const isTyping = () => typed !== '' && performance.now() - typedAt <= TYPE_RESET_MS

  btn.addEventListener('click', () => (isOpen ? close(true) : open()))
  btn.addEventListener('keydown', (e) => {
    const { key } = e
    const printable = key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey
    if (!isOpen) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' ', 'Home', 'End'].includes(key)) {
        e.preventDefault()
        open()
        if (isOpen && (key === 'Home' || key === 'End'))
          keyMove(moveIndex(key, active, items.length))
      } else if (printable && key !== ' ') {
        open()
        if (isOpen) onType(key)
      }
      return
    }
    const next = moveIndex(key, active, items.length)
    if (next !== null) {
      e.preventDefault()
      keyMove(next)
      return
    }
    if (key === 'Enter' || (key === ' ' && !isTyping())) {
      e.preventDefault()
      choose(active)
      return
    }
    if (key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close(true)
      return
    }
    if (key === 'Tab') {
      if (movedByKey) choose(active)
      else close(false)
      return
    }
    if (printable) {
      e.preventDefault()
      onType(key)
    }
  })
  list.addEventListener('mousedown', (e) => e.preventDefault())
  list.addEventListener('click', (e) => {
    const li = e.target.closest('.picker-opt')
    if (li) choose(Number(li.dataset.index))
  })
  list.addEventListener('mousemove', (e) => {
    const li = e.target.closest('.picker-opt')
    if (li && Number(li.dataset.index) !== active) {
      movedByKey = false
      setActive(Number(li.dataset.index), false)
    }
  })
  document.addEventListener('pointerdown', (e) => {
    if (isOpen && !root.contains(e.target)) close(false)
  })
  btn.addEventListener('blur', () => close(false))

  return {
    get value() {
      return value
    },
    get name() {
      return items.find((i) => i.id === value)?.name ?? ''
    },
    setItems(next, remembered) {
      items = next.filter((i) => i && typeof i.id === 'string' && typeof i.name === 'string')
      value = pickInitial(items, remembered)
      close(false)
      renderFace()
      syncDisabled()
    },
    setStatus(text) {
      items = []
      value = ''
      renderFace(text)
      syncDisabled()
    },
    set disabled(v) {
      isDisabled = !!v
      syncDisabled()
    },
    focus() {
      btn.focus()
    },
    setInvalid(bad) {
      btn.setAttribute('aria-invalid', String(!!bad))
    }
  }
}
