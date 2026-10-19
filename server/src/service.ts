import { randomUUID } from 'node:crypto'
import { checkDates, HOLDING_STATUSES, localDate, peakOverlap, quote } from './booking.js'
import { randomToken } from './auth.js'
import type { Config } from './config.js'
import type { Db, Queryable } from './db.js'
import { sha256, sniffImage } from './images.js'
import type { PaymentEvent, PaymentGateway } from './payments.js'

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

export interface ScreenRow {
  id: number
  name: string
  venue: string
  address: string
  city: string
  player_key: string
  daily_rate_cents: number
  slot_seconds: number
  active: boolean
  last_seen_at: Date | null
  player_agent: string | null
}

export interface CampaignRow {
  id: number
  public_token: string
  business_name: string
  contact_email: string
  creative_id: string
  start_date: string
  end_date: string
  status: string
  amount_cents: number
  currency: string
  stripe_session_id: string | null
  stripe_payment_intent: string | null
  refund_id: string | null
  reject_reason: string | null
  created_at: Date
  paid_at: Date | null
  reviewed_at: Date | null
}

export interface BookingInput {
  businessName: string
  email: string
  screenIds: number[]
  start: string
  end: string
  creative: Uint8Array
}

export class Network {
  constructor(
    private db: Db,
    private config: Config,
    private payments: PaymentGateway | null,
    private now: () => Date = () => new Date(),
  ) {}

  today(): string {
    return localDate(this.now(), this.config.NETWORK_TIMEZONE)
  }

  isOnline(s: Pick<ScreenRow, 'last_seen_at'>): boolean {
    if (!s.last_seen_at) return false
    return this.now().getTime() - new Date(s.last_seen_at).getTime() < this.config.ONLINE_WINDOW_SECONDS * 1000
  }

  // Screens and availability

  async activeScreens(): Promise<ScreenRow[]> {
    const { rows } = await this.db.query<ScreenRow>(
      'SELECT * FROM screens WHERE active ORDER BY city, venue, name',
    )
    return rows
  }

  /** Booked campaigns that currently hold a slot on any of the given screens. */
  private async holds(q: Queryable, screenIds: number[], start: string, end: string) {
    const { rows } = await q.query<{ screen_id: number; start_date: string; end_date: string }>(
      `SELECT cs.screen_id, c.start_date, c.end_date
         FROM campaign_screens cs JOIN campaigns c ON c.id = cs.campaign_id
        WHERE cs.screen_id = ANY($1::int[])
          AND c.start_date <= $3 AND c.end_date >= $2
          AND c.status = ANY($4::text[])
          AND (c.status <> 'awaiting_payment'
               OR c.created_at > now() - make_interval(mins => $5))`,
      [screenIds, start, end, [...HOLDING_STATUSES], this.config.CHECKOUT_HOLD_MINUTES],
    )
    const byScreen = new Map<number, { start_date: string; end_date: string }[]>()
    for (const r of rows) {
      const list = byScreen.get(r.screen_id) ?? []
      list.push(r)
      byScreen.set(r.screen_id, list)
    }
    return byScreen
  }

  async availability(start: string, end: string) {
    const err = checkDates({ start, end, today: this.today(), maxDays: this.config.MAX_CAMPAIGN_DAYS })
    if (err) throw new HttpError(400, err)
    const screens = await this.activeScreens()
    const holds = await this.holds(this.db, screens.map((s) => s.id), start, end)
    return screens.map((s) => {
      const used = peakOverlap(holds.get(s.id) ?? [], start, end)
      return { screen_id: s.id, remaining: Math.max(0, this.config.MAX_CAMPAIGNS_PER_SCREEN - used) }
    })
  }

  // Booking and payment

  async book(input: BookingInput, urls: { success: (token: string) => string; cancel: string }) {
    if (!this.payments) throw new HttpError(503, 'Online booking is not available yet')
    const err = checkDates({
      start: input.start,
      end: input.end,
      today: this.today(),
      maxDays: this.config.MAX_CAMPAIGN_DAYS,
    })
    if (err) throw new HttpError(400, err)
    if (input.creative.length > this.config.MAX_CREATIVE_BYTES) {
      throw new HttpError(413, `Image must be under ${Math.round(this.config.MAX_CREATIVE_BYTES / 1048576)} MB`)
    }
    const contentType = sniffImage(input.creative)
    if (!contentType) throw new HttpError(415, 'Upload a PNG, JPEG or WebP image')
    const screenIds = [...new Set(input.screenIds)].sort((a, b) => a - b)

    const campaign = await this.db.tx(async (q) => {
      // Lock the chosen screens so two buyers cannot both take the last slot.
      const { rows: screens } = await q.query<ScreenRow>(
        'SELECT * FROM screens WHERE id = ANY($1::int[]) AND active ORDER BY id FOR UPDATE',
        [screenIds],
      )
      if (screens.length !== screenIds.length) throw new HttpError(400, 'One or more screens are unavailable')
      const holds = await this.holds(q, screenIds, input.start, input.end)
      const full = screens.filter(
        (s) => peakOverlap(holds.get(s.id) ?? [], input.start, input.end) >= this.config.MAX_CAMPAIGNS_PER_SCREEN,
      )
      if (full.length) {
        throw new HttpError(409, `Fully booked on those dates: ${full.map((s) => s.name).join(', ')}`)
      }
      const price = quote(screens, input.start, input.end)
      const creativeId = randomUUID()
      await q.query(
        'INSERT INTO creatives (id, content_type, bytes, sha256, size) VALUES ($1, $2, $3, $4, $5)',
        [creativeId, contentType, input.creative, sha256(input.creative), input.creative.length],
      )
      const { rows } = await q.query<CampaignRow>(
        `INSERT INTO campaigns (public_token, business_name, contact_email, creative_id,
                                start_date, end_date, status, amount_cents, currency)
         VALUES ($1, $2, $3, $4, $5, $6, 'awaiting_payment', $7, $8) RETURNING *`,
        [
          randomToken(),
          input.businessName,
          input.email,
          creativeId,
          input.start,
          input.end,
          price.totalCents,
          this.config.CURRENCY,
        ],
      )
      const c = rows[0]!
      for (const id of screenIds) {
        await q.query('INSERT INTO campaign_screens (campaign_id, screen_id) VALUES ($1, $2)', [c.id, id])
      }
      return { ...c, screenCount: screens.length, days: price.days }
    })

    try {
      const checkout = await this.payments.createCheckout({
        campaignId: campaign.id,
        description: `${this.config.NETWORK_NAME}: ${campaign.screenCount} screen${
          campaign.screenCount === 1 ? '' : 's'
        }, ${campaign.days} day${campaign.days === 1 ? '' : 's'} (${input.start} to ${input.end})`,
        amountCents: campaign.amount_cents,
        currency: campaign.currency,
        email: input.email,
        successUrl: urls.success(campaign.public_token),
        cancelUrl: urls.cancel,
      })
      await this.db.query('UPDATE campaigns SET stripe_session_id = $1 WHERE id = $2', [
        checkout.sessionId,
        campaign.id,
      ])
      return { token: campaign.public_token, checkoutUrl: checkout.url, amountCents: campaign.amount_cents }
    } catch (e) {
      // Release the slot right away instead of waiting for the hold to lapse.
      await this.db.query(`UPDATE campaigns SET status = 'expired' WHERE id = $1`, [campaign.id])
      throw new HttpError(502, `Could not start checkout: ${(e as Error).message}`)
    }
  }

  /** Apply a verified payment webhook. Safe to call more than once per event. */
  async applyPaymentEvent(event: PaymentEvent): Promise<string> {
    if (event.kind === 'ignored') return 'ignored'
    return this.db.tx(async (q) => {
      const fresh = await q.query(
        'INSERT INTO stripe_events (id, type) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING RETURNING id',
        [event.id, event.kind],
      )
      if (!fresh.rows.length) return 'duplicate'
      if (event.kind === 'paid') {
        const { rows } = await q.query(
          `UPDATE campaigns
              SET status = 'in_review', paid_at = now(), stripe_payment_intent = $3
            WHERE id = $1 AND stripe_session_id = $2 AND status IN ('awaiting_payment', 'expired')
            RETURNING id`,
          [event.campaignId, event.sessionId, event.paymentIntent],
        )
        return rows.length ? 'paid' : 'no_change'
      }
      const { rows } = await q.query(
        `UPDATE campaigns SET status = 'expired'
          WHERE id = $1 AND stripe_session_id = $2 AND status = 'awaiting_payment' RETURNING id`,
        [event.campaignId, event.sessionId],
      )
      return rows.length ? 'expired' : 'no_change'
    })
  }

  // Review

  async getCampaign(id: number): Promise<CampaignRow> {
    const { rows } = await this.db.query<CampaignRow>('SELECT * FROM campaigns WHERE id = $1', [id])
    if (!rows[0]) throw new HttpError(404, 'Campaign not found')
    return rows[0]
  }

  async approve(id: number) {
    const { rows } = await this.db.query<CampaignRow>(
      `UPDATE campaigns SET status = 'approved', reviewed_at = now()
        WHERE id = $1 AND status = 'in_review' RETURNING *`,
      [id],
    )
    if (!rows[0]) throw new HttpError(409, 'Only paid campaigns waiting for review can be approved')
    return rows[0]
  }

  /** Reject a paid campaign and refund it in full. */
  async reject(id: number, reason: string) {
    const c = await this.getCampaign(id)
    if (c.status !== 'in_review' && c.status !== 'approved') {
      throw new HttpError(409, 'Only paid campaigns can be rejected')
    }
    let refundId = c.refund_id
    if (c.stripe_payment_intent && !refundId) {
      if (!this.payments) throw new HttpError(503, 'Payments are not configured, so no refund can be issued')
      refundId = await this.payments.refund(c.stripe_payment_intent)
    }
    const { rows } = await this.db.query<CampaignRow>(
      `UPDATE campaigns SET status = 'rejected', reject_reason = $2, refund_id = $3, reviewed_at = now()
        WHERE id = $1 RETURNING *`,
      [id, reason, refundId],
    )
    return rows[0]!
  }

  // Player

  async screenByKey(key: string): Promise<ScreenRow> {
    const { rows } = await this.db.query<ScreenRow>('SELECT * FROM screens WHERE player_key = $1', [key])
    if (!rows[0] || !rows[0].active) throw new HttpError(404, 'Unknown screen')
    return rows[0]
  }

  async playlist(key: string, userAgent: string | undefined) {
    const screen = await this.screenByKey(key)
    await this.db.query('UPDATE screens SET last_seen_at = now(), player_agent = $2 WHERE id = $1', [
      screen.id,
      (userAgent ?? '').slice(0, 200),
    ])
    const today = this.today()
    const { rows } = await this.db.query<{ id: number; business_name: string; creative_id: string; end_date: string }>(
      `SELECT c.id, c.business_name, c.creative_id, c.end_date
         FROM campaigns c JOIN campaign_screens cs ON cs.campaign_id = c.id
        WHERE cs.screen_id = $1 AND c.status = 'approved'
          AND c.start_date <= $2 AND c.end_date >= $2
        ORDER BY c.paid_at, c.id`,
      [screen.id, today],
    )
    return {
      screen: { id: screen.id, name: screen.name, venue: screen.venue, slot_seconds: screen.slot_seconds },
      date: today,
      items: rows.map((r) => ({
        campaign_id: r.id,
        business_name: r.business_name,
        creative_url: `/api/creatives/${r.creative_id}`,
      })),
    }
  }

  async recordPlays(key: string, plays: { id: string; campaign_id: number; played_at: string }[]) {
    const screen = await this.screenByKey(key)
    const { rows } = await this.db.query<{ id: number }>(
      `SELECT c.id FROM campaigns c JOIN campaign_screens cs ON cs.campaign_id = c.id
        WHERE cs.screen_id = $1 AND c.status = 'approved'`,
      [screen.id],
    )
    const allowed = new Set(rows.map((r) => r.id))
    const now = this.now().getTime()
    let stored = 0
    for (const p of plays) {
      const t = Date.parse(p.played_at)
      if (!allowed.has(p.campaign_id) || Number.isNaN(t)) continue
      if (t > now + 5 * 60_000 || t < now - 7 * 86_400_000) continue
      const res = await this.db.query(
        `INSERT INTO plays (id, screen_id, campaign_id, played_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO NOTHING RETURNING id`,
        [p.id, screen.id, p.campaign_id, new Date(t).toISOString()],
      )
      stored += res.rows.length
    }
    await this.db.query('UPDATE screens SET last_seen_at = now() WHERE id = $1', [screen.id])
    return { stored, ignored: plays.length - stored }
  }

  // Reporting

  async campaignScreens(campaignId: number) {
    const { rows } = await this.db.query<{ id: number; name: string; venue: string; city: string }>(
      `SELECT s.id, s.name, s.venue, s.city FROM campaign_screens cs JOIN screens s ON s.id = cs.screen_id
        WHERE cs.campaign_id = $1 ORDER BY s.name`,
      [campaignId],
    )
    return rows
  }

  async playReport(campaignId: number) {
    const { rows } = await this.db.query<{ screen_id: number; day: string; plays: number }>(
      `SELECT screen_id, to_char(played_at AT TIME ZONE $2, 'YYYY-MM-DD') AS day, count(*)::int AS plays
         FROM plays WHERE campaign_id = $1
        GROUP BY screen_id, day ORDER BY day, screen_id`,
      [campaignId, this.config.NETWORK_TIMEZONE],
    )
    return { total: rows.reduce((s, r) => s + r.plays, 0), rows }
  }

  async overview() {
    const today = this.today()
    const tz = this.config.NETWORK_TIMEZONE
    const month = today.slice(0, 7) + '-01'
    const { rows } = await this.db.query<Record<string, number>>(
      `SELECT
         (SELECT coalesce(sum(amount_cents), 0)::int FROM campaigns
           WHERE paid_at IS NOT NULL AND status <> 'rejected') AS revenue_cents,
         (SELECT coalesce(sum(amount_cents), 0)::int FROM campaigns
           WHERE paid_at IS NOT NULL AND status <> 'rejected'
             AND paid_at >= ($2::date)::timestamp AT TIME ZONE $3) AS revenue_month_cents,
         (SELECT count(*)::int FROM campaigns WHERE status = 'in_review') AS awaiting_review,
         (SELECT count(*)::int FROM campaigns WHERE status = 'approved'
             AND start_date <= $1 AND end_date >= $1) AS live_campaigns,
         (SELECT count(*)::int FROM plays
           WHERE played_at >= ($1::date)::timestamp AT TIME ZONE $3) AS plays_today`,
      [today, month, tz],
    )
    const screens = await this.db.query<ScreenRow>('SELECT * FROM screens')
    return {
      ...rows[0],
      screens_total: screens.rows.filter((s) => s.active).length,
      screens_online: screens.rows.filter((s) => s.active && this.isOnline(s)).length,
      today,
    }
  }
}
