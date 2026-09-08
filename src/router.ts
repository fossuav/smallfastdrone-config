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
//
// Two operator destinations for wizards, not four (PLAN decision 43):
// "Bringup" is the guided ordered walk, "Recipes" is the one catalogue.
// The old `/wizard` library and `/field` pages redirect into them, so a
// bookmark from before the collapse still lands somewhere sensible.

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
    // "Bringup" in the nav is the guided ordered walk, which is the
    // bringup meta-wizard's own runner route. This bare path carries the
    // nav entry and redirects onto it, which also keeps the pre-collapse
    // /wizard library URL alive.
    path: '/wizard',
    name: 'wizard',
    redirect: '/wizard/bringup',
    meta: { label: 'Bringup', icon: 'i-lucide-list-checks' },
  },
  {
    // The Field tools page folded into the catalogue's "On the radio"
    // filter. Redirect so an old link still lands on what it meant.
    path: '/field',
    name: 'field',
    redirect: { path: '/recipes', query: { view: 'radio' } },
  },
  {
    // Per-wizard runner. No `meta.label` so it doesn't appear in the
    // nav; the catalogue is the entry point and links into here.
    path: '/wizard/:id',
    name: 'wizard-runner',
    component: () => import('./views/WizardRunnerView.vue'),
  },
  {
    // The one catalogue: every wizard the tool bundles, bringup's steps
    // included and free. `?view=radio` narrows it to the entries with a
    // radio version.
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
