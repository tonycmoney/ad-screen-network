import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NetworkConfig } from './lib/api'
import { addDays, ago, dateRange, daysInclusive, liveLabel, money, quoteCents } from './lib/format'
import { AdminPage } from './pages/AdminPage'
import { BookPage } from './pages/BookPage'
import { CampaignPage } from './pages/CampaignPage'

const CONFIG: NetworkConfig = {
  network_name: 'Main Street Screens',
  timezone: 'America/New_York',
  currency: 'usd',
  today: '2026-10-14',
  payments_enabled: true,
  test_mode: true,
  admin_enabled: true,
  max_campaign_days: 90,
  max_creative_bytes: 3 * 1024 * 1024,
}

type Handler = (url: string, init?: RequestInit) => unknown
let routes: Record<string, Handler>
let calls: { url: string; init?: RequestInit }[]

beforeEach(() => {
  calls = []
  routes = {}
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    const key = Object.keys(routes).find((k) => url.startsWith(k))
    if (!key) return new Response(JSON.stringify({ error: 'no route' }), { status: 404 })
    return new Response(JSON.stringify(routes[key]!(url, init)), { status: 200 })
  })
  window.history.replaceState(null, '', '/')
})

afterEach(() => vi.unstubAllGlobals())

describe('format', () => {
  it('formats money and dates', () => {
    expect(money(1200)).toBe('$12')
    expect(money(1250)).toBe('$12.50')
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01')
    expect(daysInclusive('2026-10-14', '2026-10-20')).toBe(7)
    expect(daysInclusive('2026-10-20', '2026-10-14')).toBe(0)
    expect(dateRange('2026-10-14', '2026-10-14')).toBe('Oct 14')
    expect(quoteCents([1200, 900], '2026-10-14', '2026-10-20')).toBe(14700)
  })

  it('labels approved campaigns by date', () => {
    expect(liveLabel('approved', '2026-10-15', '2026-10-20', '2026-10-14')).toBe('Scheduled')
    expect(liveLabel('approved', '2026-10-10', '2026-10-20', '2026-10-14')).toBe('Live')
    expect(liveLabel('approved', '2026-10-01', '2026-10-05', '2026-10-14')).toBe('Finished')
    expect(liveLabel('in_review', '2026-10-01', '2026-10-05', '2026-10-14')).toBe('In review')
    expect(ago(null)).toBe('never')
    expect(ago('2026-10-14T12:00:00Z', Date.parse('2026-10-14T12:05:00Z'))).toBe('5m ago')
  })
})

const SCREENS = [
  { id: 1, name: 'Front window', venue: 'Fade Room Barbers', address: '', city: 'Hartford', daily_rate_cents: 1200, online: true },
  { id: 2, name: 'Counter', venue: 'Park Street Coffee', address: '', city: 'Hartford', daily_rate_cents: 900, online: false },
  { id: 3, name: 'Lobby', venue: 'Iron City Gym', address: '', city: 'Bristol', daily_rate_cents: 1400, online: true },
]

describe('BookPage', () => {
  beforeEach(() => {
    routes['/api/screens'] = () => SCREENS
    routes['/api/availability'] = () => [
      { screen_id: 1, remaining: 3 },
      { screen_id: 2, remaining: 0 },
      { screen_id: 3, remaining: 8 },
    ]
    routes['/api/campaigns'] = () => ({ token: 't', checkout_url: 'https://checkout.stripe.com/x', amount_cents: 0 })
  })

  it('groups screens by city, shows capacity and prices the selection', async () => {
    const user = userEvent.setup()
    render(<BookPage config={CONFIG} />)
    expect(await screen.findByText('Fade Room Barbers')).toBeInTheDocument()
    expect(screen.getByText('Bristol')).toBeInTheDocument()
    expect(await screen.findByText('Fully booked')).toBeInTheDocument()
    expect(screen.getByText('3 slots left')).toBeInTheDocument()

    await user.click(screen.getByText('Fade Room Barbers'))
    await user.click(screen.getByText('Iron City Gym'))
    // Default range is tomorrow through a week out: 7 days at $26/day.
    expect(screen.getByText('$182')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /pay and submit/i })).toBeDisabled()
  })

  it('uploads the ad and hands off to Stripe Checkout', async () => {
    const user = userEvent.setup()
    const redirect = vi.fn()
    URL.createObjectURL = vi.fn(() => 'blob:preview')
    URL.revokeObjectURL = vi.fn()
    render(<BookPage config={CONFIG} redirect={redirect} />)
    await user.click(await screen.findByText('Fade Room Barbers'))
    await user.type(screen.getByLabelText('Business name'), 'Sal’s Pizza')
    await user.type(screen.getByLabelText(/email/i), 'sal@example.com')
    const file = new File([new Uint8Array([137, 80, 78, 71])], 'ad.png', { type: 'image/png' })
    await user.upload(document.querySelector('input[type=file]') as HTMLInputElement, file)
    await user.click(screen.getByRole('button', { name: /pay and submit/i }))

    await waitFor(() => expect(redirect).toHaveBeenCalledWith('https://checkout.stripe.com/x'))
    const post = calls.find((c) => c.url === '/api/campaigns')!
    const form = post.init!.body as FormData
    expect(form.get('screen_ids')).toBe('1')
    expect(form.get('start')).toBe('2026-10-15')
    expect(form.get('business_name')).toBe('Sal’s Pizza')
  })

  it('preselects the screen from a player QR code link', async () => {
    window.history.replaceState(null, '', '/?screen=3')
    render(<BookPage config={CONFIG} />)
    // Shown on its card and in the summary once preselected.
    expect(await screen.findAllByText('Iron City Gym')).toHaveLength(2)
    expect(screen.getByText('$98')).toBeInTheDocument()
  })

  it('explains when booking is not open yet', async () => {
    render(<BookPage config={{ ...CONFIG, payments_enabled: false }} />)
    expect(await screen.findByText('Online booking opens soon.')).toBeInTheDocument()
  })
})

const CAMPAIGN = {
  token: 'tok',
  business_name: 'Sal’s Pizza',
  status: 'rejected',
  start_date: '2026-10-15',
  end_date: '2026-10-21',
  amount_cents: 8400,
  currency: 'usd',
  creative_url: '/api/creatives/x',
  reject_reason: 'Text is too small to read',
  refunded: true,
  created_at: '',
  paid_at: '2026-10-14T12:00:00Z',
  reviewed_at: null,
  screens: [{ id: 1, name: 'Front window', venue: 'Fade Room Barbers', city: 'Hartford' }],
  plays: { total: 0, rows: [] },
}

describe('CampaignPage', () => {
  it('tells the advertiser why it was rejected and that they were refunded', async () => {
    routes['/api/campaigns/tok'] = () => CAMPAIGN
    render(<CampaignPage config={CONFIG} token="tok" />)
    expect(await screen.findByText(/Text is too small to read/)).toBeInTheDocument()
    expect(screen.getByText(/refunded in full/)).toBeInTheDocument()
  })

  it('shows proof of play per screen', async () => {
    routes['/api/campaigns/tok'] = () => ({
      ...CAMPAIGN,
      status: 'approved',
      start_date: '2026-10-10',
      plays: { total: 312, rows: [{ screen_id: 1, day: '2026-10-13', plays: 312 }] },
    })
    render(<CampaignPage config={CONFIG} token="tok" />)
    expect(await screen.findAllByText('Live')).toHaveLength(2) // status pill and step
    expect(screen.getAllByText('312')).toHaveLength(2)
  })
})

describe('AdminPage', () => {
  it('approves a paid campaign from the review queue', async () => {
    const user = userEvent.setup()
    routes['/api/admin/me'] = () => ({ signed_in: true })
    routes['/api/admin/overview'] = () => ({
      revenue_cents: 8400,
      revenue_month_cents: 8400,
      awaiting_review: 1,
      live_campaigns: 0,
      plays_today: 0,
      screens_total: 3,
      screens_online: 2,
      today: '2026-10-14',
    })
    routes['/api/admin/campaigns/7/approve'] = () => ({})
    routes['/api/admin/campaigns'] = () => [
      { ...CAMPAIGN, id: 7, status: 'in_review', contact_email: 'sal@example.com', screen_names: ['Front window'], plays: 0, refund_id: null },
    ]
    routes['/api/admin/screens'] = () => []
    render(<AdminPage config={CONFIG} />)
    expect(await screen.findByText('Review (1)')).toBeInTheDocument()
    expect(screen.getByText('2/3')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(calls.some((c) => c.url === '/api/admin/campaigns/7/approve')).toBe(true))
  })

  it('shows the sign in form when signed out', async () => {
    routes['/api/admin/me'] = () => ({ signed_in: false })
    render(<AdminPage config={CONFIG} />)
    expect(await screen.findByRole('heading', { name: 'Owner sign in' })).toBeInTheDocument()
  })
})
