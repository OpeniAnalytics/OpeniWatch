import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Returns true only for http(s) URLs.
 *
 * Every external URL rendered by OpeniWatch passes through this check first:
 * source items are attacker-controlled, so `javascript:`, `data:` and other
 * schemes must never reach an anchor's href.
 */
export function isSafeExternalUrl(url: string | null | undefined): url is string {
  if (!url) return false
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/** Host of an external URL, for display next to a link. Empty when unsafe. */
export function externalUrlHost(url: string | null | undefined): string {
  if (!isSafeExternalUrl(url)) return ''
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

/** Truncates on a word boundary, appending an ellipsis. */
export function excerpt(text: string, maxLength = 180): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length <= maxLength) return clean
  const cut = clean.slice(0, maxLength)
  const lastSpace = cut.lastIndexOf(' ')
  return `${cut.slice(0, lastSpace > 40 ? lastSpace : maxLength)}…`
}

export function formatPercent(value: number): string {
  return `${Math.round(value)}%`
}

/** Formats a duration in seconds as a compact operational string. */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return '—'
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return `${s}s`
  if (s < 3600) {
    const m = Math.floor(s / 60)
    const rem = s % 60
    return rem ? `${m}m ${rem}s` : `${m}m`
  }
  const h = Math.floor(s / 3600)
  const m = Math.round((s % 3600) / 60)
  return m ? `${h}h ${m}m` : `${h}h`
}

/** Seconds between two ISO timestamps, or null when either is missing. */
export function secondsBetween(
  from: string | null | undefined,
  to: string | null | undefined,
): number | null {
  if (!from || !to) return null
  const a = Date.parse(from)
  const b = Date.parse(to)
  if (Number.isNaN(a) || Number.isNaN(b)) return null
  return (b - a) / 1000
}

export function average(values: number[]): number | null {
  const usable = values.filter((v) => Number.isFinite(v))
  if (usable.length === 0) return null
  return usable.reduce((sum, v) => sum + v, 0) / usable.length
}

/** Stable ascending sort helper that never mutates the input. */
export function sortBy<T>(items: readonly T[], key: (item: T) => number | string): T[] {
  return [...items].sort((a, b) => {
    const ka = key(a)
    const kb = key(b)
    if (ka < kb) return -1
    if (ka > kb) return 1
    return 0
  })
}
