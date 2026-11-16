/**
 * Runtime configuration.
 *
 * The dev server proxies /api, /static and /clips to the Flask backend, so by
 * default the app is same-origin and API_BASE is empty. Set VITE_API_URL to
 * point a built bundle at a backend on another origin (that backend already
 * allows CORS for the dev origins).
 */

const configured = (import.meta.env.VITE_API_URL ?? '').trim()

export const API_BASE = configured ? configured.replace(/\/+$/, '') : ''

export const IS_DEV = import.meta.env.DEV
