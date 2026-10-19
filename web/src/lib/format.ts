import type { CampaignStatus } from './api'

export function money(cents: number, currency = 'usd'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100)
}

const DAY = 86_400_000

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10)
}

export function daysInclusive(start: string, end: string): number {
  if (!start || !end || end < start) return 0
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY) + 1
}

export function niceDate(iso: string): string {
  return new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

export function dateRange(start: string, end: string): string {
  return start === end ? niceDate(start) : `${niceDate(start)} – ${niceDate(end)}`
}

export function quoteCents(rates: number[], start: string, end: string): number {
  return rates.reduce((a, b) => a + b, 0) * daysInclusive(start, end)
}

export const STATUS_LABEL: Record<CampaignStatus, string> = {
  awaiting_payment: 'Awaiting payment',
  in_review: 'In review',
  approved: 'Approved',
  rejected: 'Rejected',
  expired: 'Checkout expired',
}

/** Approved campaigns are "Live" during their dates and "Scheduled" before. */
export function liveLabel(status: CampaignStatus, start: string, end: string, today: string): string {
  if (status !== 'approved') return STATUS_LABEL[status]
  if (today < start) return 'Scheduled'
  if (today > end) return 'Finished'
  return 'Live'
}

export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return 'never'
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}
