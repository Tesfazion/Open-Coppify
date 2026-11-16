import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The Flask backend runs on 127.0.0.1:5000. In development we proxy the API and
// the generated media through Vite so the app is same-origin: no CORS, and the
// browser only ever talks to one origin. Set VITE_API_URL to point the built app
// at a remote backend instead (see src/lib/env.ts).
const BACKEND = process.env.VITE_BACKEND_ORIGIN || 'http://127.0.0.1:5000'

const proxy = {
  target: BACKEND,
  changeOrigin: true,
  // Server-Sent Events must not be buffered by the proxy.
  ws: false,
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 4041,
    strictPort: true,
    open: false,
    proxy: {
      '/api': proxy,
      '/static': proxy,
      '/clips': proxy,
    },
  },
  preview: {
    port: 4041,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
})
