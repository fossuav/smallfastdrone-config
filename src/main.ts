/*
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <http://www.gnu.org/licenses/>.
 */

// App entry point. Wires Vue, Pinia (state), vue-router (navigation), and
// Nuxt UI (component library) into a single mounted application against
// the #app element in index.html. No application logic lives here —
// stores, routes, and components are all defined elsewhere and pulled in.

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
