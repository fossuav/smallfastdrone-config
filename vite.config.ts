import ui from '@nuxt/ui/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

export default defineConfig({
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
  ],
})
