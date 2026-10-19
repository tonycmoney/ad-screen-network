import pg from 'pg'

export interface Queryable {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>
}

export interface Db extends Queryable {
  /** Run `fn` inside one transaction; rolls back if it throws. */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>
  close(): Promise<void>
}

// DATE columns stay as 'YYYY-MM-DD' strings. Converting them to JS Dates
// shifts them across midnight in any timezone west of UTC.
pg.types.setTypeParser(1082, (v) => v)

export function postgresDb(url: string): Db {
  const pool = new pg.Pool({
    connectionString: url,
    max: 10,
    ssl: /sslmode=require/.test(url) ? { rejectUnauthorized: false } : undefined,
  })
  return {
    query: (text, params) => pool.query(text, params as unknown[]) as never,
    async tx(fn) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const out = await fn({ query: (t, p) => client.query(t, p as unknown[]) as never })
        await client.query('COMMIT')
        return out
      } catch (err) {
        await client.query('ROLLBACK')
        throw err
      } finally {
        client.release()
      }
    },
    close: () => pool.end(),
  }
}

/** In process Postgres (WASM) for tests and local runs without a server. */
export async function pgliteDb(dataDir?: string): Promise<Db> {
  const { PGlite, types } = await import('@electric-sql/pglite')
  const lite = new PGlite(dataDir, { parsers: { [types.DATE]: (v: string) => v } })
  const wrap = (q: Pick<typeof lite, 'query'>): Queryable => ({
    query: async (text, params) => {
      const res = await q.query(text, params as unknown[])
      return { rows: res.rows as never }
    },
  })
  return {
    ...wrap(lite),
    tx: (fn) => lite.transaction((t) => fn(wrap(t))),
    close: () => lite.close(),
  }
}

export async function openDb(url: string | undefined): Promise<Db> {
  if (url && /^postgres(ql)?:\/\//.test(url)) return postgresDb(url)
  return pgliteDb(url?.replace(/^pglite:\/\//, '') || undefined)
}
