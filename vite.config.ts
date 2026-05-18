import ui from '@nuxt/ui/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import { VitePWA } from 'vite-plugin-pwa'

// vite-plugin-mkcert is installed but intentionally not active by default.
// First run wants to `mkcert -install` the local CA system-wide, which
// needs sudo, which Playwright's non-TTY webServer can't prompt for.
// Enable when WebAuthn / remote-key-exchange / LAN device testing
// actually needs HTTPS — see PLAN.md decisions row 13.

export default defineConfig({
  // Pre-optimise node-mavlink + its polyfilled deps so the first browser
  // load doesn't trigger a "new dependencies optimized" reload mid-test
  // (Playwright sees it as a navigation race).
  optimizeDeps: {
    include: [
      'node-mavlink',
      'mavlink-mappings',
      'vite-plugin-node-polyfills/shims/buffer',
      'vite-plugin-node-polyfills/shims/global',
      'vite-plugin-node-polyfills/shims/process',
    ],
  },
  plugins: [
    vue(),
    ui({
      ui: {
        colors: {
          primary: 'foss',
          secondary: 'gold',
          neutral: 'neutral',
        },
      },
      theme: {
        colors: ['primary', 'secondary', 'success', 'info', 'warning', 'error'],
      },
    }),
    // node-mavlink (and its mavlink-mappings dependency) use Node's Buffer
    // and stream APIs. We polyfill the few Node modules it touches so the
    // typed message classes and the streaming packet splitter both work in
    // the browser. See docs/ARCHITECTURE.md and PLAN.md decision 4.
    nodePolyfills({
      include: ['buffer', 'stream', 'events', 'process', 'util'],
      globals: {
        Buffer: true,
        process: true,
      },
    }),
    // Installable PWA: web manifest + service worker (auto-update). Icons
    // live in public/ (generated from sfd-logo on the FOSS purple).
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.png'],
      manifest: {
        name: 'SmallFastDrone Config',
        short_name: 'SFD Config',
        description: 'Configure SmallFastDrone aircraft — fast, and safely.',
        theme_color: '#4A1E80',
        background_color: '#0a0a0a',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      // Don't generate a service worker during dev — it caches aggressively
      // and the hot-reload loop becomes confusing.
      devOptions: {
        enabled: false,
      },
    }),
  ],
})
