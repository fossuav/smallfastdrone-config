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
  build: {
    rollupOptions: {
      output: {
        // Split the two big, rarely-changing data blobs out of the entry
        // chunk: the SFD param metadata (~1.6 MB of JSON) and the MAVLink
        // message definitions (~1.3 MB of generated classes). Together they
        // pushed the entry chunk past workbox's 2 MiB precache limit, which
        // fails the build. Both still ship in the precache — offline param
        // docs are a requirement — but as their own long-lived chunks, so
        // app-code changes no longer invalidate them in the operator's cache.
        manualChunks(id) {
          if (id.includes('src/protocol/param-metadata.json'))
            return 'param-metadata'
          if (id.includes('node_modules/mavlink-mappings'))
            return 'mavlink-mappings'
          return undefined
        },
      },
    },
  },
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
      // The motor-check wizard loads a GLTF via three's GLTFLoader — a
      // subpath import Vite hasn't pre-bundled, which otherwise triggers a
      // "new dependencies optimized" reload mid-test (Playwright sees a
      // navigation race). Pre-bundle three + the loader.
      'three',
      'three/examples/jsm/loaders/GLTFLoader.js',
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
