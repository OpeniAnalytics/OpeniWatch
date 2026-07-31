/**
 * Time formatting.
 *
 * Operational alerts are read across time zones: the SOC may be in Texas while
 * the location is in Pennsylvania. Every timestamp tied to a location is shown
 * in that location's time zone with the zone abbreviation attached, so "1:39
 * PM CT" is never ambiguous.
 */

export function formatTime(iso: string, timeZone?: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
    timeZoneName: 'short',
  }).format(date)
}

export function formatDateTime(iso: string, timeZone?: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
    timeZoneName: 'short',
  }).format(date)
}

export function formatDate(iso: string, timeZone?: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone,
  }).format(date)
}

/** Compact relative time, e.g. "4m ago". */
export function formatRelative(iso: string, now = Date.now()): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return '—'
  const seconds = Math.round((now - then) / 1000)

  if (seconds < 0) return 'in the future'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  return `${months}mo ago`
}

/** Start and end of the day containing `reference`, as ISO strings. */
export function dayRange(reference = new Date()): { from: string; to: string } {
  const start = new Date(reference)
  start.setHours(0, 0, 0, 0)
  const end = new Date(reference)
  end.setHours(23, 59, 59, 999)
  return { from: start.toISOString(), to: end.toISOString() }
}

/** The seven days ending with the day containing `reference`. */
export function weekRange(reference = new Date()): { from: string; to: string } {
  const end = new Date(reference)
  end.setHours(23, 59, 59, 999)
  const start = new Date(end)
  start.setDate(start.getDate() - 6)
  start.setHours(0, 0, 0, 0)
  return { from: start.toISOString(), to: end.toISOString() }
}
