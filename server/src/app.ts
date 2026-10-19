import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import cookie from '@fastify/cookie'
import multipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import Fastify, { type FastifyInstance } from 'fastify'
import { z, ZodError } from 'zod'
import {
  AttemptLimiter,
  createSession,
  endSession,
  passwordMatches,
  randomToken,
  requireAdmin,
  SESSION_COOKIE,
  SESSION_HOURS,
  sessionValid,
} from './auth.js'
import type { Config } from './config.js'
import type { Db } from './db.js'
import type { PaymentGateway } from './payments.js'
import { HttpError, Network, type CampaignRow, type ScreenRow } from './service.js'

export interface AppDeps {
  config: Config
  db: Db
  payments: PaymentGateway | null
  now?: () => Date
  staticDir?: string
}

const id = z.coerce.number().int().positive()
const uuid = z.string().uuid()

export function buildApp({ config, db, payments, now, staticDir }: AppDeps): FastifyInstance {
  const app = Fastify({
    logger: config.NODE_ENV === 'test' ? false : { level: 'info' },
    trustProxy: true,
    bodyLimit: 256 * 1024,
  })
  const net = new Network(db, config, payments, now)
  const limiter = new AttemptLimiter()
  const admin = requireAdmin(db)

  app.register(cookie)
  app.register(multipart, {
    limits: { files: 1, fileSize: config.MAX_CREATIVE_BYTES + 1, fields: 20, fieldSize: 2048 },
  })

  app.addHook('onSend', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin')
    if (!req.url.startsWith('/play/')) reply.header('X-Frame-Options', 'DENY')
    if (req.url.startsWith('/api/') && !reply.hasHeader('Cache-Control')) {
      reply.header('Cache-Control', 'no-store')
    }
  })

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message })
    if (err instanceof ZodError) {
      const issue = err.issues[0]
      return reply.code(400).send({ error: `${issue?.path.join('.') || 'input'}: ${issue?.message}` })
    }
    const status = (err as { statusCode?: number }).statusCode
    if (status && status < 500) return reply.code(status).send({ error: (err as Error).message })
    app.log.error(err)
    return reply.code(500).send({ error: 'Something went wrong' })
  })

  const baseUrl = (req: { protocol: string; host: string }) =>
    config.PUBLIC_URL?.replace(/\/$/, '') ?? `${req.protocol}://${req.host}`

  // Public

  app.get('/api/health', async () => ({ status: 'ok' }))

  app.get('/api/config', async () => ({
    network_name: config.NETWORK_NAME,
    timezone: config.NETWORK_TIMEZONE,
    currency: config.CURRENCY,
    today: net.today(),
    payments_enabled: config.paymentsEnabled,
    test_mode: config.testMode,
    admin_enabled: config.adminEnabled,
    max_campaign_days: config.MAX_CAMPAIGN_DAYS,
    max_creative_bytes: config.MAX_CREATIVE_BYTES,
  }))

  app.get('/api/screens', async () =>
    (await net.activeScreens()).map((s) => ({
      id: s.id,
      name: s.name,
      venue: s.venue,
      address: s.address,
      city: s.city,
      daily_rate_cents: s.daily_rate_cents,
      online: net.isOnline(s),
    })),
  )

  app.get('/api/availability', async (req) => {
    const q = z.object({ start: z.string(), end: z.string() }).parse(req.query)
    return net.availability(q.start, q.end)
  })

  app.post('/api/campaigns', async (req, reply) => {
    if (!payments) throw new HttpError(503, 'Online booking is not available yet')
    if (!req.isMultipart()) throw new HttpError(415, 'Send the booking as multipart form data')
    const fields: Record<string, string> = {}
    let creative: Buffer | null = null
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        if (part.fieldname !== 'creative') throw new HttpError(400, 'Unexpected file field')
        creative = await part.toBuffer()
        if (part.file.truncated) throw new HttpError(413, 'Image is too large')
      } else {
        fields[part.fieldname] = String(part.value)
      }
    }
    if (!creative) throw new HttpError(400, 'Attach an image for the ad')
    const body = z
      .object({
        business_name: z.string().trim().min(2).max(80),
        email: z.string().trim().email().max(200),
        screen_ids: z
          .string()
          .transform((s) => s.split(',').map((x) => Number(x.trim())))
          .pipe(z.array(z.number().int().positive()).min(1).max(50)),
        start: z.string(),
        end: z.string(),
      })
      .parse(fields)
    const base = baseUrl(req)
    const result = await net.book(
      {
        businessName: body.business_name,
        email: body.email,
        screenIds: body.screen_ids,
        start: body.start,
        end: body.end,
        creative,
      },
      { success: (t) => `${base}/campaign/${t}?paid=1`, cancel: `${base}/?canceled=1` },
    )
    return reply.code(201).send({
      token: result.token,
      checkout_url: result.checkoutUrl,
      amount_cents: result.amountCents,
    })
  })

  app.get('/api/campaigns/:token', async (req) => {
    const { token } = z.object({ token: z.string().min(16).max(64) }).parse(req.params)
    const { rows } = await db.query<CampaignRow>('SELECT * FROM campaigns WHERE public_token = $1', [token])
    const c = rows[0]
    if (!c) throw new HttpError(404, 'Campaign not found')
    return {
      ...publicCampaign(c),
      screens: await net.campaignScreens(c.id),
      plays: await net.playReport(c.id),
    }
  })

  app.get('/api/creatives/:id', async (req, reply) => {
    const params = z.object({ id: uuid }).safeParse(req.params)
    if (!params.success) throw new HttpError(404, 'Not found')
    const { rows } = await db.query<{ content_type: string; bytes: Uint8Array; sha256: string }>(
      'SELECT content_type, bytes, sha256 FROM creatives WHERE id = $1',
      [params.data.id],
    )
    const c = rows[0]
    if (!c) throw new HttpError(404, 'Not found')
    return reply
      .header('Content-Type', c.content_type)
      .header('Cache-Control', 'public, max-age=31536000, immutable')
      .header('ETag', `"${c.sha256}"`)
      .header('Content-Security-Policy', "default-src 'none'")
      .send(Buffer.from(c.bytes))
  })

  // Player

  app.get('/api/player/:key/playlist', async (req) => {
    const { key } = z.object({ key: z.string().min(8).max(64) }).parse(req.params)
    return net.playlist(key, req.headers['user-agent'])
  })

  app.post('/api/player/:key/plays', async (req) => {
    const { key } = z.object({ key: z.string().min(8).max(64) }).parse(req.params)
    const body = z
      .object({
        plays: z
          .array(z.object({ id: uuid, campaign_id: z.number().int().positive(), played_at: z.string().max(40) }))
          .max(500),
      })
      .parse(req.body)
    return net.recordPlays(key, body.plays)
  })

  // Stripe webhook, with the raw body kept for signature verification.

  app.register(async (scope) => {
    scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) =>
      done(null, body),
    )
    scope.post('/api/stripe/webhook', async (req, reply) => {
      if (!payments) throw new HttpError(503, 'Payments are not configured')
      let event
      try {
        event = payments.parseWebhook(req.body as Buffer, req.headers['stripe-signature'] as string | undefined)
      } catch (e) {
        req.log.warn({ err: (e as Error).message }, 'rejected webhook')
        return reply.code(400).send({ error: 'Invalid signature' })
      }
      const result = await net.applyPaymentEvent(event)
      req.log.info({ event: event.id, result }, 'stripe webhook')
      return { received: true, result }
    })
  })

  // Admin

  app.post('/api/admin/login', async (req, reply) => {
    if (!config.adminEnabled) throw new HttpError(503, 'Admin sign in is not configured')
    if (!limiter.allow(req.ip)) throw new HttpError(429, 'Too many attempts. Try again in a minute.')
    const { password } = z.object({ password: z.string().max(200) }).parse(req.body)
    if (!passwordMatches(password, config.ADMIN_PASSWORD!)) throw new HttpError(401, 'Wrong password')
    const token = await createSession(db)
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: config.secureCookies,
      sameSite: 'strict',
      path: '/api',
      maxAge: SESSION_HOURS * 3600,
    })
    return { ok: true }
  })

  app.post('/api/admin/logout', async (req, reply) => {
    await endSession(db, req.cookies[SESSION_COOKIE])
    reply.clearCookie(SESSION_COOKIE, { path: '/api' })
    return { ok: true }
  })

  app.get('/api/admin/me', async (req) => ({
    signed_in: await sessionValid(db, req.cookies[SESSION_COOKIE]),
    admin_enabled: config.adminEnabled,
  }))

  app.get('/api/admin/overview', { preHandler: admin }, async () => net.overview())

  app.get('/api/admin/screens', { preHandler: admin }, async () => {
    const { rows } = await db.query<ScreenRow & { live_campaigns: number; plays_7d: number }>(
      `SELECT s.*,
          (SELECT count(*)::int FROM campaign_screens cs JOIN campaigns c ON c.id = cs.campaign_id
            WHERE cs.screen_id = s.id AND c.status = 'approved'
              AND c.start_date <= $1 AND c.end_date >= $1) AS live_campaigns,
          (SELECT count(*)::int FROM plays p WHERE p.screen_id = s.id
              AND p.played_at > now() - interval '7 days') AS plays_7d
         FROM screens s ORDER BY s.active DESC, s.city, s.venue`,
      [net.today()],
    )
    return rows.map((s) => ({ ...s, online: net.isOnline(s) }))
  })

  const screenInput = z.object({
    name: z.string().trim().min(2).max(60),
    venue: z.string().trim().min(2).max(80),
    address: z.string().trim().max(120).default(''),
    city: z.string().trim().min(2).max(60),
    daily_rate_cents: z.number().int().min(100).max(1_000_000),
    slot_seconds: z.number().int().min(5).max(60).default(10),
  })

  app.post('/api/admin/screens', { preHandler: admin }, async (req, reply) => {
    const s = screenInput.parse(req.body)
    const { rows } = await db.query(
      `INSERT INTO screens (name, venue, address, city, daily_rate_cents, slot_seconds, player_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [s.name, s.venue, s.address, s.city, s.daily_rate_cents, s.slot_seconds, randomToken(18)],
    )
    return reply.code(201).send(rows[0])
  })

  app.patch('/api/admin/screens/:id', { preHandler: admin }, async (req) => {
    const screenId = id.parse((req.params as { id: string }).id)
    const patch = screenInput.extend({ active: z.boolean() }).partial().strict().parse(req.body)
    const keys = Object.keys(patch) as (keyof typeof patch)[]
    if (!keys.length) throw new HttpError(400, 'Nothing to update')
    const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ')
    const { rows } = await db.query(`UPDATE screens SET ${sets} WHERE id = $1 RETURNING *`, [
      screenId,
      ...keys.map((k) => patch[k]),
    ])
    if (!rows[0]) throw new HttpError(404, 'Screen not found')
    return rows[0]
  })

  app.post('/api/admin/screens/:id/rotate-key', { preHandler: admin }, async (req) => {
    const screenId = id.parse((req.params as { id: string }).id)
    const { rows } = await db.query(
      'UPDATE screens SET player_key = $2, last_seen_at = NULL WHERE id = $1 RETURNING *',
      [screenId, randomToken(18)],
    )
    if (!rows[0]) throw new HttpError(404, 'Screen not found')
    return rows[0]
  })

  app.get('/api/admin/campaigns', { preHandler: admin }, async (req) => {
    const { status } = z
      .object({
        status: z.enum(['all', 'awaiting_payment', 'in_review', 'approved', 'rejected', 'expired']).default('all'),
      })
      .parse(req.query)
    const { rows } = await db.query<CampaignRow & { screen_names: string[]; plays: number }>(
      `SELECT c.*,
          array(SELECT s.name FROM campaign_screens cs JOIN screens s ON s.id = cs.screen_id
                 WHERE cs.campaign_id = c.id ORDER BY s.name) AS screen_names,
          (SELECT count(*)::int FROM plays p WHERE p.campaign_id = c.id) AS plays
         FROM campaigns c
        WHERE ($1 = 'all' AND c.status <> 'expired') OR c.status = $1
        ORDER BY CASE c.status WHEN 'in_review' THEN 0 ELSE 1 END, c.created_at DESC
        LIMIT 200`,
      [status],
    )
    return rows.map((c) => ({
      ...publicCampaign(c),
      id: c.id,
      contact_email: c.contact_email,
      screen_names: c.screen_names,
      plays: c.plays,
      refund_id: c.refund_id,
    }))
  })

  app.get('/api/admin/campaigns/:id', { preHandler: admin }, async (req) => {
    const c = await net.getCampaign(id.parse((req.params as { id: string }).id))
    return {
      ...publicCampaign(c),
      id: c.id,
      contact_email: c.contact_email,
      refund_id: c.refund_id,
      screens: await net.campaignScreens(c.id),
      plays: await net.playReport(c.id),
    }
  })

  app.post('/api/admin/campaigns/:id/approve', { preHandler: admin }, async (req) =>
    publicCampaign(await net.approve(id.parse((req.params as { id: string }).id))),
  )

  app.post('/api/admin/campaigns/:id/reject', { preHandler: admin }, async (req) => {
    const { reason } = z.object({ reason: z.string().trim().min(3).max(300) }).parse(req.body)
    return publicCampaign(await net.reject(id.parse((req.params as { id: string }).id), reason))
  })

  // Dashboard, booking pages and the screen player (single page app)

  const dir = staticDir ?? resolve(process.cwd(), 'public')
  if (existsSync(resolve(dir, 'index.html'))) {
    app.register(fastifyStatic, { root: dir, wildcard: false, index: false })
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.method !== 'GET') {
        return reply.code(404).send({ error: 'Not found' })
      }
      return reply.header('Cache-Control', 'no-cache').sendFile('index.html')
    })
  }

  return app
}

function publicCampaign(c: CampaignRow) {
  return {
    token: c.public_token,
    business_name: c.business_name,
    status: c.status,
    start_date: c.start_date,
    end_date: c.end_date,
    amount_cents: c.amount_cents,
    currency: c.currency,
    creative_url: `/api/creatives/${c.creative_id}`,
    reject_reason: c.reject_reason,
    refunded: Boolean(c.refund_id),
    created_at: c.created_at,
    paid_at: c.paid_at,
    reviewed_at: c.reviewed_at,
  }
}
