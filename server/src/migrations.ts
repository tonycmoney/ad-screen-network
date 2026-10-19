import type { Db } from './db.js'

/** Ordered, append only. Each runs once inside a transaction. */
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE screens (
    id              serial PRIMARY KEY,
    name            text NOT NULL,
    venue           text NOT NULL,
    address         text NOT NULL DEFAULT '',
    city            text NOT NULL,
    player_key      text NOT NULL UNIQUE,
    daily_rate_cents integer NOT NULL CHECK (daily_rate_cents > 0),
    slot_seconds    integer NOT NULL DEFAULT 10 CHECK (slot_seconds BETWEEN 5 AND 60),
    active          boolean NOT NULL DEFAULT true,
    last_seen_at    timestamptz,
    player_agent    text,
    created_at      timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE creatives (
    id            uuid PRIMARY KEY,
    content_type  text NOT NULL,
    bytes         bytea NOT NULL,
    sha256        text NOT NULL,
    size          integer NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE campaigns (
    id                serial PRIMARY KEY,
    public_token      text NOT NULL UNIQUE,
    business_name     text NOT NULL,
    contact_email     text NOT NULL,
    creative_id       uuid NOT NULL REFERENCES creatives(id),
    start_date        date NOT NULL,
    end_date          date NOT NULL,
    status            text NOT NULL CHECK (status IN
                        ('awaiting_payment','in_review','approved','rejected','expired')),
    amount_cents      integer NOT NULL,
    currency          text NOT NULL,
    stripe_session_id text UNIQUE,
    stripe_payment_intent text,
    refund_id         text,
    reject_reason     text,
    created_at        timestamptz NOT NULL DEFAULT now(),
    paid_at           timestamptz,
    reviewed_at       timestamptz,
    CHECK (end_date >= start_date)
  );
  CREATE INDEX campaigns_status_dates ON campaigns (status, start_date, end_date);

  CREATE TABLE campaign_screens (
    campaign_id integer NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    screen_id   integer NOT NULL REFERENCES screens(id),
    PRIMARY KEY (campaign_id, screen_id)
  );
  CREATE INDEX campaign_screens_screen ON campaign_screens (screen_id);

  CREATE TABLE plays (
    id          uuid PRIMARY KEY,
    screen_id   integer NOT NULL REFERENCES screens(id),
    campaign_id integer NOT NULL REFERENCES campaigns(id),
    played_at   timestamptz NOT NULL,
    received_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX plays_campaign ON plays (campaign_id, played_at);
  CREATE INDEX plays_played_at ON plays (played_at);

  CREATE TABLE admin_sessions (
    token_hash  text PRIMARY KEY,
    expires_at  timestamptz NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE stripe_events (
    id          text PRIMARY KEY,
    type        text NOT NULL,
    received_at timestamptz NOT NULL DEFAULT now()
  );
  `,
]

export async function migrate(db: Db): Promise<number> {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`)
  const { rows } = await db.query<{ v: number | null }>(
    'SELECT max(version)::int AS v FROM schema_migrations',
  )
  const current = rows[0]?.v ?? 0
  let applied = 0
  for (let i = current; i < MIGRATIONS.length; i++) {
    await db.tx(async (q) => {
      for (const stmt of splitStatements(MIGRATIONS[i]!)) await q.query(stmt)
      await q.query('INSERT INTO schema_migrations (version) VALUES ($1)', [i + 1])
    })
    applied++
  }
  return applied
}

function splitStatements(sql: string): string[] {
  return sql
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean)
}
