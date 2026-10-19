import { useEffect, useState } from 'react'
import { Shell, StatusPill } from '../components/Shell'
import { ApiError, request, type CampaignDetail, type NetworkConfig } from '../lib/api'
import { dateRange, liveLabel, money, niceDate } from '../lib/format'

export function CampaignPage({ config, token }: { config: NetworkConfig; token: string }) {
  const [c, setC] = useState<CampaignDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const justPaid = new URLSearchParams(window.location.search).has('paid')

  useEffect(() => {
    let tries = 0
    let timer: number | undefined
    const load = async () => {
      try {
        const data = await request<CampaignDetail>(`/api/campaigns/${token}`)
        setC(data)
        // Stripe's webhook usually lands within a few seconds of the redirect.
        if (justPaid && data.status === 'awaiting_payment' && tries++ < 15) {
          timer = window.setTimeout(load, 2000)
        }
      } catch (e) {
        setError(e instanceof ApiError && e.status === 404 ? 'We could not find that campaign.' : (e as Error).message)
      }
    }
    void load()
    return () => window.clearTimeout(timer)
  }, [token, justPaid])

  if (error) {
    return (
      <Shell config={config}>
        <div className="card narrow"><p className="error">{error}</p></div>
      </Shell>
    )
  }
  if (!c) return <Shell config={config}><div className="card narrow muted">Loading…</div></Shell>

  const label = liveLabel(c.status, c.start_date, c.end_date, config.today)
  const steps = [
    { name: 'Paid', done: Boolean(c.paid_at) },
    { name: 'Approved', done: c.status === 'approved' },
    { name: 'Live', done: c.status === 'approved' && config.today >= c.start_date },
  ]
  const byScreen = new Map<number, number>()
  for (const r of c.plays.rows) byScreen.set(r.screen_id, (byScreen.get(r.screen_id) ?? 0) + r.plays)

  return (
    <Shell config={config}>
      <div className="campaign">
        <div className="card">
          <div className="campaign-head">
            <div>
              <h1>{c.business_name}</h1>
              <p className="muted">
                {dateRange(c.start_date, c.end_date)} · {c.screens.length} screen{c.screens.length === 1 ? '' : 's'} ·{' '}
                {money(c.amount_cents, c.currency)}
              </p>
            </div>
            <StatusPill label={label} />
          </div>

          {c.status === 'awaiting_payment' && (
            <p className="note">
              {justPaid ? 'Confirming your payment with Stripe…' : 'This booking has not been paid yet.'}
            </p>
          )}
          {c.status === 'in_review' && (
            <p className="note">Paid. The network owner reviews new ads, usually within one business day.</p>
          )}
          {c.status === 'rejected' && (
            <p className="note bad">
              Not approved: {c.reject_reason}. {c.refunded ? 'Your payment has been refunded in full.' : ''}
            </p>
          )}
          {c.status === 'expired' && <p className="note bad">Checkout expired before payment. Nothing was charged.</p>}

          {c.status !== 'rejected' && c.status !== 'expired' && (
            <ol className="steps">
              {steps.map((s) => (
                <li key={s.name} className={s.done ? 'done' : ''}>
                  {s.name}
                </li>
              ))}
            </ol>
          )}

          <img className="creative" src={c.creative_url} alt={`${c.business_name} ad`} />
        </div>

        <div className="card">
          <h2>Proof of play</h2>
          <p className="big-number">{c.plays.total.toLocaleString()}</p>
          <p className="muted small">plays recorded by the screens</p>
          <table>
            <thead>
              <tr>
                <th>Screen</th>
                <th>City</th>
                <th className="num">Plays</th>
              </tr>
            </thead>
            <tbody>
              {c.screens.map((s) => (
                <tr key={s.id}>
                  <td>
                    {s.venue} <span className="muted">· {s.name}</span>
                  </td>
                  <td>{s.city}</td>
                  <td className="num">{byScreen.get(s.id) ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {c.plays.rows.length > 0 && (
            <p className="muted small">Last play day: {niceDate(c.plays.rows[c.plays.rows.length - 1]!.day)}</p>
          )}
          <p className="muted small">Keep this page's link to check on your campaign.</p>
        </div>
      </div>
    </Shell>
  )
}
