import { expect, test } from '@playwright/test'

// End-to-end check of the param browser: connect to SITL, flip into
// expert mode, navigate to /params, wait for the fetch to complete,
// verify the table populates and filtering narrows it.

const SITL_URL = '/?transport=websocket&host=localhost:5761'

test('Param browser fetches and displays params from SITL', async ({ page }) => {
  await page.goto(SITL_URL)
  await page.getByRole('button', { name: 'Connect drone' }).click()
  await expect(page.getByText('Connected to your Quadcopter')).toBeVisible({ timeout: 15_000 })

  // Expert toggle reveals the Parameters nav link.
  await page.getByRole('switch', { name: 'Expert' }).click()
  await page.getByRole('link', { name: 'Parameters' }).click()

  // The view auto-loads on mount. Progress bar appears, then disappears.
  await expect(page.getByText(/Fetching parameters/)).toBeVisible({ timeout: 5_000 })
  await expect(page.getByText(/Fetching parameters/)).not.toBeVisible({ timeout: 30_000 })

  // Once loaded, the result summary shows N of N parameters
  // (toLocaleString inserts comma thousand-separators, e.g. "1,384").
  await expect(page.getByText(/[\d,]+ of [\d,]+ parameters/)).toBeVisible({ timeout: 5_000 })

  // ArduPilot copter has plenty of ATC_ params; filter and verify.
  await page.getByPlaceholder(/Filter by name/).fill('ATC_')
  // At least one ATC_ row should be present.
  await expect(page.locator('tbody tr').first()).toBeVisible()
  await expect(page.locator('tbody tr td').first()).toContainText(/^ATC_/)
})
