export interface NetworkConfig {
  network_name: string
  timezone: string
  currency: string
  today: string
  payments_enabled: boolean
  test_mode: boolean
  admin_enabled: boolean
  max_campaign_days: number
  max_creative_bytes: number
}

export interface PublicScreen {
  id: number
  name: string
  venue: string
  address: string
  city: string
  daily_rate_cents: number
  online: boolean
}

export type CampaignStatus = 'awaiting_payment' | 'in_review' | 'approved' | 'rejected' | 'expired'

export interface PlayReport {
  total: number
  rows: { screen_id: number; day: string; plays: number }[]
}

export interface Campaign {
  token: string
  business_name: string
  status: CampaignStatus
  start_date: string
  end_date: string
  amount_cents: number
  currency: string
  creative_url: string
  reject_reason: string | null
  refunded: boolean
  created_at: string
  paid_at: string | null
  reviewed_at: string | null
}

export interface CampaignDetail extends Campaign {
  screens: { id: number; name: string; venue: string; city: string }[]
  plays: PlayReport
}

export interface AdminCampaign extends Campaign {
  id: number
  contact_email: string
  screen_names: string[]
  plays: number
  refund_id: string | null
}

export interface AdminScreen {
  id: number
  name: string
  venue: string
  address: string
  city: string
  player_key: string
  daily_rate_cents: number
  slot_seconds: number
  active: boolean
  last_seen_at: string | null
  online: boolean
  live_campaigns: number
  plays_7d: number
}

export interface Overview {
  revenue_cents: number
  revenue_month_cents: number
  awaiting_review: number
  live_campaigns: number
  plays_today: number
  screens_total: number
  screens_online: number
  today: string
}

export interface Playlist {
  screen: { id: number; name: string; venue: string; slot_seconds: number }
  date: string
  items: { campaign_id: number; business_name: string; creative_url: string }[]
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (init.body && typeof init.body === 'string') headers.set('Content-Type', 'application/json')
  const res = await fetch(path, { ...init, headers, credentials: 'same-origin' })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(res.status, body.error ?? res.statusText)
  return body as T
}

export const json = (data: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(data) })
