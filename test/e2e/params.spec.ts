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

test('Param editor: enum-style params show all suggestions as chips', async ({ page }) => {
  await page.goto(SITL_URL)
  await page.getByRole('button', { name: 'Connect drone' }).click()
  await expect(page.getByText('Connected to your Quadcopter')).toBeVisible({ timeout: 15_000 })
  await page.getByRole('switch', { name: 'Expert' }).click()
  await page.getByRole('link', { name: 'Parameters' }).click()
  await expect(page.getByText(/Fetching parameters/)).not.toBeVisible({ timeout: 30_000 })

  // RTL_ALT_TYPE has Values metadata: 0 = "Relative to Home", 1 = "Terrain".
  await page.getByPlaceholder(/Filter by name/).fill('RTL_ALT_TYPE')
  const row = page.locator('tbody tr').first()
  await expect(row.locator('td').first()).toHaveText('RTL_ALT_TYPE')

  // Click to edit → input + all suggestion chips appear (visible, not
  // filtered by input contents).
  await row.locator('button[type="button"]').first().click()
  const input = row.locator('input[type="text"]')
  await expect(input).toBeVisible()
  await expect(row.getByRole('button', { name: /Relative to Home/ })).toBeVisible()
  await expect(row.getByRole('button', { name: /Terrain/ })).toBeVisible()

  // Click the "Terrain" chip → commits the value and the decoded label
  // appears in display mode.
  await row.getByRole('button', { name: /Terrain/ }).click()
  await expect(page.getByText('1 change pending', { exact: false })).toBeVisible()
  await expect(row.getByText(/was [-\d]/)).toBeVisible()
  // The decoded caption shows "Terrain" beneath the value.
  await expect(row.locator('.italic').filter({ hasText: /Terrain/ })).toBeVisible()
})

test('Param editor: bitmask params expose per-bit checkboxes', async ({ page }) => {
  await page.goto(SITL_URL)
  await page.getByRole('button', { name: 'Connect drone' }).click()
  await expect(page.getByText('Connected to your Quadcopter')).toBeVisible({ timeout: 15_000 })
  await page.getByRole('switch', { name: 'Expert' }).click()
  await page.getByRole('link', { name: 'Parameters' }).click()
  await expect(page.getByText(/Fetching parameters/)).not.toBeVisible({ timeout: 30_000 })

  // FENCE_TYPE has Bitmask metadata: bit 0 = "Max altitude", bit 1 =
  // "Circle Centered on Home", bit 2 = "Inclusion/Exclusion …", bit 3 =
  // "Min altitude".
  await page.getByPlaceholder(/Filter by name/).fill('FENCE_TYPE')
  const row = page.locator('tbody tr').first()
  await expect(row.locator('td').first()).toHaveText('FENCE_TYPE')

  // Click to edit → input + a checkbox row per documented bit.
  await row.locator('button[type="button"]').first().click()
  const input = row.locator('input[type="text"]')
  await expect(input).toBeVisible()

  // All four bit-checkboxes are present.
  await expect(row.getByRole('checkbox', { name: /bit 0: Max altitude/ })).toBeVisible()
  await expect(row.getByRole('checkbox', { name: /bit 1: Circle/ })).toBeVisible()
  await expect(row.getByRole('checkbox', { name: /bit 2: Inclusion/ })).toBeVisible()
  await expect(row.getByRole('checkbox', { name: /bit 3: Min altitude/ })).toBeVisible()

  // Clear the input first (FENCE_TYPE may default to a non-zero mask on
  // SITL), then toggle bits 0 and 3 → expected value 1 + 8 = 9.
  await input.fill('0')
  await row.getByRole('checkbox', { name: /bit 0/ }).click()
  await expect(input).toHaveValue('1')
  await row.getByRole('checkbox', { name: /bit 3/ }).click()
  await expect(input).toHaveValue('9')

  // Press Enter to commit; banner appears.
  await input.press('Enter')
  await expect(page.getByText('1 change pending', { exact: false })).toBeVisible()
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
