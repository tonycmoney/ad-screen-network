import { randomUUID } from 'node:crypto'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { openDb, type Db } from '../src/db.js'
import { migrate } from '../src/migrations.js'
import type { CheckoutRequest, PaymentEvent, PaymentGateway } from '../src/payments.js'

export const PASSWORD = 'correct horse battery'

// 2026-10-14 at noon in New York
export const NOW = new Date('2026-10-14T16:00:00Z')
export const TODAY = '2026-10-14'

// Smallest valid PNG and JPEG headers are enough for type sniffing.
export const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 1),
])
export const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 2)])

export class FakeGateway implements PaymentGateway {
  checkouts: CheckoutRequest[] = []
  refunds: string[] = []
  failCheckout = false

  async createCheckout(req: CheckoutRequest) {
    if (this.failCheckout) throw new Error('stripe is down')
    this.checkouts.push(req)
    const sessionId = `cs_test_${req.campaignId}`
    return { sessionId, url: `https://checkout.stripe.test/${sessionId}` }
  }

  parseWebhook(raw: Buffer, signature: string | undefined): PaymentEvent {
    if (signature !== 'valid') throw new Error('bad signature')
    return JSON.parse(raw.toString()) as PaymentEvent
  }

  async refund(paymentIntent: string) {
    this.refunds.push(paymentIntent)
    return `re_${paymentIntent}`
  }
}

let shared: Db | null = null

/** One database per test file: PGlite by default, real Postgres when TEST_DATABASE_URL is set. */
export async function freshDb(): Promise<Db> {
  if (process.env.TEST_DATABASE_URL) {
    shared ??= await openDb(process.env.TEST_DATABASE_URL)
    await shared.query('DROP SCHEMA public CASCADE')
    await shared.query('CREATE SCHEMA public')
    await migrate(shared)
    return { ...shared, close: async () => {} }
  }
  const db = await openDb(undefined)
  await migrate(db)
  return db
}

export async function makeApp(
  opts: { env?: Record<string, string>; payments?: PaymentGateway | null; now?: () => Date; staticDir?: string } = {},
) {
  const db = await freshDb()
  const config = loadConfig({
    NODE_ENV: 'test',
    ADMIN_PASSWORD: PASSWORD,
    STRIPE_SECRET_KEY: 'sk_test_x',
    STRIPE_WEBHOOK_SECRET: 'whsec_x',
    MAX_CAMPAIGNS_PER_SCREEN: '2',
    ...opts.env,
  })
  const payments = opts.payments === undefined ? new FakeGateway() : opts.payments
  const app = buildApp({ config, db, payments, now: opts.now ?? (() => NOW), staticDir: opts.staticDir ?? '/nonexistent' })
  await app.ready()
  return { app, db, payments: payments as FakeGateway, config }
}

export async function addScreen(db: Db, name: string, rate = 1000, active = true) {
  const { rows } = await db.query<{ id: number; player_key: string }>(
    `INSERT INTO screens (name, venue, city, daily_rate_cents, player_key, active)
     VALUES ($1, $1 || ' venue', 'Hartford', $2, $3, $4) RETURNING id, player_key`,
    [name, rate, `key-${randomUUID()}`, active],
  )
  return rows[0]!
}

export function multipart(fields: Record<string, string>, file?: { name: string; data: Buffer }) {
  const boundary = '----asn' + randomUUID()
  const parts: Buffer[] = []
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`))
  }
  if (file) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="ad.png"\r\n` +
          `Content-Type: image/png\r\n\r\n`,
      ),
      file.data,
      Buffer.from('\r\n'),
    )
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`))
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } }
}

export async function login(app: Awaited<ReturnType<typeof makeApp>>['app']) {
  const res = await app.inject({ method: 'POST', url: '/api/admin/login', payload: { password: PASSWORD } })
  const cookie = res.cookies.find((c) => c.name === 'asn_admin')
  if (!cookie) throw new Error(`login failed: ${res.body}`)
  return { cookie: `asn_admin=${cookie.value}` }
}
