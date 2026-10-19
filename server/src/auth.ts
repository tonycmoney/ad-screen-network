import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Queryable } from './db.js'

export const SESSION_COOKIE = 'asn_admin'
export const SESSION_HOURS = 12

export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString('base64url')
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function passwordMatches(given: string, expected: string): boolean {
  // Compare fixed length digests so the check takes the same time for any input.
  const a = createHash('sha256').update(given).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

export async function createSession(db: Queryable): Promise<string> {
  const token = randomToken(32)
  await db.query(
    `INSERT INTO admin_sessions (token_hash, expires_at)
     VALUES ($1, now() + make_interval(hours => $2))`,
    [hashToken(token), SESSION_HOURS],
  )
  await db.query('DELETE FROM admin_sessions WHERE expires_at < now()')
  return token
}

export async function sessionValid(db: Queryable, token: string | undefined): Promise<boolean> {
  if (!token) return false
  const { rows } = await db.query(
    'SELECT 1 FROM admin_sessions WHERE token_hash = $1 AND expires_at > now()',
    [hashToken(token)],
  )
  return rows.length > 0
}

export async function endSession(db: Queryable, token: string | undefined) {
  if (token) await db.query('DELETE FROM admin_sessions WHERE token_hash = $1', [hashToken(token)])
}

/** Fixed window limiter for login attempts, keyed by client IP. */
export class AttemptLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>()

  constructor(
    private max = 5,
    private windowMs = 60_000,
  ) {}

  allow(key: string, now = Date.now()): boolean {
    const h = this.hits.get(key)
    if (!h || h.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs })
      if (this.hits.size > 10_000) this.prune(now)
      return true
    }
    h.count++
    return h.count <= this.max
  }

  private prune(now: number) {
    for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k)
  }
}

export function requireAdmin(db: Queryable) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!(await sessionValid(db, req.cookies[SESSION_COOKIE]))) {
      return reply.code(401).send({ error: 'Sign in required' })
    }
  }
}
