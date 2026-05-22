import { defineConfig } from 'vitest/config'

// Unit-test config (PLAN.md decision 26). Pure-logic tests only — no Vue,
// no MAVLink, no I/O — so we skip the app's Vite plugins and run in a
// plain node environment. Integration/E2E live in Playwright + SITL.
export default defineConfig({
  test: {
    include: ['test/unit/**/*.spec.ts'],
    environment: 'node',
  },
})
