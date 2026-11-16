import type { ReactNode } from 'react'

/** Consistent page heading: an <h1> plus optional subtitle and actions. */
export default function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="font-display text-[clamp(1.75rem,3.5vw,2.5rem)] leading-tight text-ink-100">{title}</h1>
        {subtitle && <p className="mt-2 max-w-[42ch] text-sm text-ink-300">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-3">{actions}</div>}
    </div>
  )
}
