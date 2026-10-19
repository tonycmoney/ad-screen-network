/**
 * Fill a local PGlite database by running the real booking, payment, review
 * and proof of play code paths with an in memory payment gateway. Used to
 * render README screenshots without touching Stripe.
 *
 *   npx tsx scripts/simulate.ts ./pgdata path/to/ads
 *
 * The ads folder holds PNG files named after the businesses below.
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { addDays, localDate } from '../src/booking.js'
import { loadConfig } from '../src/config.js'
import { pgliteDb } from '../src/db.js'
import { migrate } from '../src/migrations.js'
import type { PaymentGateway } from '../src/payments.js'
import { seedScreens } from '../src/seed.js'
import { Network } from '../src/service.js'

const [dataDir = './pgdata', adsDir = './ads'] = process.argv.slice(2)
const config = loadConfig({ ...process.env, MAX_CAMPAIGNS_PER_SCREEN: '8' })
const db = await pgliteDb(dataDir)
await migrate(db)
await seedScreens(db)

const gateway: PaymentGateway = {
  createCheckout: async (r) => ({ sessionId: `cs_sim_${r.campaignId}`, url: 'about:blank' }),
  parseWebhook: () => {
    throw new Error('unused')
  },
  refund: async (pi) => `re_sim_${pi}`,
}
const net = new Network(db, config, gateway)
const today = localDate(new Date(), config.NETWORK_TIMEZONE)
const { rows: screens } = await db.query<{ id: number; venue: string; player_key: string }>(
  'SELECT id, venue, player_key FROM screens ORDER BY id',
)
const ids = (...venues: string[]) => screens.filter((s) => venues.includes(s.venue)).map((s) => s.id)

const plan = [
  { ad: 'pizza', name: "Sal's Pizza", screens: ids('Fade Room Barbers', 'Park Street Coffee', 'Iron City Gym'), days: 14, after: 'approve' },
  { ad: 'gym', name: 'Iron City Gym', screens: ids('Park Street Coffee', 'Quick Lube Auto Care', 'Corner Market'), days: 21, after: 'approve' },
  { ad: 'tacos', name: 'Taqueria Sol', screens: ids('Fade Room Barbers', 'Corner Market'), days: 7, after: 'approve' },
  { ad: 'dentist', name: 'Brightside Family Dental', screens: ids('Park Street Coffee', 'Iron City Gym', 'Taqueria Sol'), days: 30, after: 'review' },
  { ad: 'barber', name: 'Fade Room Barbers', screens: ids('Taqueria Sol', 'Quick Lube Auto Care'), days: 10, after: 'review' },
] as const

for (const [i, p] of plan.entries()) {
  const start = p.after === 'approve' ? addDays(today, -3 - i) : addDays(today, 1)
  // Book from "yesterday" so past start dates pass validation.
  const booking = await new Network(db, { ...config, NETWORK_TIMEZONE: 'Pacific/Kiritimati' }, gateway, () =>
    new Date(Date.parse(`${start}T12:00:00Z`) - 14 * 3600_000),
  ).book(
    {
      businessName: p.name,
      email: `owner@${p.ad}.example`,
      screenIds: [...p.screens],
      start,
      end: addDays(start, p.days - 1),
      creative: readFileSync(join(adsDir, `${p.ad}.png`)),
    },
    { success: () => 'about:blank', cancel: 'about:blank' },
  )
  const { rows } = await db.query<{ id: number }>('SELECT id FROM campaigns WHERE public_token = $1', [booking.token])
  const id = rows[0]!.id
  await net.applyPaymentEvent({
    id: `evt_sim_${id}`,
    kind: 'paid',
    sessionId: `cs_sim_${id}`,
    campaignId: id,
    paymentIntent: `pi_sim_${id}`,
    amountCents: booking.amountCents,
  })
  if (p.after === 'approve') await net.approve(id)
}

// Proof of play: each live screen shows its ads every slot over the last day.
const now = Date.now()
for (const s of screens) {
  const list = await net.playlist(s.player_key, 'simulate')
  const plays = []
  for (let t = now - 6 * 3600_000; t < now && list.items.length; t += 40_000) {
    const item = list.items[Math.floor(t / 40_000) % list.items.length]!
    plays.push({ id: randomUUID(), campaign_id: item.campaign_id, played_at: new Date(t).toISOString() })
  }
  for (let i = 0; i < plays.length; i += 500) await net.recordPlays(s.player_key, plays.slice(i, i + 500))
}
// Leave two screens looking offline.
await db.query(
  `UPDATE screens SET last_seen_at = now() - interval '3 hours' WHERE venue IN ('Corner Market', 'Taqueria Sol')`,
)
console.log(await net.overview())
await db.close()
