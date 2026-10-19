import { randomToken } from './auth.js'
import type { Queryable } from './db.js'

/**
 * Starter screens for a new network. The owner edits rates, names and
 * addresses from the dashboard; nothing here is billed until an advertiser
 * books and pays.
 */
export const EXAMPLE_SCREENS = [
  { name: 'Barbershop front window', venue: 'Fade Room Barbers', city: 'Hartford', rate: 1200 },
  { name: 'Counter screen', venue: 'Park Street Coffee', city: 'Hartford', rate: 1500 },
  { name: 'Waiting area', venue: 'Quick Lube Auto Care', city: 'West Hartford', rate: 1000 },
  { name: 'Checkout lane', venue: 'Corner Market', city: 'New Britain', rate: 900 },
  { name: 'Lobby screen', venue: 'Iron City Gym', city: 'Bristol', rate: 1400 },
  { name: 'Dining room', venue: 'Taqueria Sol', city: 'Manchester', rate: 1100 },
]

export async function seedScreens(db: Queryable): Promise<number> {
  const { rows } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM screens')
  if ((rows[0]?.n ?? 0) > 0) return 0
  for (const s of EXAMPLE_SCREENS) {
    await db.query(
      `INSERT INTO screens (name, venue, city, daily_rate_cents, player_key) VALUES ($1, $2, $3, $4, $5)`,
      [s.name, s.venue, s.city, s.rate, randomToken(18)],
    )
  }
  return EXAMPLE_SCREENS.length
}
