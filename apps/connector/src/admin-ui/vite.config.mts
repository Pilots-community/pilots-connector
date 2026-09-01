import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * The admin UI is built by Vite and served by the connector itself, so the
 * "minimal admin UI" costs no extra container. In development it proxies the
 * three API surfaces to a connector on 3000.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: '/admin/',
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: 5174,
    proxy: {
      '/api': 'http://localhost:3000',
      '/.well-known': 'http://localhost:3000',
    },
  },
})
