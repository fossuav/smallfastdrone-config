import ui from '@nuxt/ui/vue-plugin'
import { createPinia } from 'pinia'
import { createApp } from 'vue'
import App from './App.vue'
import { router } from './router'
import './assets/css/main.css'

createApp(App)
  .use(createPinia())
  .use(router)
  .use(ui)
  .mount('#app')
