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

// Pinia store for cross-cutting UI state. Right now: the expert-mode
// toggle. Operator-facing chrome (nav menu, view contents) reads
// `expert` to decide whether to reveal power-user surfaces.

import { useSessionStorage } from '@vueuse/core'
import { defineStore } from 'pinia'

// Expert mode is off by default and per-session (sessionStorage clears on
// tab close). See docs/UX.md "Expert mode" — operators must not stumble
// into expert UI by accident, so re-enabling each session is deliberate.
export const useUiStore = defineStore('ui', () => {
  const expert = useSessionStorage<boolean>('sfd-config:expert', false)

  // Flip expert mode. Used by the chrome header switch and any keyboard
  // shortcut binding we add later.
  function toggleExpert() {
    expert.value = !expert.value
  }

  return { expert, toggleExpert }
})
