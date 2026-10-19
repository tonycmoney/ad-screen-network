import { useEffect, useState } from 'react'
import { request, type NetworkConfig } from './lib/api'
import { AdminPage } from './pages/AdminPage'
import { BookPage } from './pages/BookPage'
import { CampaignPage } from './pages/CampaignPage'
import { PlayerPage } from './pages/PlayerPage'

export default function App() {
  const path = window.location.pathname
  const player = path.match(/^\/play\/([\w-]+)$/)
  const [config, setConfig] = useState<NetworkConfig | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (player) return
    request<NetworkConfig>('/api/config').then(setConfig, (e: Error) => setError(e.message))
  }, [player])

  useEffect(() => {
    if (config) document.title = config.network_name
  }, [config])

  if (player) return <PlayerPage playerKey={player[1]!} />
  if (error) return <p className="error page-error">{error}</p>
  if (!config) return null

  const campaign = path.match(/^\/campaign\/([\w-]+)$/)
  if (campaign) return <CampaignPage config={config} token={campaign[1]!} />
  if (path === '/admin') return <AdminPage config={config} />
  return <BookPage config={config} />
}
