import ui from '@nuxt/ui/vue-plugin'
import { createApp } from 'vue'
import { createRouter, createWebHistory } from 'vue-router'
import App from './App.vue'
import './assets/css/main.css'

// Minimal router stub — real routes land in the app-shell slice.
// Nuxt UI's Link override requires vue-router to be installed and registered.
const router = createRouter({
  history: createWebHistory(),
  routes: [],
})

createApp(App)
  .use(router)
  .use(ui)
  .mount('#app')
