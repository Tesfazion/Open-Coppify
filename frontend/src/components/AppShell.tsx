import { useEffect, useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import type { ReactNode } from 'react'

import { API_BASE } from '../lib/env'
import { cn } from '../lib/cn'
import { getHealth } from '../lib/api'
import type { Health } from '../types'
import SystemBadge from './SystemBadge'

interface NavItem {
  to: string
  end?: boolean
  label: string
  icon: ReactNode
}

const NAV_ITEMS: NavItem[] = [
  {
    to: '/',
    end: true,
    label: 'New',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 5v14M5 12h14" />
      </svg>
    ),
  },
  {
    to: '/library',
    label: 'Library',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="3" width="7" height="7" />
        <rect x="14" y="3" width="7" height="7" />
        <rect x="14" y="14" width="7" height="7" />
        <rect x="3" y="14" width="7" height="7" />
      </svg>
    ),
  },
  {
    to: '/settings',
    label: 'Settings',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="3" />
        <path d="M12 1v4m0 14v4M4.22 4.22l2.83 2.83m9.9 9.9l2.83 2.83M1 12h4m14 0h4M4.22 19.78l2.83-2.83m9.9-9.9l2.83-2.83" />
      </svg>
    ),
  },
]

const PAGE_TITLES: Record<string, string> = {
  '/': 'New job',
  '/library': 'Library',
  '/settings': 'Settings',
  '/about': 'About',
}

/**
 * Application chrome: skip link, top bar, sidebar rail and the routed main
 * region. Landmarks (`header`, `nav`, `main`) and a working skip link are what
 * make the app usable by keyboard and screen reader from the first keystroke.
 */
export default function AppShell({ children }: { children: ReactNode }) {
  const [health, setHealth] = useState<Health | null>(null)
  const [healthError, setHealthError] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const location = useLocation()

  useEffect(() => {
    let alive = true
    getHealth()
      .then((data) => {
        if (!alive) return
        setHealth(data)
        setHealthError(false)
      })
      .catch(() => {
        if (!alive) return
        setHealth(null)
        setHealthError(true)
      })
    return () => {
      alive = false
    }
  }, [])

  // Close the mobile drawer whenever the route changes.
  useEffect(() => {
    setSidebarOpen(false)
  }, [location.pathname])

  // Escape closes the drawer — expected of any overlay.
  useEffect(() => {
    if (!sidebarOpen) return undefined
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSidebarOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sidebarOpen])

  const title = PAGE_TITLES[location.pathname] || 'Coppify'

  return (
    <div className="grid min-h-screen grid-cols-1 grid-rows-[3.25rem_1fr] [grid-template-areas:'topbar'_'main'] lg:grid-cols-[16.5rem_1fr] lg:[grid-template-areas:'topbar_topbar'_'sidebar_main']">
      <a
        href="#main"
        className="sr-only rounded bg-sodium-500 px-4 py-2 text-sm font-semibold text-ink-900 focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50"
      >
        Skip to content
      </a>

      <header className="[grid-area:topbar] sticky top-0 z-30 flex h-[3.25rem] items-center justify-between gap-4 border-b border-ink-800 bg-ink-900/85 px-6 backdrop-blur-md">
        <div className="flex min-w-0 items-center gap-3">
          <button
            type="button"
            onClick={() => setSidebarOpen((value) => !value)}
            aria-label={sidebarOpen ? 'Close navigation' : 'Open navigation'}
            aria-expanded={sidebarOpen}
            aria-controls="sidebar"
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded border border-ink-700 text-ink-200 lg:hidden"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 12h18M3 6h18M3 18h18" />
            </svg>
          </button>
          <NavLink to="/" className="shrink-0 font-display text-xl leading-none text-ink-100 no-underline">
            Copp<em className="italic text-sodium-500">ify</em>
          </NavLink>
          <span aria-hidden="true" className="text-sm text-ink-600">
            /
          </span>
          <span className="truncate text-sm font-medium text-ink-200">{title}</span>
        </div>
        <div className="flex items-center gap-3">
          <SystemBadge health={health} error={healthError} />
        </div>
      </header>

      {sidebarOpen && (
        <div
          className="fixed inset-0 z-20 bg-black/50 lg:hidden"
          aria-hidden="true"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <aside
        id="sidebar"
        className={cn(
          'z-30 flex flex-col border-r border-ink-800 bg-ink-900',
          'lg:sticky lg:top-[3.25rem] lg:h-[calc(100vh-3.25rem)] lg:translate-x-0',
          'fixed inset-y-0 left-0 w-[16.5rem] transition-transform duration-200 lg:transition-none',
          sidebarOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <nav aria-label="Sections" className="flex flex-col gap-1 p-4">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-3 rounded px-3 py-2 text-sm font-medium no-underline transition-colors',
                  isActive
                    ? 'bg-ink-850 text-sodium-500'
                    : 'text-ink-300 hover:bg-ink-850/60 hover:text-ink-100',
                )
              }
            >
              <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">{item.icon}</span>
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto border-t border-ink-800 p-4">
          <p className="text-[0.6875rem] leading-relaxed text-ink-400">
            API {API_BASE || window.location.origin}
          </p>
          <p className="mt-2 text-[0.6875rem] leading-relaxed text-ink-400">
            Runs locally. Nothing is uploaded.
          </p>
        </div>
      </aside>

      <main id="main" tabIndex={-1} className="[grid-area:main] min-w-0 px-6 pb-16 pt-8 lg:px-8">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">{children}</div>
      </main>
    </div>
  )
}
