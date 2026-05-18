import { useSessionStorage } from '@vueuse/core'
import { defineStore } from 'pinia'

// Expert mode is off by default and per-session (sessionStorage clears on
// tab close). See docs/UX.md "Expert mode" — operators must not stumble
// into expert UI by accident, so re-enabling each session is deliberate.
export const useUiStore = defineStore('ui', () => {
  const expert = useSessionStorage<boolean>('sfd-config:expert', false)

  function toggleExpert() {
    expert.value = !expert.value
  }

  return { expert, toggleExpert }
})
