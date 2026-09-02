import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * The SPA, built into `dist/web` and served by this app's own BFF.
 *
 * One container for the pair: the BFF has to exist anyway to hold the API key
 * out of the browser, so serving the static files from it costs nothing. In
 * development Vite serves the SPA and proxies the BFF on 4000.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: 'src/web',
  build: { outDir: '../../dist/web', emptyOutDir: true },
  server: {
    port: 5175,
    proxy: { '/api': 'http://localhost:4000' },
  },
})
