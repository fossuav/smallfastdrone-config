import ui from '@nuxt/ui/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

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
  ],
})
