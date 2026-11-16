import type { ReactNode } from 'react'

import { cn } from '../lib/cn'

export interface ErrorNoteValue {
  message?: string
  hint?: string
}

/**
 * A failure and, where one exists, the fix.
 *
 * The hint carries most of the value: the backend attaches a `hint` to the
 * errors that have a concrete next step (a missing binary, a blocked download,
 * a missing source file), so the message stays short and the recovery is
 * spelled out underneath it.
 */
export default function ErrorNote({
  error,
  onDismiss,
  action,
  className,
}: {
  error?: ErrorNoteValue | null
  onDismiss?: () => void
  action?: ReactNode
  className?: string
}) {
  if (!error) return null

  const message = error.message || 'Something went wrong.'
  const hint = error.hint || ''

  return (
    <div role="alert" className={cn('border-l-2 border-bad pl-4', className)}>
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm font-medium text-ink-100">{message}</p>
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss"
            className="shrink-0 rounded px-1 text-ink-300 hover:text-ink-100"
          >
            ✕
          </button>
        )}
      </div>
      {hint && <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-ink-300">{hint}</p>}
      {action && <div className="mt-3 flex items-center gap-3">{action}</div>}
    </div>
  )
}
