import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // /api/* goes to the Python server, so one URL (or one tunnel) serves both.
    proxy: {
      '/api': { target: 'http://localhost:8000', changeOrigin: true, rewrite: path => path.replace(/^\/api/, '') },
    },
    // Allow tunnel links for teammates (localhost.run via `ssh -R 80:localhost:5173 nokey@localhost.run`).
    allowedHosts: ['.lhr.life', '.localhost.run', '.trycloudflare.com'],
  },
})
