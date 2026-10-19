import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { migrate } from '../src/migrations.js'
import { seedScreens } from '../src/seed.js'
import { addScreen, JPEG, login, makeApp, multipart, NOW, PNG, TODAY } from './helpers.js'

type Ctx = Awaited<ReturnType<typeof makeApp>>

function bookingForm(screenIds: number[], over: Record<string, string> = {}, file = PNG) {
  return multipart(
    {
      business_name: 'Sal’s Pizza',
      email: 'sal@example.com',
      screen_ids: screenIds.join(','),
      start: TODAY,
      end: '2026-10-20',
      ...over,
    },
    { name: 'creative', data: file },
  )
}

async function book(ctx: Ctx, screenIds: number[], over: Record<string, string> = {}, file = PNG) {
  return ctx.app.inject({ method: 'POST', url: '/api/campaigns', ...bookingForm(screenIds, over, file) })
}

async function webhook(ctx: Ctx, event: object, signature = 'valid') {
  return ctx.app.inject({
    method: 'POST',
    url: '/api/stripe/webhook',
    headers: { 'content-type': 'application/json', 'stripe-signature': signature },
    payload: JSON.stringify(event),
  })
}

async function campaignId(ctx: Ctx, token: string) {
  const { rows } = await ctx.db.query<{ id: number }>('SELECT id FROM campaigns WHERE public_token = $1', [token])
  return rows[0]!.id
}

async function paidCampaign(ctx: Ctx, screenIds: number[], over: Record<string, string> = {}) {
  const res = await book(ctx, screenIds, over)
  expect(res.statusCode).toBe(201)
  const token = res.json().token as string
  const id = await campaignId(ctx, token)
  await webhook(ctx, {
    id: `evt_${randomUUID()}`,
    kind: 'paid',
    sessionId: `cs_test_${id}`,
    campaignId: id,
    paymentIntent: `pi_${id}`,
    amountCents: res.json().amount_cents,
  })
  return { id, token }
}

describe('booking and payment', () => {
  it('quotes, holds the slot and sends the buyer to Stripe', async () => {
    const ctx = await makeApp()
    const a = await addScreen(ctx.db, 'Barber', 1200)
    const b = await addScreen(ctx.db, 'Cafe', 900)
    const res = await book(ctx, [a.id, b.id])
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.amount_cents).toBe((1200 + 900) * 7)
    expect(body.checkout_url).toBe(`https://checkout.stripe.test/cs_test_${await campaignId(ctx, body.token)}`)
    const checkout = ctx.payments.checkouts[0]!
    expect(checkout.description).toContain('2 screens, 7 days')
    expect(checkout.successUrl).toMatch(new RegExp(`/campaign/${body.token}\\?paid=1$`))

    const status = await ctx.app.inject(`/api/campaigns/${body.token}`)
    expect(status.json()).toMatchObject({ status: 'awaiting_payment', business_name: 'Sal’s Pizza' })
    expect(status.json().screens.map((s: { name: string }) => s.name)).toEqual(['Barber', 'Cafe'])
  })

  it('marks the campaign paid once, even if Stripe retries the webhook', async () => {
    const ctx = await makeApp()
    const s = await addScreen(ctx.db, 'Barber')
    const res = await book(ctx, [s.id])
    const id = await campaignId(ctx, res.json().token)
    const event = { id: 'evt_1', kind: 'paid', sessionId: `cs_test_${id}`, campaignId: id, paymentIntent: 'pi_1', amountCents: 7000 }
    expect((await webhook(ctx, event)).json().result).toBe('paid')
    expect((await webhook(ctx, event)).json().result).toBe('duplicate')
    const c = await ctx.app.inject(`/api/campaigns/${res.json().token}`)
    expect(c.json().status).toBe('in_review')
    expect(c.json().paid_at).toBeTruthy()
  })

  it('ignores a webhook for the wrong session and rejects bad signatures', async () => {
    const ctx = await makeApp()
    const s = await addScreen(ctx.db, 'Barber')
    const res = await book(ctx, [s.id])
    const id = await campaignId(ctx, res.json().token)
    const forged = { id: 'evt_x', kind: 'paid', sessionId: 'cs_someone_else', campaignId: id, paymentIntent: 'pi', amountCents: 1 }
    expect((await webhook(ctx, forged)).json().result).toBe('no_change')
    expect((await webhook(ctx, { ...forged, id: 'evt_y' }, 'nope')).statusCode).toBe(400)
  })

  it('releases the slot when checkout expires', async () => {
    const ctx = await makeApp()
    const s = await addScreen(ctx.db, 'Barber')
    await book(ctx, [s.id])
    const second = await book(ctx, [s.id])
    expect((await book(ctx, [s.id])).statusCode).toBe(409) // capacity 2 in tests
    const id = await campaignId(ctx, second.json().token)
    await webhook(ctx, { id: 'evt_e', kind: 'expired', sessionId: `cs_test_${id}`, campaignId: id })
    expect((await book(ctx, [s.id])).statusCode).toBe(201)
  })

  it('stale unpaid holds stop counting after the hold window', async () => {
    const ctx = await makeApp()
    const s = await addScreen(ctx.db, 'Barber')
    await book(ctx, [s.id])
    await book(ctx, [s.id])
    await ctx.db.query(`UPDATE campaigns SET created_at = now() - interval '2 hours'`)
    expect((await book(ctx, [s.id])).statusCode).toBe(201)
  })

  it('reports remaining capacity per screen for a date range', async () => {
    const ctx = await makeApp()
    const a = await addScreen(ctx.db, 'Barber')
    const b = await addScreen(ctx.db, 'Cafe')
    await book(ctx, [a.id], { start: '2026-10-15', end: '2026-10-16' })
    const res = await ctx.app.inject(`/api/availability?start=${TODAY}&end=2026-10-20`)
    expect(res.json()).toEqual(
      expect.arrayContaining([
        { screen_id: a.id, remaining: 1 },
        { screen_id: b.id, remaining: 2 },
      ]),
    )
    const after = await ctx.app.inject(`/api/availability?start=2026-10-17&end=2026-10-20`)
    expect(after.json().find((r: { screen_id: number }) => r.screen_id === a.id).remaining).toBe(2)
    expect((await ctx.app.inject('/api/availability?start=2020-01-01&end=2020-01-02')).statusCode).toBe(400)
  })

  it('validates the booking form', async () => {
    const ctx = await makeApp()
    const s = await addScreen(ctx.db, 'Barber')
    const off = await addScreen(ctx.db, 'Retired', 1000, false)
    expect((await book(ctx, [s.id], { start: '2026-10-01' })).json().error).toMatch(/past/)
    expect((await book(ctx, [s.id], { email: 'nope' })).json().error).toMatch(/email/)
    expect((await book(ctx, [off.id])).json().error).toMatch(/unavailable/)
    expect((await book(ctx, [s.id], {}, Buffer.from('<svg/>'))).statusCode).toBe(415)
    const noFile = multipart({ business_name: 'X Co', email: 'a@b.co', screen_ids: String(s.id), start: TODAY, end: TODAY })
    expect((await ctx.app.inject({ method: 'POST', url: '/api/campaigns', ...noFile })).statusCode).toBe(400)
  })

  it('rejects oversized images', async () => {
    const ctx = await makeApp({ env: { MAX_CREATIVE_BYTES: '100' } })
    const s = await addScreen(ctx.db, 'Barber')
    const big = Buffer.concat([PNG, Buffer.alloc(200)])
    expect((await book(ctx, [s.id], {}, big)).statusCode).toBe(413)
  })

  it('frees the hold if Stripe checkout cannot be created', async () => {
    const ctx = await makeApp()
    const s = await addScreen(ctx.db, 'Barber')
    ctx.payments.failCheckout = true
    expect((await book(ctx, [s.id])).statusCode).toBe(502)
    const { rows } = await ctx.db.query<{ status: string }>('SELECT status FROM campaigns')
    expect(rows[0]!.status).toBe('expired')
  })

  it('refuses bookings when payments are not configured', async () => {
    const ctx = await makeApp({ payments: null, env: { STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '' } })
    const s = await addScreen(ctx.db, 'Barber')
    expect((await book(ctx, [s.id])).statusCode).toBe(503)
    expect((await webhook(ctx, {})).statusCode).toBe(503)
    expect((await ctx.app.inject('/api/config')).json()).toMatchObject({ payments_enabled: false })
  })

  it('serves creatives with their sniffed type and a locked down CSP', async () => {
    const ctx = await makeApp()
    const s = await addScreen(ctx.db, 'Barber')
    const res = await book(ctx, [s.id], {}, JPEG)
    const status = await ctx.app.inject(`/api/campaigns/${res.json().token}`)
    const img = await ctx.app.inject(status.json().creative_url)
    expect(img.headers['content-type']).toBe('image/jpeg')
    expect(img.headers['content-security-policy']).toBe("default-src 'none'")
    expect(img.rawPayload.equals(JPEG)).toBe(true)
    expect((await ctx.app.inject('/api/creatives/not-a-uuid')).statusCode).toBe(404)
  })
})

describe('owner review', () => {
  it('requires sign in and rate limits password guesses', async () => {
    const ctx = await makeApp()
    expect((await ctx.app.inject('/api/admin/overview')).statusCode).toBe(401)
    const wrong = () => ctx.app.inject({ method: 'POST', url: '/api/admin/login', payload: { password: 'guess' } })
    const codes = []
    for (let i = 0; i < 6; i++) codes.push((await wrong()).statusCode)
    expect(codes).toEqual([401, 401, 401, 401, 401, 429])
  })

  it('issues an http only session cookie and signs out', async () => {
    const ctx = await makeApp()
    const res = await ctx.app.inject({ method: 'POST', url: '/api/admin/login', payload: { password: 'correct horse battery' } })
    const cookie = res.cookies[0]!
    expect(cookie).toMatchObject({ name: 'asn_admin', httpOnly: true, sameSite: 'Strict', path: '/api' })
    const headers = { cookie: `asn_admin=${cookie.value}` }
    expect((await ctx.app.inject({ url: '/api/admin/me', headers })).json().signed_in).toBe(true)
    await ctx.app.inject({ method: 'POST', url: '/api/admin/logout', headers })
    expect((await ctx.app.inject({ url: '/api/admin/overview', headers })).statusCode).toBe(401)
  })

  it('stays locked when no admin password is set', async () => {
    const ctx = await makeApp({ env: { ADMIN_PASSWORD: '' } })
    const res = await ctx.app.inject({ method: 'POST', url: '/api/admin/login', payload: { password: '' } })
    expect(res.statusCode).toBe(503)
  })

  it('approves paid campaigns into the screen playlist', async () => {
    const ctx = await makeApp()
    const s = await addScreen(ctx.db, 'Barber')
    const headers = await login(ctx.app)
    const { id } = await paidCampaign(ctx, [s.id])

    const queue = await ctx.app.inject({ url: '/api/admin/campaigns?status=in_review', headers })
    expect(queue.json()).toHaveLength(1)
    expect(queue.json()[0].screen_names).toEqual(['Barber'])

    expect((await ctx.app.inject({ url: `/api/player/${s.player_key}/playlist` })).json().items).toEqual([])
    const ok = await ctx.app.inject({ method: 'POST', url: `/api/admin/campaigns/${id}/approve`, headers })
    expect(ok.json().status).toBe('approved')
    const again = await ctx.app.inject({ method: 'POST', url: `/api/admin/campaigns/${id}/approve`, headers })
    expect(again.statusCode).toBe(409)

    const playlist = await ctx.app.inject({ url: `/api/player/${s.player_key}/playlist` })
    expect(playlist.json()).toMatchObject({ date: TODAY, screen: { name: 'Barber', slot_seconds: 10 } })
    expect(playlist.json().items[0]).toMatchObject({ campaign_id: id, business_name: 'Sal’s Pizza' })
  })

  it('rejecting a paid campaign refunds it in full', async () => {
    const ctx = await makeApp()
    const s = await addScreen(ctx.db, 'Barber')
    const headers = await login(ctx.app)
    const { id, token } = await paidCampaign(ctx, [s.id])
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/campaigns/${id}/reject`,
      headers,
      payload: { reason: 'Image is too small to read' },
    })
    expect(res.json()).toMatchObject({ status: 'rejected', refunded: true })
    expect(ctx.payments.refunds).toEqual([`pi_${id}`])
    const pub = await ctx.app.inject(`/api/campaigns/${token}`)
    expect(pub.json()).toMatchObject({ status: 'rejected', reject_reason: 'Image is too small to read' })
    // Rejected bookings free their slot and do not count as revenue.
    const overview = await ctx.app.inject({ url: '/api/admin/overview', headers })
    expect(overview.json().revenue_cents).toBe(0)
  })

  it('cannot approve unpaid campaigns', async () => {
    const ctx = await makeApp()
    const s = await addScreen(ctx.db, 'Barber')
    const headers = await login(ctx.app)
    const res = await book(ctx, [s.id])
    const id = await campaignId(ctx, res.json().token)
    expect((await ctx.app.inject({ method: 'POST', url: `/api/admin/campaigns/${id}/approve`, headers })).statusCode).toBe(409)
    const rej = await ctx.app.inject({ method: 'POST', url: `/api/admin/campaigns/${id}/reject`, headers, payload: { reason: 'nope' } })
    expect(rej.statusCode).toBe(409)
  })

  it('manages screens and rotates player keys', async () => {
    const ctx = await makeApp()
    const headers = await login(ctx.app)
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/screens',
      headers,
      payload: { name: 'Front window', venue: 'Fade Room', city: 'Hartford', daily_rate_cents: 1500 },
    })
    expect(created.statusCode).toBe(201)
    const screen = created.json()
    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/admin/screens/${screen.id}`,
      headers,
      payload: { daily_rate_cents: 1800, slot_seconds: 15 },
    })
    expect(patched.json()).toMatchObject({ daily_rate_cents: 1800, slot_seconds: 15 })
    const bad = await ctx.app.inject({ method: 'PATCH', url: `/api/admin/screens/${screen.id}`, headers, payload: { player_key: 'x' } })
    expect(bad.statusCode).toBe(400)

    await ctx.app.inject(`/api/player/${screen.player_key}/playlist`)
    const list = await ctx.app.inject({ url: '/api/admin/screens', headers })
    expect(list.json()[0]).toMatchObject({ online: true, live_campaigns: 0 })

    const rotated = await ctx.app.inject({ method: 'POST', url: `/api/admin/screens/${screen.id}/rotate-key`, headers })
    expect(rotated.json().player_key).not.toBe(screen.player_key)
    expect((await ctx.app.inject(`/api/player/${screen.player_key}/playlist`)).statusCode).toBe(404)
  })
})

describe('screen player', () => {
  it('records proof of play once per play id and only for its own campaigns', async () => {
    const ctx = await makeApp()
    const a = await addScreen(ctx.db, 'Barber')
    const b = await addScreen(ctx.db, 'Cafe')
    const headers = await login(ctx.app)
    const mine = await paidCampaign(ctx, [a.id])
    const theirs = await paidCampaign(ctx, [b.id])
    for (const c of [mine, theirs]) {
      await ctx.app.inject({ method: 'POST', url: `/api/admin/campaigns/${c.id}/approve`, headers })
    }
    const playId = randomUUID()
    const at = new Date(NOW.getTime() - 60_000).toISOString()
    const plays = [
      { id: playId, campaign_id: mine.id, played_at: at },
      { id: playId, campaign_id: mine.id, played_at: at }, // retried upload
      { id: randomUUID(), campaign_id: theirs.id, played_at: at }, // not on this screen
      { id: randomUUID(), campaign_id: mine.id, played_at: '2020-01-01T00:00:00Z' }, // too old
    ]
    const res = await ctx.app.inject({ method: 'POST', url: `/api/player/${a.player_key}/plays`, payload: { plays } })
    expect(res.json()).toEqual({ stored: 1, ignored: 3 })

    const report = await ctx.app.inject(`/api/campaigns/${mine.token}`)
    expect(report.json().plays).toEqual({ total: 1, rows: [{ screen_id: a.id, day: TODAY, plays: 1 }] })
    const overview = await ctx.app.inject({ url: '/api/admin/overview', headers })
    expect(overview.json()).toMatchObject({ plays_today: 1, live_campaigns: 2, screens_online: 1, screens_total: 2 })
  })

  it('does not play campaigns outside their dates', async () => {
    const ctx = await makeApp()
    const s = await addScreen(ctx.db, 'Barber')
    const headers = await login(ctx.app)
    const later = await paidCampaign(ctx, [s.id], { start: '2026-10-16', end: '2026-10-18' })
    await ctx.app.inject({ method: 'POST', url: `/api/admin/campaigns/${later.id}/approve`, headers })
    expect((await ctx.app.inject(`/api/player/${s.player_key}/playlist`)).json().items).toEqual([])
  })

  it('rejects unknown screens and malformed uploads', async () => {
    const ctx = await makeApp()
    const s = await addScreen(ctx.db, 'Barber')
    expect((await ctx.app.inject('/api/player/unknown-key-123/playlist')).statusCode).toBe(404)
    const bad = await ctx.app.inject({ method: 'POST', url: `/api/player/${s.player_key}/plays`, payload: { plays: [{ id: 'x' }] } })
    expect(bad.statusCode).toBe(400)
  })
})

describe('platform', () => {
  it('sets security headers and keeps API responses out of caches', async () => {
    const ctx = await makeApp()
    const res = await ctx.app.inject('/api/health')
    expect(res.headers).toMatchObject({
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'cache-control': 'no-store',
    })
  })

  it('migrations and seeding are idempotent', async () => {
    const ctx = await makeApp()
    expect(await migrate(ctx.db)).toBe(0)
    expect(await seedScreens(ctx.db)).toBe(6)
    expect(await seedScreens(ctx.db)).toBe(0)
    const screens = await ctx.app.inject('/api/screens')
    expect(screens.json()).toHaveLength(6)
    expect(screens.json()[0]).not.toHaveProperty('player_key')
  })
})
