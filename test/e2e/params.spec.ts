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

test('Param editor: edit a value, see it pending, discard', async ({ page }) => {
  await page.goto(SITL_URL)
  await page.getByRole('button', { name: 'Connect drone' }).click()
  await expect(page.getByText('Connected to your Quadcopter')).toBeVisible({ timeout: 15_000 })
  await page.getByRole('switch', { name: 'Expert' }).click()
  await page.getByRole('link', { name: 'Parameters' }).click()
  await expect(page.getByText(/Fetching parameters/)).not.toBeVisible({ timeout: 30_000 })

  // Filter to a known prefix and take the first row. The test is about the
  // edit mechanics, not the specific param — using .first() keeps it
  // resilient to SFD-side renames (e.g. RTL_ALT_FINAL → RTL_ALT_FINAL_M).
  await page.getByPlaceholder(/Filter by name/).fill('RTL_ALT')
  const row = page.locator('tbody tr').first()
  await expect(row.locator('td').first()).toContainText(/^RTL_ALT/)

  // Click the value cell to enter edit mode.
  await row.locator('button[type="button"]').first().click()
  const input = row.locator('input[type="text"]')
  await expect(input).toBeVisible()

  // Type a new value and commit on Enter.
  await input.fill('1234')
  await input.press('Enter')

  // Pending-changes banner appears.
  await expect(page.getByText('1 change pending', { exact: false })).toBeVisible()
  // The row shows "was <original>" — the original value is some number,
  // possibly zero; the regex matches digits or a leading minus.
  await expect(row.getByText(/was [-\d]/)).toBeVisible()

  // Discard wipes the pending state.
  await page.getByRole('button', { name: 'Discard', exact: true }).click()
  await expect(page.getByText(/change pending/)).not.toBeVisible()
  await expect(row.getByText(/was [-\d]/)).not.toBeVisible()
})
