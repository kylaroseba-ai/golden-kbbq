export const peso = (n: number | string | null | undefined) =>
  '₱' + Number(n ?? 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

// Quantities are stored in base units (g, ml, pc); show them in the item's count unit.
export function qty(base: number | string, item: { base_unit: string; count_unit?: string; count_unit_factor?: number | string }) {
  const n = Number(base)
  const f = Number(item.count_unit_factor ?? 1)
  if (f !== 1 && item.count_unit) return `${(n / f).toLocaleString('en-PH', { maximumFractionDigits: 2 })} ${item.count_unit}`
  return `${n.toLocaleString('en-PH', { maximumFractionDigits: 1 })} ${item.base_unit}`
}

export const time = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Manila' }) : '—'
export const dateTime = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Manila' }) : '—'

export function mmss(ms: number) {
  const neg = ms < 0
  const s = Math.floor(Math.abs(ms) / 1000)
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
  const body = h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`
  return (neg ? '+' : '') + body
}

export const manilaDate = (d = new Date()) => new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
