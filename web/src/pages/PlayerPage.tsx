import QRCode from 'qrcode'
import { useCallback, useEffect, useRef, useState } from 'react'
import { request, type Playlist } from '../lib/api'

const QUEUE_KEY = 'asn-play-queue'
const REFRESH_MS = 60_000
const FLUSH_MS = 30_000

interface Play {
  id: string
  campaign_id: number
  played_at: string
}

function loadQueue(): Play[] {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) ?? '[]') as Play[]
  } catch {
    return []
  }
}

function saveQueue(q: Play[]) {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(q.slice(-2000)))
  } catch {
    // storage full or blocked: plays stay in memory until the next flush
  }
}

/**
 * Full screen player for a TV browser. Rotates the approved ads, records a
 * play each time one is shown, and uploads plays in batches. Plays survive a
 * reload or a network outage in local storage.
 */
export function PlayerPage({ playerKey }: { playerKey: string }) {
  const [playlist, setPlaylist] = useState<Playlist | null>(null)
  const [index, setIndex] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [qr, setQr] = useState<string | null>(null)
  const queue = useRef<Play[]>(loadQueue())

  const refresh = useCallback(async () => {
    try {
      const next = await request<Playlist>(`/api/player/${playerKey}/playlist`)
      // Keep the same object when nothing changed so the rotation timer and
      // play count are not reset by every refresh.
      setPlaylist((prev) => (prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next))
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [playerKey])

  const flush = useCallback(async () => {
    const batch = queue.current.slice(0, 500)
    if (!batch.length) return
    try {
      await request(`/api/player/${playerKey}/plays`, { method: 'POST', body: JSON.stringify({ plays: batch }) })
      const sent = new Set(batch.map((p) => p.id))
      queue.current = queue.current.filter((p) => !sent.has(p.id))
      saveQueue(queue.current)
    } catch {
      // offline: try again next round
    }
  }, [playerKey])

  useEffect(() => {
    const first = async () => refresh()
    void first()
    const a = window.setInterval(() => void refresh(), REFRESH_MS)
    const b = window.setInterval(() => void flush(), FLUSH_MS)
    return () => {
      window.clearInterval(a)
      window.clearInterval(b)
    }
  }, [refresh, flush])

  const items = playlist?.items ?? []
  const current = items.length ? items[index % items.length] : null

  // Record a play when an ad comes on screen, then advance after its slot.
  useEffect(() => {
    if (!playlist || !current) return
    queue.current.push({ id: crypto.randomUUID(), campaign_id: current.campaign_id, played_at: new Date().toISOString() })
    saveQueue(queue.current)
    const t = window.setTimeout(() => setIndex((i) => i + 1), playlist.screen.slot_seconds * 1000)
    return () => window.clearTimeout(t)
  }, [playlist, current, index])

  useEffect(() => {
    if (!playlist) return
    const url = `${window.location.origin}/?screen=${playlist.screen.id}`
    QRCode.toDataURL(url, { margin: 1, width: 360, color: { dark: '#14213d', light: '#ffffff' } }).then(setQr, () => setQr(null))
  }, [playlist])

  if (error && !playlist) {
    return (
      <div className="player">
        <div className="house">
          <p className="house-kicker">Screen not connected</p>
          <h1>{error}</h1>
          <p>Check the player link in the owner dashboard.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="player" onDoubleClick={() => void document.documentElement.requestFullscreen?.()}>
      {current ? (
        <img key={`${current.campaign_id}-${index}`} className="player-ad" src={current.creative_url} alt={current.business_name} />
      ) : (
        <div className="house">
          <p className="house-kicker">{playlist?.screen.venue}</p>
          <h1>Advertise on this screen</h1>
          <p>Local businesses book this spot online in a few minutes. Scan to see dates and prices.</p>
          {qr && <img className="qr" src={qr} alt="Booking link QR code" />}
        </div>
      )}
    </div>
  )
}
