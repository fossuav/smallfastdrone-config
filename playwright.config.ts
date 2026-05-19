import process from 'node:process'
import { defineConfig, devices } from '@playwright/test'

// E2E config. See docs/TESTING.md for the broader test-pyramid context.
//
// Two webServer entries:
//   1. SITL + bridge (foreground in scripts/test-sitl-bridge.sh) — listens on
//      ws://localhost:5761.
//   2. Vite dev server — http://localhost:5173.
//
// Playwright waits for both ports before running the tests and tears
// everything down on exit.

const isCi = Boolean(process.env.CI)

export default defineConfig({
  testDir: './test/e2e',
  fullyParallel: false, // we share one SITL instance; serial keeps state clean
  forbidOnly: isCi,
  retries: isCi ? 2 : 0,
  workers: 1,
  reporter: isCi ? [['html', { open: 'never' }], ['list']] : 'list',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command: './scripts/test-sitl-bridge.sh',
      url: 'http://localhost:5761/',
      timeout: 60_000,
      // Always restart SITL+bridge per test run. Re-using is dangerous:
      // if a prior `bun run dev:sitl` left the bridge alive but SITL had
      // since died, Playwright would reuse the dead-SITL bridge and every
      // test would fail to connect. SITL startup is ~2 s — cheap enough
      // to always pay.
      reuseExistingServer: false,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'bun dev',
      url: 'http://localhost:5173/',
      timeout: 30_000,
      reuseExistingServer: !isCi,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
})
