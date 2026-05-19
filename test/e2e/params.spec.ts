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

test('Param editor: enum params render as a dropdown', async ({ page }) => {
  await page.goto(SITL_URL)
  await page.getByRole('button', { name: 'Connect drone' }).click()
  await expect(page.getByText('Connected to your Quadcopter')).toBeVisible({ timeout: 15_000 })
  await page.getByRole('switch', { name: 'Expert' }).click()
  await page.getByRole('link', { name: 'Parameters' }).click()
  await expect(page.getByText(/Fetching parameters/)).not.toBeVisible({ timeout: 30_000 })

  // RTL_ALT_TYPE has Values metadata: 0 = "Relative to Home", 1 = "Terrain"
  await page.getByPlaceholder(/Filter by name/).fill('RTL_ALT_TYPE')
  const row = page.locator('tbody tr').first()
  await expect(row.locator('td').first()).toHaveText('RTL_ALT_TYPE')

  // Click to edit → dropdown appears with both options.
  await row.locator('button[type="button"]').first().click()
  const select = row.locator('select')
  await expect(select).toBeVisible()
  await expect(select.locator('option')).toContainText([
    /Relative to Home/,
    /Terrain/,
  ])

  // Choosing an option fires @change, which commits the edit.
  await select.selectOption('1')

  // Pending banner + dirty styling appear.
  await expect(page.getByText('1 change pending', { exact: false })).toBeVisible()
  await expect(row.getByText(/was [-\d]/)).toBeVisible()

  // The decoded enum label "Terrain" shows in the value cell (italic small text).
  await expect(row.getByText(/Terrain/)).toBeVisible()
})

test('Param editor: Apply writes to SITL and saves to flash', async ({ page }) => {
  await page.goto(SITL_URL)
  await page.getByRole('button', { name: 'Connect drone' }).click()
  await expect(page.getByText('Connected to your Quadcopter')).toBeVisible({ timeout: 15_000 })
  await page.getByRole('switch', { name: 'Expert' }).click()
  await page.getByRole('link', { name: 'Parameters' }).click()
  await expect(page.getByText(/Fetching parameters/)).not.toBeVisible({ timeout: 30_000 })

  // Filter + edit a value
  await page.getByPlaceholder(/Filter by name/).fill('RTL_ALT')
  const row = page.locator('tbody tr').first()
  await row.locator('button[type="button"]').first().click()
  const input = row.locator('input[type="text"]')
  await input.fill('1234')
  await input.press('Enter')

  // Click Apply (in the pending-changes banner)
  await page.getByRole('button', { name: 'Apply', exact: true }).click()

  // Success banner appears
  await expect(page.getByText(/saved to your drone/)).toBeVisible({ timeout: 10_000 })

  // The pending-changes "was X" tag is gone (edit cleared after ack)
  await expect(row.getByText(/was [-\d]/)).not.toBeVisible()

  // The row's value is now what we set (the FC accepted it)
  await expect(row.locator('button[type="button"]').first()).toContainText('1234')
})
