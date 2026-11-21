const PAGE = 8

export function moveIndex(key, current, count) {
  if (count <= 0) return null
  const last = count - 1
  const clamp = (i) => Math.max(0, Math.min(last, i))
  switch (key) {
    case 'ArrowDown':
      return current < 0 ? 0 : clamp(current + 1)
    case 'ArrowUp':
      return current < 0 ? last : clamp(current - 1)
    case 'Home':
      return 0
    case 'End':
      return last
    case 'PageDown':
      return clamp(current + PAGE)
    case 'PageUp':
      return clamp(current - PAGE)
    default:
      return null
  }
}

export function typeAhead(items, query, current) {
  const q = query.toLowerCase()
  if (!q || !items.length) return null
  const start = q.length === 1 ? current + 1 : Math.max(current, 0)
  for (let n = 0; n < items.length; n++) {
    const i = (start + n) % items.length
    if (items[i].name.toLowerCase().startsWith(q)) return i
  }
  return null
}

export function pickInitial(items, remembered) {
  if (items.some((i) => i.id === remembered)) return remembered
  return items[0]?.id ?? ''
}

export function initials(name) {
  const words = name.trim().split(/\s+/).filter(Boolean).slice(0, 2)
  if (!words.length) return '?'
  return words.map((w) => Array.from(w)[0].toUpperCase()).join('')
}
