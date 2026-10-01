import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The Flask backend runs on 127.0.0.1:5000 and enables CORS, so the front end
// talks to it directly over axios. Override with VITE_API_URL in .env if you
// run the backend somewhere else.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    strictPort: true,
    open: false,
  },
  preview: {
    port: 3000,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
})