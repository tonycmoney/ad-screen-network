import { z } from 'zod'

const optional = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined))

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().int().default(8000),
  DATABASE_URL: optional,
  PUBLIC_URL: optional,

  NETWORK_NAME: z.string().default('Main Street Screens'),
  NETWORK_TIMEZONE: z.string().default('America/New_York'),
  CURRENCY: z.string().default('usd'),

  STRIPE_SECRET_KEY: optional,
  STRIPE_WEBHOOK_SECRET: optional,
  ADMIN_PASSWORD: optional,

  // How many advertisers can share one screen's loop on a given day.
  MAX_CAMPAIGNS_PER_SCREEN: z.coerce.number().int().min(1).default(8),
  MAX_CAMPAIGN_DAYS: z.coerce.number().int().min(1).default(90),
  MAX_CREATIVE_BYTES: z.coerce.number().int().default(3 * 1024 * 1024),
  CHECKOUT_HOLD_MINUTES: z.coerce.number().int().min(30).default(35),
  ONLINE_WINDOW_SECONDS: z.coerce.number().int().default(180),

  SEED_EXAMPLE_SCREENS: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
})

export type Config = z.infer<typeof schema> & {
  paymentsEnabled: boolean
  adminEnabled: boolean
  testMode: boolean
  secureCookies: boolean
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const c = schema.parse(env)
  return {
    ...c,
    paymentsEnabled: Boolean(c.STRIPE_SECRET_KEY && c.STRIPE_WEBHOOK_SECRET),
    adminEnabled: Boolean(c.ADMIN_PASSWORD && c.ADMIN_PASSWORD.length >= 10),
    testMode: !c.STRIPE_SECRET_KEY || c.STRIPE_SECRET_KEY.startsWith('sk_test_'),
    secureCookies: c.NODE_ENV === 'production',
  }
}
