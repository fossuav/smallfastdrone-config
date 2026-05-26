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

// Application routes. One entry per top-level view rendered into the
// shell's <RouterView>. Each route carries display metadata (label, icon)
// that the nav menu in App.vue reads to render itself, plus an optional
// `expert: true` flag that hides the route from the menu when the
// expert-mode toggle in the UI store is off. Views are lazily imported
// so the initial bundle stays small.

import type { RouteRecordRaw } from 'vue-router'
import { createRouter, createWebHistory } from 'vue-router'

export const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'connect',
    component: () => import('./views/ConnectView.vue'),
    meta: { label: 'Connect', icon: 'i-lucide-plug' },
  },
  {
    // The wizard library is still hosted at /wizard (sensor noise, Pro PID,
    // standalone wizard access). But "Bringup" in the top nav now goes
    // straight to the ribbon — the library is reached via the "All wizards"
    // link in the bringup view (until Recipes carries the orphans). navTo
    // overrides the nav target without changing the route path.
    path: '/wizard',
    name: 'wizard',
    component: () => import('./views/WizardLibraryView.vue'),
    meta: { label: 'Bringup', icon: 'i-lucide-list-checks', navTo: '/wizard/bringup' },
  },
  {
    // Field tools catalogue. No nav label — reached via the header's
    // radio-icon entry point (it's a cross-cutting capability, not a
    // primary destination).
    path: '/field',
    name: 'field',
    component: () => import('./views/FieldToolsView.vue'),
  },
  {
    // Per-wizard runner. No `meta.label` so it doesn't appear in the
    // nav; the library is the entry point and links into here.
    path: '/wizard/:id',
    name: 'wizard-runner',
    component: () => import('./views/WizardRunnerView.vue'),
  },
  {
    path: '/recipes',
    name: 'recipes',
    component: () => import('./views/RecipesView.vue'),
    meta: { label: 'Recipes', icon: 'i-lucide-book-open' },
  },
  {
    path: '/logs',
    name: 'logs',
    component: () => import('./views/LogsView.vue'),
    meta: { label: 'Logs', icon: 'i-lucide-file-text' },
  },
  {
    path: '/firmware',
    name: 'firmware',
    component: () => import('./views/FirmwareView.vue'),
    meta: { label: 'Firmware', icon: 'i-lucide-cpu' },
  },
  {
    path: '/settings',
    name: 'settings',
    component: () => import('./views/SettingsView.vue'),
    meta: { label: 'Settings', icon: 'i-lucide-sliders-horizontal' },
  },
  {
    path: '/esc',
    name: 'esc',
    component: () => import('./views/EscToolsView.vue'),
    meta: { label: 'ESC tools', icon: 'i-lucide-zap' },
  },
  {
    path: '/params',
    name: 'params',
    component: () => import('./views/ParamsView.vue'),
    meta: { label: 'Parameters', icon: 'i-lucide-sliders-horizontal', expert: true },
  },
]

export const router = createRouter({
  history: createWebHistory(),
  routes,
})
