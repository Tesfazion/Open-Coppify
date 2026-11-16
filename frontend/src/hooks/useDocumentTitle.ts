import { useEffect } from 'react'

/**
 * Keep the document title in sync with the current screen.
 *
 * Single-page apps do not change the title on navigation by default, which
 * leaves screen-reader and screen-history users without the primary cue that
 * the page changed (WCAG 2.4.2). Every routed page calls this.
 */
export function useDocumentTitle(title: string, deps: unknown[] = []) {
  useEffect(() => {
    document.title = title ? `${title} · Coppify` : 'Coppify'
  }, [title, ...deps])
}
