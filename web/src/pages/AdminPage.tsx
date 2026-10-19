import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Shell, StatusPill } from '../components/Shell'
import {
  ApiError,
  json,
  request,
  type AdminCampaign,
  type AdminScreen,
  type NetworkConfig,
  type Overview,
} from '../lib/api'
import { ago, dateRange, liveLabel, money } from '../lib/format'

type Tab = 'review' | 'campaigns' | 'screens'

export function AdminPage({ config }: { config: NetworkConfig }) {
  const [signedIn, setSignedIn] = useState<boolean | null>(null)

  useEffect(() => {
    request<{ signed_in: boolean }>('/api/admin/me').then(
      (r) => setSignedIn(r.signed_in),
      () => setSignedIn(false),
    )
  }, [])

  const logout = async () => {
    await request('/api/admin/logout', { method: 'POST' })
    setSignedIn(false)
  }

  return (
    <Shell
      config={config}
      right={signedIn ? <button className="link" onClick={logout}>Sign out</button> : <a href="/">Booking page</a>}
    >
      {signedIn === null ? null : signedIn ? (
        <Dashboard config={config} onExpired={() => setSignedIn(false)} />
      ) : (
        <Login enabled={config.admin_enabled} onDone={() => setSignedIn(true)} />
      )}
    </Shell>
  )
}

function Login({ enabled, onDone }: { enabled: boolean; onDone: () => void }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    try {
      await request('/api/admin/login', json({ password }))
      onDone()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <form className="card narrow login" onSubmit={submit}>
      <h1>Owner sign in</h1>
      {!enabled && <p className="note">Set ADMIN_PASSWORD (10+ characters) on the server to enable the dashboard.</p>}
      <label>
        Password
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
      </label>
      {error && <p className="error" role="alert">{error}</p>}
      <button className="primary" disabled={!enabled}>Sign in</button>
    </form>
  )
}

function Dashboard({ config, onExpired }: { config: NetworkConfig; onExpired: () => void }) {
  const [tab, setTab] = useState<Tab>('review')
  const [overview, setOverview] = useState<Overview | null>(null)
  const [campaigns, setCampaigns] = useState<AdminCampaign[]>([])
  const [screens, setScreens] = useState<AdminScreen[]>([])
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [o, c, s] = await Promise.all([
        request<Overview>('/api/admin/overview'),
        request<AdminCampaign[]>('/api/admin/campaigns'),
        request<AdminScreen[]>('/api/admin/screens'),
      ])
      setOverview(o)
      setCampaigns(c)
      setScreens(s)
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onExpired()
      else setError((e as Error).message)
    }
  }, [onExpired])

  useEffect(() => {
    const run = async () => load()
    void run()
    const t = window.setInterval(() => void load(), 30_000)
    return () => window.clearInterval(t)
  }, [load])

  const act = async (fn: () => Promise<unknown>) => {
    setError(null)
    try {
      await fn()
      await load()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const queue = campaigns.filter((c) => c.status === 'in_review')

  return (
    <div className="dash">
      {overview && (
        <div className="kpis">
          <Kpi label="Revenue this month" value={money(overview.revenue_month_cents)} sub={`${money(overview.revenue_cents)} all time`} />
          <Kpi label="Live campaigns" value={String(overview.live_campaigns)} />
          <Kpi label="Waiting for review" value={String(overview.awaiting_review)} tone={overview.awaiting_review ? 'warn' : ''} />
          <Kpi label="Screens online" value={`${overview.screens_online}/${overview.screens_total}`} />
          <Kpi label="Plays today" value={overview.plays_today.toLocaleString()} />
        </div>
      )}

      <div className="tabs" role="tablist">
        {(['review', 'campaigns', 'screens'] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
            {t === 'review' ? `Review (${queue.length})` : t === 'campaigns' ? 'Campaigns' : `Screens (${screens.length})`}
          </button>
        ))}
      </div>
      {error && <p className="error" role="alert">{error}</p>}

      {tab === 'review' && <ReviewQueue items={queue} act={act} />}
      {tab === 'campaigns' && <CampaignTable items={campaigns} today={config.today} />}
      {tab === 'screens' && <Screens items={screens} act={act} />}
    </div>
  )
}

function Kpi({ label, value, sub, tone = '' }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className={`kpi ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      {sub && <small>{sub}</small>}
    </div>
  )
}

function ReviewQueue({ items, act }: { items: AdminCampaign[]; act: (fn: () => Promise<unknown>) => Promise<void> }) {
  const [rejecting, setRejecting] = useState<number | null>(null)
  const [reason, setReason] = useState('')

  if (!items.length) return <div className="card muted">Nothing to review. Paid bookings show up here.</div>

  return (
    <div className="review">
      {items.map((c) => (
        <article key={c.id} className="card review-item">
          <img src={c.creative_url} alt={`${c.business_name} ad`} />
          <div className="review-body">
            <h3>{c.business_name}</h3>
            <p className="muted">{c.contact_email}</p>
            <dl>
              <dt>Dates</dt>
              <dd>{dateRange(c.start_date, c.end_date)}</dd>
              <dt>Screens</dt>
              <dd>{c.screen_names.join(', ')}</dd>
              <dt>Paid</dt>
              <dd>{money(c.amount_cents, c.currency)}</dd>
            </dl>
            {rejecting === c.id ? (
              <div className="reject-box">
                <label>
                  Reason shown to the advertiser
                  <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
                </label>
                <div className="row">
                  <button
                    className="danger"
                    disabled={reason.trim().length < 3}
                    onClick={() =>
                      act(async () => {
                        await request(`/api/admin/campaigns/${c.id}/reject`, json({ reason }))
                        setRejecting(null)
                        setReason('')
                      })
                    }
                  >
                    Reject and refund
                  </button>
                  <button className="link" onClick={() => setRejecting(null)}>Cancel</button>
                </div>
              </div>
            ) : (
              <div className="row">
                <button className="primary" onClick={() => act(() => request(`/api/admin/campaigns/${c.id}/approve`, { method: 'POST' }))}>
                  Approve
                </button>
                <button className="ghost" onClick={() => setRejecting(c.id)}>Reject…</button>
              </div>
            )}
          </div>
        </article>
      ))}
    </div>
  )
}

function CampaignTable({ items, today }: { items: AdminCampaign[]; today: string }) {
  if (!items.length) return <div className="card muted">No campaigns yet.</div>
  return (
    <div className="card table-wrap">
      <table>
        <thead>
          <tr>
            <th>Advertiser</th>
            <th>Dates</th>
            <th>Screens</th>
            <th>Status</th>
            <th className="num">Paid</th>
            <th className="num">Plays</th>
          </tr>
        </thead>
        <tbody>
          {items.map((c) => (
            <tr key={c.id}>
              <td>
                <a href={`/campaign/${c.token}`}>{c.business_name}</a>
              </td>
              <td>{dateRange(c.start_date, c.end_date)}</td>
              <td>{c.screen_names.length}</td>
              <td>
                <StatusPill label={liveLabel(c.status, c.start_date, c.end_date, today)} />
                {c.refund_id && <span className="muted small"> refunded</span>}
              </td>
              <td className="num">{c.paid_at ? money(c.amount_cents, c.currency) : '—'}</td>
              <td className="num">{c.plays.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Screens({ items, act }: { items: AdminScreen[]; act: (fn: () => Promise<unknown>) => Promise<void> }) {
  const [form, setForm] = useState({ name: '', venue: '', city: '', rate: '12' })

  const add = (e: FormEvent) => {
    e.preventDefault()
    void act(async () => {
      await request(
        '/api/admin/screens',
        json({ name: form.name, venue: form.venue, city: form.city, daily_rate_cents: Math.round(Number(form.rate) * 100) }),
      )
      setForm({ name: '', venue: '', city: form.city, rate: form.rate })
    })
  }

  return (
    <>
      <div className="card table-wrap">
        <table>
          <thead>
            <tr>
              <th>Screen</th>
              <th>Status</th>
              <th className="num">Rate</th>
              <th className="num">Live ads</th>
              <th className="num">Plays 7d</th>
              <th>Player</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((s) => (
              <tr key={s.id} className={s.active ? '' : 'inactive'}>
                <td>
                  <b>{s.venue}</b>
                  <div className="muted small">
                    {s.name} · {s.city}
                  </div>
                </td>
                <td>
                  <span className={`dot ${s.online ? 'live' : ''}`} /> {s.active ? (s.online ? 'Online' : `Seen ${ago(s.last_seen_at)}`) : 'Inactive'}
                </td>
                <td className="num">{money(s.daily_rate_cents)}</td>
                <td className="num">{s.live_campaigns}</td>
                <td className="num">{s.plays_7d.toLocaleString()}</td>
                <td>
                  <a href={`/play/${s.player_key}`} target="_blank" rel="noreferrer">
                    Open player
                  </a>
                </td>
                <td className="actions">
                  <button
                    className="link"
                    onClick={() => act(() => request(`/api/admin/screens/${s.id}/rotate-key`, { method: 'POST' }))}
                    title="Issue a new player link and disconnect the old one"
                  >
                    New link
                  </button>
                  <button
                    className="link"
                    onClick={() => act(() => request(`/api/admin/screens/${s.id}`, { method: 'PATCH', body: JSON.stringify({ active: !s.active }) }))}
                  >
                    {s.active ? 'Deactivate' : 'Activate'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <form className="card add-screen" onSubmit={add}>
        <h2>Add a screen</h2>
        <div className="add-grid">
          <label>
            Venue
            <input value={form.venue} onChange={(e) => setForm({ ...form, venue: e.target.value })} required minLength={2} />
          </label>
          <label>
            Placement
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Front window" required minLength={2} />
          </label>
          <label>
            City
            <input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} required minLength={2} />
          </label>
          <label>
            Rate per day ($)
            <input type="number" min="1" step="0.5" value={form.rate} onChange={(e) => setForm({ ...form, rate: e.target.value })} required />
          </label>
          <button className="primary">Add screen</button>
        </div>
        <p className="muted small">Open the player link on the screen's browser in full screen. It refreshes the playlist every minute.</p>
      </form>
    </>
  )
}
