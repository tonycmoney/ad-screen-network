// Local development: create the schema and starter screens.
import { loadConfig } from './config.js'
import { openDb } from './db.js'
import { migrate } from './migrations.js'
import { seedScreens } from './seed.js'

const db = await openDb(loadConfig().DATABASE_URL)
await migrate(db)
console.log(`seeded ${await seedScreens(db)} screens`)
await db.close()
