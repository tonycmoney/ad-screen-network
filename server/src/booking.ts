/** Pure booking rules: dates, pricing and screen capacity. */

export const DAY_MS = 86_400_000

/** Today's date in the network's timezone as YYYY-MM-DD. */
export function localDate(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}

export function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

/** Inclusive number of days between two ISO dates. */
export function daysInclusive(start: string, end: string): number {
  const a = Date.parse(`${start}T00:00:00Z`)
  const b = Date.parse(`${end}T00:00:00Z`)
  return Math.round((b - a) / DAY_MS) + 1
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10)
}

export interface DateCheck {
  start: string
  end: string
  today: string
  maxDays: number
}

/** Returns an error message, or null when the range can be booked. */
export function checkDates({ start, end, today, maxDays }: DateCheck): string | null {
  if (!isIsoDate(start) || !isIsoDate(end)) return 'Dates must be YYYY-MM-DD'
  if (start < today) return 'Start date is in the past'
  if (end < start) return 'End date is before the start date'
  if (start > addDays(today, 365)) return 'Bookings open up to a year ahead'
  const days = daysInclusive(start, end)
  if (days > maxDays) return `Campaigns can run at most ${maxDays} days`
  return null
}

export interface PricedScreen {
  id: number
  daily_rate_cents: number
}

export function quote(screens: PricedScreen[], start: string, end: string) {
  const days = daysInclusive(start, end)
  const perDay = screens.reduce((sum, s) => sum + s.daily_rate_cents, 0)
  return { days, perDayCents: perDay, totalCents: perDay * days }
}

/**
 * Peak number of campaigns booked on one screen on any single day of
 * [start, end]. Capacity is per day, so two campaigns that never overlap each
 * other only count once even if both overlap the requested range.
 */
export function peakOverlap(
  booked: { start_date: string; end_date: string }[],
  start: string,
  end: string,
): number {
  const events: [string, number][] = []
  for (const b of booked) {
    const s = b.start_date > start ? b.start_date : start
    const e = b.end_date < end ? b.end_date : end
    if (s > e) continue
    events.push([s, 1], [addDays(e, 1), -1])
  }
  events.sort((x, y) => (x[0] === y[0] ? x[1] - y[1] : x[0] < y[0] ? -1 : 1))
  let cur = 0
  let peak = 0
  for (const [, delta] of events) {
    cur += delta
    peak = Math.max(peak, cur)
  }
  return peak
}

/** Statuses that hold a slot in a screen's loop. */
export const HOLDING_STATUSES = ['awaiting_payment', 'in_review', 'approved'] as const
