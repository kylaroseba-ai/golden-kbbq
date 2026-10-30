import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig(({ mode }) => {
  // With a real Supabase project the in-browser demo database is never loaded, so don't precache it on staff phones.
  const production = !!loadEnv(mode, process.cwd(), 'VITE_').VITE_SUPABASE_URL
  return {
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'prompt',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'Golden Korean BBQ', short_name: 'Golden', description: 'Inventory, POS and reservations',
        theme_color: '#0e0e10', background_color: '#0e0e10', display: 'standalone', start_url: '/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,wasm,data}'],
        globIgnores: production ? ['**/pglite*', '**/*.wasm', '**/*.data', '**/localBackend*'] : [],
        maximumFileSizeToCacheInBytes: 30 * 1024 * 1024,
        navigateFallbackDenylist: [/^\/functions/],
      },
    }),
  ],
  optimizeDeps: { exclude: ['@electric-sql/pglite'] },
  worker: { format: 'es' },
  }
})
