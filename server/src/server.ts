import { buildApp } from './app.js'
import { loadConfig } from './config.js'
import { openDb } from './db.js'
import { migrate } from './migrations.js'
import { StripeGateway } from './payments.js'
import { seedScreens } from './seed.js'

const config = loadConfig()
const db = await openDb(config.DATABASE_URL)
const applied = await migrate(db)
if (config.SEED_EXAMPLE_SCREENS) await seedScreens(db)

const payments = config.paymentsEnabled
  ? new StripeGateway(config.STRIPE_SECRET_KEY!, config.STRIPE_WEBHOOK_SECRET!)
  : null

const app = buildApp({ config, db, payments, staticDir: process.env.STATIC_DIR })
app.log.info(
  { migrations: applied, payments: config.paymentsEnabled, admin: config.adminEnabled, testMode: config.testMode },
  'starting',
)

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, async () => {
    await app.close()
    await db.close()
    process.exit(0)
  })
}

await app.listen({ host: '0.0.0.0', port: config.PORT })
