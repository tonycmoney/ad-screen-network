import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Shell } from '../components/Shell'
import { request, type NetworkConfig, type PublicScreen } from '../lib/api'
import { addDays, dateRange, daysInclusive, money, quoteCents } from '../lib/format'

interface Props {
  config: NetworkConfig
  /** Where to send the buyer once Stripe Checkout is ready. */
  redirect?: (url: string) => void
}

export function BookPage({ config, redirect = (u) => window.location.assign(u) }: Props) {
  const params = new URLSearchParams(window.location.search)
  const [screens, setScreens] = useState<PublicScreen[]>([])
  const [remaining, setRemaining] = useState<Record<number, number>>({})
  const [selected, setSelected] = useState<number[]>(() => {
    const s = Number(params.get('screen'))
    return Number.isInteger(s) && s > 0 ? [s] : []
  })
  const [start, setStart] = useState(addDays(config.today, 1))
  const [end, setEnd] = useState(addDays(config.today, 7))
  const [business, setBusiness] = useState('')
  const [email, setEmail] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(params.get('canceled') ? 'Checkout canceled. Your slot was not charged.' : null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    request<PublicScreen[]>('/api/screens').then(setScreens, (e: Error) => setError(e.message))
  }, [])

  const days = daysInclusive(start, end)
  const datesValid = days > 0 && start >= config.today && days <= config.max_campaign_days

  useEffect(() => {
    if (!datesValid) return
    let stale = false
    const load = async () => {
      try {
        const rows = await request<{ screen_id: number; remaining: number }[]>(
          `/api/availability?start=${start}&end=${end}`,
        )
        if (!stale) setRemaining(Object.fromEntries(rows.map((r) => [r.screen_id, r.remaining])))
      } catch {
        if (!stale) setRemaining({})
      }
    }
    void load()
    return () => {
      stale = true
    }
  }, [start, end, datesValid])

  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview)
  }, [preview])

  const chosen = useMemo(() => screens.filter((s) => selected.includes(s.id)), [screens, selected])
  const total = quoteCents(
    chosen.map((s) => s.daily_rate_cents),
    start,
    end,
  )
  const cities = useMemo(() => [...new Set(screens.map((s) => s.city))], [screens])

  const toggle = (id: number) =>
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]))

  const pickFile = (f: File | undefined) => {
    setError(null)
    if (!f) return
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(f.type)) {
      setError('Use a PNG, JPEG or WebP image.')
      return
    }
    if (f.size > config.max_creative_bytes) {
      setError(`Image must be under ${Math.round(config.max_creative_bytes / 1048576)} MB.`)
      return
    }
    setFile(f)
    setPreview(URL.createObjectURL(f))
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!file || !chosen.length) return
    setBusy(true)
    setError(null)
    const form = new FormData()
    form.set('business_name', business)
    form.set('email', email)
    form.set('screen_ids', chosen.map((s) => s.id).join(','))
    form.set('start', start)
    form.set('end', end)
    form.set('creative', file)
    try {
      const res = await request<{ checkout_url: string }>('/api/campaigns', { method: 'POST', body: form })
      redirect(res.checkout_url)
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  const ready = config.payments_enabled && datesValid && chosen.length > 0 && file && business.trim().length >= 2 && email

  return (
    <Shell config={config}>
      <section className="hero">
        <h1>Put your business on screens around town.</h1>
        <p>
          Pick the shops, cafes and gyms where your neighbors already spend time. Upload one image,
          choose your dates, pay online. The owner approves it and it starts playing, with a play
          count for every screen.
        </p>
      </section>

      <form className="book" onSubmit={submit}>
        <div className="book-main">
          <div className="card">
            <h2>1. When should it run?</h2>
            <div className="dates">
              <label>
                Start
                <input type="date" value={start} min={config.today} onChange={(e) => setStart(e.target.value)} required />
              </label>
              <label>
                End
                <input type="date" value={end} min={start} onChange={(e) => setEnd(e.target.value)} required />
              </label>
              <div className="dates-sum">
                {datesValid ? `${days} day${days === 1 ? '' : 's'}` : `Choose up to ${config.max_campaign_days} days, starting today or later`}
              </div>
            </div>
          </div>

          <div className="card">
            <h2>2. Choose screens</h2>
            {screens.length === 0 && <p className="muted">No screens are open for booking yet.</p>}
            {cities.map((city) => (
              <div key={city} className="city">
                <h3>{city}</h3>
                <div className="screen-grid">
                  {screens
                    .filter((s) => s.city === city)
                    .map((s) => {
                      const left = remaining[s.id]
                      const full = left === 0
                      const on = selected.includes(s.id)
                      return (
                        <label key={s.id} className={`screen-card ${on ? 'on' : ''} ${full ? 'full' : ''}`}>
                          <input type="checkbox" checked={on} disabled={full && !on} onChange={() => toggle(s.id)} />
                          <span className="screen-venue">{s.venue}</span>
                          <span className="screen-name">{s.name}</span>
                          <span className="screen-meta">
                            <span><b>{money(s.daily_rate_cents)}</b>/day</span>
                            <span className={`dot ${s.online ? 'live' : ''}`} title={s.online ? 'Screen online' : 'Screen offline'} />
                          </span>
                          <span className="screen-slots">
                            {left === undefined ? '' : full ? 'Fully booked' : `${left} slot${left === 1 ? '' : 's'} left`}
                          </span>
                        </label>
                      )
                    })}
                </div>
              </div>
            ))}
          </div>

          <div className="card">
            <h2>3. Your ad</h2>
            <div className="upload-row">
              <label className={`drop ${preview ? 'has' : ''}`}>
                {preview ? <img src={preview} alt="Ad preview" /> : <span>Upload a landscape image<br /><small>1920 × 1080 works best · PNG, JPEG or WebP</small></span>}
                <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => pickFile(e.target.files?.[0])} />
              </label>
              <div className="fields">
                <label>
                  Business name
                  <input value={business} onChange={(e) => setBusiness(e.target.value)} maxLength={80} required />
                </label>
                <label>
                  Email for receipts and updates
                  <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
                </label>
              </div>
            </div>
          </div>
        </div>

        <aside className="summary card">
          <h2>Summary</h2>
          <dl>
            <dt>Dates</dt>
            <dd>{datesValid ? dateRange(start, end) : '—'}</dd>
            <dt>Screens</dt>
            <dd>{chosen.length ? chosen.map((s) => s.venue).join(', ') : 'None yet'}</dd>
            <dt>Per day</dt>
            <dd>{money(chosen.reduce((a, s) => a + s.daily_rate_cents, 0))}</dd>
          </dl>
          <div className="total">
            <span>Total</span>
            <strong>{money(datesValid ? total : 0)}</strong>
          </div>
          {error && <p className="error" role="alert">{error}</p>}
          <button className="primary" disabled={!ready || busy}>
            {busy ? 'Opening checkout…' : 'Pay and submit for review'}
          </button>
          {!config.payments_enabled && <p className="muted small">Online booking opens soon.</p>}
          <p className="muted small">
            Payment is handled by Stripe. If your ad isn't approved, you get a full refund.
          </p>
        </aside>
      </form>
    </Shell>
  )
}
