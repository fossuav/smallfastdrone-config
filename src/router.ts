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
    path: '/wizard',
    name: 'wizard',
    component: () => import('./views/WizardView.vue'),
    meta: { label: 'Bringup', icon: 'i-lucide-wand-2' },
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
