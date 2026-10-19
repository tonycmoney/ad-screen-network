import { describe, expect, it } from 'vitest'
import { addDays, checkDates, daysInclusive, isIsoDate, localDate, peakOverlap, quote } from '../src/booking.js'
import { AttemptLimiter, passwordMatches } from '../src/auth.js'
import { loadConfig } from '../src/config.js'
import { sniffImage } from '../src/images.js'
import { JPEG, PNG } from './helpers.js'

describe('dates', () => {
  it('uses the network timezone for today', () => {
    // 01:30 UTC on the 15th is still the 14th in New York.
    expect(localDate(new Date('2026-10-15T01:30:00Z'), 'America/New_York')).toBe('2026-10-14')
    expect(localDate(new Date('2026-10-15T01:30:00Z'), 'UTC')).toBe('2026-10-15')
  })

  it('validates calendar dates', () => {
    expect(isIsoDate('2026-02-28')).toBe(true)
    expect(isIsoDate('2026-02-30')).toBe(false)
    expect(isIsoDate('10/14/2026')).toBe(false)
  })

  it('counts days inclusively across DST changes', () => {
    expect(daysInclusive('2026-10-14', '2026-10-14')).toBe(1)
    expect(daysInclusive('2026-10-30', '2026-11-02')).toBe(4)
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
  })

  it('rejects bad ranges with a reason', () => {
    const base = { today: '2026-10-14', maxDays: 30 }
    expect(checkDates({ ...base, start: '2026-10-13', end: '2026-10-20' })).toMatch(/past/)
    expect(checkDates({ ...base, start: '2026-10-20', end: '2026-10-19' })).toMatch(/before/)
    expect(checkDates({ ...base, start: '2026-10-14', end: '2026-11-20' })).toMatch(/30 days/)
    expect(checkDates({ ...base, start: '2028-01-01', end: '2028-01-02' })).toMatch(/year/)
    expect(checkDates({ ...base, start: '2026-10-14', end: '2026-10-14' })).toBeNull()
  })
})

describe('pricing and capacity', () => {
  it('prices screens times days', () => {
    const q = quote(
      [
        { id: 1, daily_rate_cents: 1200 },
        { id: 2, daily_rate_cents: 900 },
      ],
      '2026-10-14',
      '2026-10-20',
    )
    expect(q).toEqual({ days: 7, perDayCents: 2100, totalCents: 14700 })
  })

  it('measures the busiest single day, not every overlapping booking', () => {
    const booked = [
      { start_date: '2026-10-01', end_date: '2026-10-10' },
      { start_date: '2026-10-11', end_date: '2026-10-20' },
      { start_date: '2026-10-09', end_date: '2026-10-12' },
    ]
    // Two bookings overlap on the 9th and 10th, and again on the 11th and 12th.
    expect(peakOverlap(booked, '2026-10-01', '2026-10-31')).toBe(2)
    expect(peakOverlap(booked, '2026-10-13', '2026-10-31')).toBe(1)
    expect(peakOverlap(booked, '2026-11-01', '2026-11-05')).toBe(0)
  })

  it('back to back bookings do not overlap', () => {
    const booked = [
      { start_date: '2026-10-01', end_date: '2026-10-10' },
      { start_date: '2026-10-11', end_date: '2026-10-20' },
    ]
    expect(peakOverlap(booked, '2026-10-01', '2026-10-20')).toBe(1)
  })
})

describe('images', () => {
  it('detects the real type from the bytes', () => {
    expect(sniffImage(PNG)).toBe('image/png')
    expect(sniffImage(JPEG)).toBe('image/jpeg')
    expect(sniffImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp')
    expect(sniffImage(Buffer.from('<svg onload=alert(1)>'))).toBeNull()
    expect(sniffImage(Buffer.from('<html><script>'))).toBeNull()
  })
})

describe('config and auth helpers', () => {
  it('stays closed until keys and a strong password are set', () => {
    const c = loadConfig({})
    expect(c.paymentsEnabled).toBe(false)
    expect(c.adminEnabled).toBe(false)
    expect(loadConfig({ ADMIN_PASSWORD: 'short' }).adminEnabled).toBe(false)
    const live = loadConfig({ STRIPE_SECRET_KEY: 'sk_live_x', STRIPE_WEBHOOK_SECRET: 'whsec_x' })
    expect(live.paymentsEnabled && !live.testMode).toBe(true)
  })

  it('compares passwords exactly', () => {
    expect(passwordMatches('abc', 'abc')).toBe(true)
    expect(passwordMatches('abc ', 'abc')).toBe(false)
  })

  it('limits attempts per window', () => {
    const l = new AttemptLimiter(2, 1000)
    expect([l.allow('ip', 0), l.allow('ip', 1), l.allow('ip', 2)]).toEqual([true, true, false])
    expect(l.allow('other', 2)).toBe(true)
    expect(l.allow('ip', 1001)).toBe(true)
  })
})
