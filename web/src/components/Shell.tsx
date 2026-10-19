import type { ReactNode } from 'react'
import type { NetworkConfig } from '../lib/api'

export function Shell({
  config,
  children,
  right,
}: {
  config: NetworkConfig | null
  children: ReactNode
  right?: ReactNode
}) {
  return (
    <div className="shell">
      <header className="topbar">
        <a href="/" className="logo">
          <span className="logo-mark" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          {config?.network_name ?? 'Screens'}
        </a>
        <nav>{right}</nav>
      </header>
      {config?.test_mode && config.payments_enabled && (
        <div className="test-banner">
          Stripe test mode. Pay with card 4242 4242 4242 4242, any future date and any CVC. No real
          charges.
        </div>
      )}
      <main>{children}</main>
      <footer className="foot">
        <span>{config?.network_name}</span>
        {window.location.pathname !== '/admin' && <a href="/admin">Owner sign in</a>}
      </footer>
    </div>
  )
}

export function StatusPill({ label }: { label: string }) {
  const tone = label.toLowerCase().replace(/[^a-z]+/g, '-')
  return <span className={`pill pill-${tone}`}>{label}</span>
}
