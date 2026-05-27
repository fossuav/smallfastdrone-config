<script setup lang="ts">
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

// Firmware view — two install routes side by side:
//
//   - "Install over USB" (bootloader path, default): operator-supplied
//     .apj → parsed metadata + board-id confirm → flash via the FC's
//     own bootloader (over the same USB-serial port MAVLink uses).
//     Requires a live connection.
//
//   - "Install in DFU mode" (recovery / fresh chip): operator puts the
//     board into DFU mode (BOOT button + plug) → we open the WebUSB
//     DFU device → flash. Accepts .apj OR `_with_bl.hex`. Used when
//     the FC won't boot or when bringing up a fresh chip.
//
// Both paths route through the security uploader seam (see
// docs/FIRMWARE.md). Test-on-hardware notes are in the orchestrator
// (`src/workflow/firmware.ts`).

import type { ApjFirmware } from '../protocol/apj'
import type { ParsedHex } from '../protocol/intel-hex'
import type { DfuDeviceHandle } from '../transport/webusb'
import type { DfuFlashSpec, EraseStrategy } from '../workflow/firmware'
import { computed, onMounted, ref, watch } from 'vue'
import { parseApj } from '../protocol/apj'
import { parseIntelHex } from '../protocol/intel-hex'
import { useSessionStore } from '../stores/session'
import {
  listAuthorisedDfuDevices,
  openDfuDevice,
  requestDfuDevice,
} from '../transport/webusb'
import { recommendedEraseStrategy, useFirmwareFlash } from '../workflow/firmware'

const session = useSessionStore()
// Destructure so the refs auto-unwrap in the template.
const {
  phase,
  progress,
  error: flashError,
  wasSkipped,
  flash,
  flashViaBootloaderPort,
  flashDfu,
  reset,
  provideBootloaderPort,
  cancelBootloaderPick,
} = useFirmwareFlash()

// The bootloader runs at the same baud + framing as the firmware
// (ArduPilot uses the same USB-CDC config in both modes), so we don't
// need vendor/product filters here — letting the operator pick from
// any serial port keeps the dialog forgiving for prototype hardware.
const bootloaderPickError = ref<string | null>(null)
async function pickBootloaderPort() {
  bootloaderPickError.value = null
  try {
    const port = await navigator.serial.requestPort({ filters: [] })
    provideBootloaderPort(port)
  }
  catch (e) {
    // User-cancel of the browser dialog is a DOMException; everything
    // else is also user-actionable.
    if (e instanceof DOMException && e.name === 'NotFoundError') {
      bootloaderPickError.value = 'No port picked. Tap "Pick bootloader port" once your drone is showing up in the dialog.'
      return
    }
    bootloaderPickError.value = e instanceof Error ? e.message : String(e)
  }
}

// --- Path selection -------------------------------------------------

type PathKind = 'usb' | 'dfu'
const pathKind = ref<PathKind>('usb')

// --- Bootloader (USB) path state ------------------------------------

const apj = ref<ApjFirmware | null>(null)
const apjFilename = ref<string>('')
const apjError = ref<string | null>(null)
const apjFileInput = ref<HTMLInputElement | null>(null)

function openApjPicker() {
  apjFileInput.value?.click()
}

async function onApjChosen(ev: Event) {
  const input = ev.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file)
    return
  apjFilename.value = file.name
  apjError.value = null
  apj.value = null
  try {
    apj.value = await parseApj(await file.text())
    reset()
  }
  catch (e) {
    apjError.value = e instanceof Error ? e.message : String(e)
  }
  input.value = ''
}

// Shared phase helpers — declared up here so the per-path enable
// computeds (and the catch-and-swallow start functions) can reference
// them without re-ordering surprises.
const phaseIsTerminal = computed(() =>
  phase.value === 'idle' || phase.value === 'done' || phase.value === 'error',
)
const isRunning = computed(() => !phaseIsTerminal.value)

async function startUsbFlash() {
  if (!apj.value)
    return
  try {
    await flash(apj.value)
  }
  catch {
    /* flashError populated, UI reads from it */
  }
}

const canStartUsb = computed(() =>
  apj.value !== null
  && session.connected
  && session.hasHeartbeat
  && session.transport.kind === 'webserial'
  && phaseIsTerminal.value,
)

// Recovery path: the FC is already in bootloader mode (after a failed
// flash) and MAVLink isn't reachable. Operator picks the bootloader
// port directly — inside this click gesture (required for
// `navigator.serial.requestPort()`) — and we run the flash without
// the MAVLink reboot dance.
const recoveryError = ref<string | null>(null)
async function startRecoveryFlash() {
  if (!apj.value)
    return
  recoveryError.value = null
  let port: SerialPort
  try {
    port = await navigator.serial.requestPort({ filters: [] })
  }
  catch (e) {
    if (e instanceof DOMException && e.name === 'NotFoundError')
      return // operator cancelled the picker
    recoveryError.value = e instanceof Error ? e.message : String(e)
    return
  }
  try {
    await flashViaBootloaderPort(apj.value, port)
  }
  catch {
    /* flashError populated, UI reads from it */
  }
}

const canStartRecovery = computed(() =>
  apj.value !== null
  && session.transport.kind === 'webserial'
  && phaseIsTerminal.value,
)

// --- DFU path state -------------------------------------------------

// What the operator picked. Either an .apj (recovery — reuses the
// bootloader-path picker shape) or a parsed _with_bl.hex.
type DfuFile
  = | { kind: 'apj', apj: ApjFirmware, filename: string }
    | { kind: 'hex', hex: ParsedHex, filename: string }

const dfuFile = ref<DfuFile | null>(null)
const dfuFileError = ref<string | null>(null)
const dfuFileInput = ref<HTMLInputElement | null>(null)

function openDfuPicker() {
  dfuFileInput.value?.click()
}

async function onDfuFileChosen(ev: Event) {
  const input = ev.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file)
    return
  dfuFileError.value = null
  dfuFile.value = null
  try {
    const text = await file.text()
    if (file.name.endsWith('.apj')) {
      const parsed = await parseApj(text)
      dfuFile.value = { kind: 'apj', apj: parsed, filename: file.name }
    }
    else {
      // .hex — Intel HEX. Anything else falls through here too; the
      // parser surfaces the wrongness with operator-readable copy.
      const parsed = parseIntelHex(text)
      dfuFile.value = { kind: 'hex', hex: parsed, filename: file.name }
    }
    reset()
  }
  catch (e) {
    dfuFileError.value = e instanceof Error ? e.message : String(e)
  }
  input.value = ''
}

// Devices currently visible to the page (already authorised + plugged
// in). The "Find DFU device" button + a 2-second poll keep this fresh.
const dfuDevices = ref<DfuDeviceHandle[]>([])
const dfuPickError = ref<string | null>(null)

async function refreshDfuDevices() {
  try {
    dfuDevices.value = await listAuthorisedDfuDevices()
  }
  catch {
    dfuDevices.value = []
  }
}
// First load.
void refreshDfuDevices()
// Light polling — keeps the badge in sync if the operator plugs the
// device in *after* opening the page.
const dfuPollHandle = setInterval(() => void refreshDfuDevices(), 2000)
import.meta.hot?.dispose(() => clearInterval(dfuPollHandle))

async function requestDfuPermission() {
  dfuPickError.value = null
  try {
    const device = await requestDfuDevice()
    if (device) {
      // User picked one — it'll now show up in listAuthorisedDfuDevices.
      await refreshDfuDevices()
    }
  }
  catch (e) {
    dfuPickError.value = e instanceof Error ? e.message : String(e)
  }
}

// Erase strategy — exposed as a single "Wipe whole chip" switch next
// to the install button. Defaults per file kind (mass for `.hex`
// full reflash, sectors for `.apj` recovery); operator can override
// either way.
const eraseStrategy = ref<EraseStrategy>('sectors')
watch(dfuFile, (next) => {
  if (next)
    eraseStrategy.value = recommendedEraseStrategy(next.kind)
})
const wipeAll = computed({
  get: () => eraseStrategy.value === 'mass',
  set: (v: boolean) => { eraseStrategy.value = v ? 'mass' : 'sectors' },
})
// One-line hover tip so the operator can find out what each state
// does without us writing an essay inline.
const wipeAllToggleTip = computed(() =>
  wipeAll.value
    ? 'Mass erase — fastest, but loses any saved settings (and the bootloader on .apj files).'
    : 'Per-sector erase — keeps your saved settings (and the bootloader on .apj files).',
)
// Warn when the operator picks the dangerous combo (mass erase + .apj):
// mass erase wipes the bootloader, but an `.apj` doesn't carry one —
// the drone won't boot until they follow up with a `_with_bl.hex` flash.
const eraseStrategyWarning = computed(() => {
  if (wipeAll.value && dfuFile.value?.kind === 'apj') {
    return 'Wipe-whole-chip + .apj will erase the bootloader too — your drone won\'t boot afterwards until you flash a "_with_bl.hex" file to restore it.'
  }
  return null
})

async function startDfuFlash(handle: DfuDeviceHandle) {
  if (!dfuFile.value)
    return
  try {
    const opened = await openDfuDevice(handle.device)
    const spec: DfuFlashSpec = dfuFile.value.kind === 'apj'
      ? { kind: 'apj', apj: dfuFile.value.apj }
      : { kind: 'hex', hex: dfuFile.value.hex, filename: dfuFile.value.filename }
    await flashDfu(spec, opened, { eraseStrategy: eraseStrategy.value })
  }
  catch {
    /* flashError populated, UI reads from it */
  }
}

const canStartDfu = computed(() =>
  dfuFile.value !== null
  && dfuDevices.value.length > 0
  && phaseIsTerminal.value,
)

// --- Shared phase + progress display --------------------------------
// `phaseIsTerminal` + `isRunning` are declared above (before the per-
// path enable computeds that reference them).

const phaseLabel = computed(() => {
  switch (phase.value) {
    case 'idle': return ''
    case 'rebooting-to-bootloader': return 'Restarting your drone in upload mode…'
    case 'awaiting-bootloader-port': return 'Waiting for you to pick the upload-mode port…'
    case 'syncing': return 'Reaching the drone…'
    case 'verifying-board': return 'Checking this firmware matches your drone…'
    case 'erasing': return 'Erasing the old firmware…'
    case 'programming': return 'Writing the new firmware…'
    case 'verifying': return 'Verifying what was written…'
    case 'restarting': return 'Finishing up…'
    case 'reconnecting': return 'Reconnecting…'
    case 'done':
      if (pathKind.value === 'dfu')
        return 'Done. Unplug + replug your drone to start it.'
      if (wasSkipped.value)
        return 'Already up to date — your drone is running this firmware.'
      return 'Done — your drone is running the new firmware.'
    case 'error': return 'Something went wrong.'
  }
  return ''
})

const webUsbSupported = computed(() => 'usb' in navigator)

// ---- Online firmware URL builder ------------------------------------
// firmware.ardupilot.org doesn't expose CORS, so we can't fetch the
// firmware bytes from the browser directly. Instead build a download
// URL and open it in a new tab — the browser handles the download to
// the operator's filesystem, then the operator picks the file with
// the existing picker below. One extra click, no third-party proxy,
// no security-seam compromise.

type ApVehicle = 'Copter' | 'Plane' | 'Rover' | 'Sub' | 'Tracker' | 'Blimp'

const AP_BINARY_NAME: Record<ApVehicle, string> = {
  Copter: 'arducopter',
  Plane: 'arduplane',
  Rover: 'ardurover',
  Sub: 'ardusub',
  Tracker: 'antennatracker',
  Blimp: 'blimp',
}

// Default vehicle pre-selected from the connected drone when we can
// (operator usually wants firmware for whatever vehicle they're flying);
// falls back to Copter.
function vehicleFromSessionLabel(label: string | null | undefined): ApVehicle {
  if (!label)
    return 'Copter'
  const l = label.toLowerCase()
  if (l.includes('plane') || l.includes('fixed wing'))
    return 'Plane'
  if (l.includes('rover') || l.includes('ground'))
    return 'Rover'
  if (l.includes('sub'))
    return 'Sub'
  if (l.includes('tracker') || l.includes('antenna'))
    return 'Tracker'
  if (l.includes('blimp'))
    return 'Blimp'
  return 'Copter'
}

const onlineVehicle = ref<ApVehicle>(vehicleFromSessionLabel(session.vehicleLabel))
// Channel is the path segment between /Copter/ and /board/ on the
// firmware server. Common values: 'stable', 'beta', 'latest'; specific
// stable releases are 'stable-4.6.3' etc. Free string so the operator
// can also use the URL with any version we don't auto-list.
const onlineChannel = ref<string>('stable')
const onlineBoard = ref<string>('')

// Re-pick the default vehicle whenever the connection lands on a new
// type — operator who plugs in Plane mid-session shouldn't have
// "Copter" lingering as the default.
watch(() => session.vehicleLabel, (next) => {
  onlineVehicle.value = vehicleFromSessionLabel(next)
})

const onlineBaseUrl = computed(() => {
  if (!onlineBoard.value)
    return ''
  return `https://firmware.ardupilot.org/${onlineVehicle.value}/${onlineChannel.value}/${encodeURIComponent(onlineBoard.value.trim())}`
})
const onlineApjUrl = computed(() => onlineBaseUrl.value ? `${onlineBaseUrl.value}/${AP_BINARY_NAME[onlineVehicle.value]}.apj` : '')
const onlineHexUrl = computed(() => onlineBaseUrl.value ? `${onlineBaseUrl.value}/${AP_BINARY_NAME[onlineVehicle.value]}_with_bl.hex` : '')

function openOnlineUrl(url: string) {
  if (!url)
    return
  window.open(url, '_blank', 'noopener,noreferrer')
}

const onlineCopyState = ref<'idle' | 'copied'>('idle')
async function copyOnlineUrl(url: string) {
  if (!url)
    return
  try {
    await navigator.clipboard.writeText(url)
    onlineCopyState.value = 'copied'
    setTimeout(() => {
      onlineCopyState.value = 'idle'
    }, 1200)
  }
  catch {
    /* clipboard blocked — operator can right-click the link instead */
  }
}

const vehicleItems = (Object.keys(AP_BINARY_NAME) as ApVehicle[]).map(v => ({ label: v, value: v }))

// Per-vehicle list of specific stable versions ("4.6.3", "4.6.2", …),
// populated from ArduPilot's GitHub Releases on Firmware-page mount.
// firmware.ardupilot.org channels for these are "stable-4.6.3" etc.
// Tag prefix → vehicle mapping (only the ones we expose in the picker).
const TAG_PREFIX_TO_VEHICLE: Record<string, ApVehicle> = {
  Copter: 'Copter',
  Plane: 'Plane',
  Rover: 'Rover',
  Sub: 'Sub',
  Tracker: 'Tracker',
  Blimp: 'Blimp',
}
const RELEASES_CACHE_KEY = 'sfdc.ardupilot-releases'
const RELEASES_TTL_MS = 24 * 60 * 60 * 1000

const versionsByVehicle = ref<Partial<Record<ApVehicle, string[]>>>({})

interface CachedReleases {
  fetched_at: number
  versionsByVehicle: Partial<Record<ApVehicle, string[]>>
}

function readCachedReleases(): CachedReleases | null {
  try {
    const raw = localStorage.getItem(RELEASES_CACHE_KEY)
    if (!raw)
      return null
    const parsed = JSON.parse(raw) as CachedReleases
    if (typeof parsed.fetched_at !== 'number' || !parsed.versionsByVehicle)
      return null
    return parsed
  }
  catch {
    return null
  }
}

function writeCachedReleases(value: Partial<Record<ApVehicle, string[]>>): void {
  try {
    localStorage.setItem(RELEASES_CACHE_KEY, JSON.stringify({ fetched_at: Date.now(), versionsByVehicle: value }))
  }
  catch {
    /* non-fatal */
  }
}

async function fetchAndCacheReleases(): Promise<void> {
  try {
    // GitHub's /releases endpoint is sorted latest-first; 100 items
    // covers ~the last 3 major releases per vehicle (more than enough
    // for typical operator flashing). Older versions can still be
    // reached by editing the URL manually.
    const res = await fetch('https://api.github.com/repos/ArduPilot/ardupilot/releases?per_page=100')
    if (!res.ok)
      return
    const releases = await res.json() as { tag_name: string }[]
    const out: Partial<Record<ApVehicle, string[]>> = {}
    for (const r of releases) {
      const m = /^([a-z_]+)-(\d.+)$/i.exec(r.tag_name)
      if (!m)
        continue
      const vehicle = TAG_PREFIX_TO_VEHICLE[m[1]!]
      if (!vehicle)
        continue
      const version = m[2]!
      const arr = out[vehicle] ?? []
      if (!arr.includes(version))
        arr.push(version)
      out[vehicle] = arr
    }
    if (Object.keys(out).length === 0)
      return
    versionsByVehicle.value = out
    writeCachedReleases(out)
  }
  catch {
    /* network down or rate-limited — operator keeps the three default channels */
  }
}

const channelItems = computed(() => {
  const items: { label: string, value: string }[] = [
    { label: 'Latest stable', value: 'stable' },
    { label: 'Latest beta', value: 'beta' },
    { label: 'Latest dev', value: 'latest' },
  ]
  const versions = versionsByVehicle.value[onlineVehicle.value] ?? []
  for (const v of versions)
    items.push({ label: `Stable ${v}`, value: `stable-${v}` })
  return items
})

// Board list — fetched once from ArduPilot's GitHub repo (hwdef
// directory names match firmware.ardupilot.org's board directory
// names) and cached in localStorage for 24 h. GitHub API supports
// CORS; firmware.ardupilot.org doesn't. Falls back to a small built-in
// list if the fetch fails.
const FALLBACK_BOARDS = [
  'CubeOrange',
  'CubeOrangePlus',
  'CubeBlack',
  'MatekH743',
  'MatekH743-bdshot',
  'MatekF405',
  'KakuteH7',
  'KakuteH7-bdshot',
  'Pixhawk1',
  'Pixhawk4',
  'Pixhawk6X',
  'Pixhawk6C',
  'fmuv5',
  'fmuv6X',
]
const BOARD_LIST_CACHE_KEY = 'sfdc.ardupilot-board-list'
const BOARD_LIST_TTL_MS = 24 * 60 * 60 * 1000

const boardList = ref<string[]>(FALLBACK_BOARDS)
const boardListSource = ref<'fallback' | 'cache' | 'fresh'>('fallback')

interface CachedBoardList {
  fetched_at: number
  boards: string[]
}

function readCachedBoards(): CachedBoardList | null {
  try {
    const raw = localStorage.getItem(BOARD_LIST_CACHE_KEY)
    if (!raw)
      return null
    const parsed = JSON.parse(raw) as CachedBoardList
    if (typeof parsed.fetched_at !== 'number' || !Array.isArray(parsed.boards))
      return null
    return parsed
  }
  catch {
    return null
  }
}

function writeCachedBoards(boards: string[]): void {
  try {
    localStorage.setItem(BOARD_LIST_CACHE_KEY, JSON.stringify({ fetched_at: Date.now(), boards }))
  }
  catch {
    /* quota / private browsing — non-fatal */
  }
}

async function fetchAndCacheBoardList(): Promise<void> {
  try {
    const res = await fetch('https://api.github.com/repos/ArduPilot/ardupilot/contents/libraries/AP_HAL_ChibiOS/hwdef')
    if (!res.ok)
      return
    const items = await res.json() as { name: string, type: string }[]
    const boards = items
      .filter(i => i.type === 'dir')
      .map(i => i.name)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
    if (boards.length === 0)
      return
    boardList.value = boards
    boardListSource.value = 'fresh'
    writeCachedBoards(boards)
  }
  catch {
    /* network down or rate-limited — operator keeps the fallback list */
  }
}

onMounted(() => {
  // Boards.
  const cachedBoards = readCachedBoards()
  if (cachedBoards) {
    boardList.value = cachedBoards.boards
    boardListSource.value = 'cache'
  }
  if (!cachedBoards || Date.now() - cachedBoards.fetched_at >= BOARD_LIST_TTL_MS)
    void fetchAndCacheBoardList()

  // Releases (per-vehicle version list).
  const cachedReleases = readCachedReleases()
  if (cachedReleases)
    versionsByVehicle.value = cachedReleases.versionsByVehicle
  if (!cachedReleases || Date.now() - cachedReleases.fetched_at >= RELEASES_TTL_MS)
    void fetchAndCacheReleases()
})
</script>

<template>
  <div class="mx-auto w-full max-w-3xl space-y-4">
    <header class="flex items-center gap-3">
      <UIcon name="i-lucide-cpu" class="text-primary size-7" />
      <div>
        <h1 class="text-highlighted text-2xl font-semibold">
          Firmware
        </h1>
        <p class="text-muted text-sm">
          Install a SmallFastDrone firmware image.
        </p>
      </div>
    </header>

    <!-- Online firmware URL builder. firmware.ardupilot.org doesn't
         expose CORS so we can't fetch directly — generate a download
         URL, operator opens it in a new tab + the browser saves the
         file, then they pick it with the file picker in the tab
         below. One extra click; no proxy in the firmware path. -->
    <UCard>
      <div class="flex items-start gap-3">
        <UIcon name="i-lucide-download-cloud" class="text-primary mt-1 size-5 shrink-0" />
        <div class="flex-1">
          <h2 class="text-highlighted font-semibold">
            Grab a build from ArduPilot
          </h2>
          <p class="text-muted mt-1 text-sm">
            Build a link to firmware.ardupilot.org, open it, then drop the downloaded file into the picker below.
          </p>
        </div>
      </div>
      <div class="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div>
          <label class="text-muted text-xs font-medium">Vehicle</label>
          <USelect v-model="onlineVehicle" :items="vehicleItems" class="mt-1 w-full" />
        </div>
        <div>
          <label class="text-muted text-xs font-medium">Version</label>
          <USelectMenu
            v-model="onlineChannel"
            :items="channelItems"
            value-key="value"
            searchable
            searchable-placeholder="Filter versions…"
            class="mt-1 w-full"
          />
        </div>
        <div>
          <label class="text-muted text-xs font-medium">Board</label>
          <USelectMenu
            v-model="onlineBoard"
            :items="boardList"
            placeholder="Pick or type a board…"
            searchable
            searchable-placeholder="Filter boards…"
            class="mt-1 w-full"
          />
        </div>
      </div>
      <div v-if="onlineApjUrl" class="bg-muted/30 mt-3 break-all rounded-md px-2 py-1.5 font-mono text-xs">
        {{ onlineApjUrl }}
      </div>
      <div class="mt-3 flex flex-wrap items-center justify-end gap-2">
        <UButton
          :disabled="!onlineApjUrl"
          variant="ghost"
          size="sm"
          icon="i-lucide-copy"
          @click="copyOnlineUrl(onlineApjUrl)"
        >
          {{ onlineCopyState === 'copied' ? 'Copied' : 'Copy URL' }}
        </UButton>
        <UButton
          :disabled="!onlineHexUrl"
          color="neutral"
          variant="soft"
          size="sm"
          icon="i-lucide-external-link"
          @click="openOnlineUrl(onlineHexUrl)"
        >
          Download <code class="ml-1">_with_bl.hex</code>
        </UButton>
        <UButton
          :disabled="!onlineApjUrl"
          color="primary"
          size="sm"
          icon="i-lucide-external-link"
          @click="openOnlineUrl(onlineApjUrl)"
        >
          Download <code class="ml-1">.apj</code>
        </UButton>
      </div>
      <p class="text-muted mt-2 text-xs">
        <code>.apj</code> = firmware only (use "Install over USB"). <code>_with_bl.hex</code> = firmware + bootloader (use "Recovery (DFU mode)").
      </p>
    </UCard>

    <!-- Path selector. The default ("over USB") covers 99% of the
         time; "DFU mode" is recovery / fresh-chip. -->
    <UTabs
      v-model="pathKind"
      :items="[
        { label: 'Install over USB', value: 'usb', icon: 'i-lucide-usb' },
        { label: 'Recovery (DFU mode)', value: 'dfu', icon: 'i-lucide-life-buoy' },
      ]"
      :ui="{ trigger: 'flex-1' }"
    />

    <!-- ================= USB / bootloader path ================== -->
    <template v-if="pathKind === 'usb'">
      <UAlert
        v-if="session.transport.kind !== 'webserial' && phase === 'idle'"
        color="warning"
        icon="i-lucide-triangle-alert"
        title="Firmware install needs a USB connection"
        description="You're connected over the SITL bridge. Firmware install talks directly to the FC over USB — connect over USB serial to use it."
      />

      <template v-else>
        <UCard>
          <div class="flex items-start justify-between gap-3">
            <div>
              <h2 class="text-highlighted font-semibold">
                Choose a firmware file
              </h2>
              <p class="text-muted mt-1 text-sm">
                SmallFastDrone firmware ships as a <code class="bg-muted rounded px-1 py-0.5">.apj</code> file. Drop the one you downloaded here.
              </p>
            </div>
            <UButton color="primary" icon="i-lucide-file-plus" :disabled="isRunning" @click="openApjPicker">
              Pick a .apj file
            </UButton>
            <input
              ref="apjFileInput"
              type="file"
              accept=".apj,application/json"
              class="hidden"
              @change="onApjChosen"
            >
          </div>

          <UAlert v-if="apjError" color="warning" class="mt-3" :description="apjError" />

          <div v-if="apj" class="mt-4 space-y-2 text-sm">
            <p class="text-default">
              <span class="text-muted">File:</span>
              <span class="text-default ml-1 font-medium">{{ apjFilename }}</span>
            </p>
            <p class="text-default">
              <span class="text-muted">For:</span>
              <span class="text-default ml-1 font-medium">{{ apj.description }}</span>
              <span class="text-muted ml-1">(board {{ apj.boardId }})</span>
            </p>
            <p v-if="apj.summary" class="text-default">
              <span class="text-muted">Version:</span>
              <span class="text-default ml-1 font-medium">{{ apj.summary }}</span>
            </p>
            <p class="text-default">
              <span class="text-muted">Image:</span>
              <span class="text-default ml-1 font-medium">{{ (apj.imageSize / 1024).toFixed(1) }} KB</span>
            </p>
          </div>
        </UCard>

        <UCard v-if="apj">
          <!-- Normal path: MAVLink connected → reboot-to-bootloader → flash -->
          <div v-if="session.connected && session.hasHeartbeat" class="flex items-start justify-between gap-3">
            <div>
              <h2 class="text-highlighted font-semibold">
                Ready to install
              </h2>
              <p class="text-muted mt-1 text-sm">
                Your drone will restart twice — once into upload mode, then back into normal mode on the new firmware. Don't unplug it until "Done" appears.
              </p>
            </div>
            <UButton
              color="primary"
              icon="i-lucide-download"
              :loading="isRunning"
              :disabled="!canStartUsb"
              @click="startUsbFlash"
            >
              Install firmware
            </UButton>
          </div>

          <!-- Recovery path: no MAVLink session, the FC is presumably
               already in bootloader mode (after a failed flash). Skip
               the reboot dance and let the operator pick the bootloader
               port directly. -->
          <div v-else>
            <div class="flex items-start gap-2">
              <UIcon name="i-lucide-life-buoy" class="text-primary mt-0.5 size-5 shrink-0" />
              <div class="text-sm">
                <h2 class="text-highlighted font-semibold">
                  Drone not connected
                </h2>
                <p class="text-muted mt-1">
                  Plug your drone in and click <em>Connect drone</em> from the Connect screen — then come back here.
                </p>
                <p class="text-default mt-3">
                  Or, if your drone is already in upload mode (e.g. after a failed flash left the bootloader running), flash it directly:
                </p>
              </div>
            </div>
            <div class="mt-3 flex justify-end">
              <UButton
                color="primary"
                icon="i-lucide-life-buoy"
                :loading="isRunning"
                :disabled="!canStartRecovery"
                @click="startRecoveryFlash"
              >
                Connect to bootloader + flash
              </UButton>
            </div>
            <UAlert v-if="recoveryError" color="warning" class="mt-3" :description="recoveryError" />
            <p class="text-muted mt-3 text-xs">
              If neither of these works, try <em>Recovery (DFU mode)</em> instead.
            </p>
          </div>

          <div v-if="phaseLabel" class="mt-4 space-y-2">
            <div class="flex items-center gap-2 text-sm">
              <UIcon v-if="phase === 'done'" name="i-lucide-circle-check" class="text-success size-4" />
              <UIcon v-else-if="phase === 'error'" name="i-lucide-triangle-alert" class="text-warning size-4" />
              <UIcon v-else name="i-lucide-loader-circle" class="text-muted size-4 animate-spin" />
              <span :class="phase === 'done' ? 'text-success font-medium' : 'text-default'">
                {{ phaseLabel }}
              </span>
            </div>
            <UProgress
              v-if="(phase === 'erasing' || phase === 'programming') && progress !== null"
              :model-value="Math.round((progress ?? 0) * 100)"
              color="primary"
              size="sm"
            />

            <!-- Bootloader-port picker. ArduPilot's bootloader enumerates
                 as a different USB device than the firmware on most boards,
                 so the browser needs the operator to pick it the first time
                 (after that it stays authorised + auto-detected). -->
            <div
              v-if="phase === 'awaiting-bootloader-port'"
              class="border-info bg-info/5 rounded-lg border p-3 space-y-2"
            >
              <div class="flex items-start gap-2">
                <UIcon name="i-lucide-mouse-pointer-click" class="text-info mt-0.5 size-5 shrink-0" />
                <div class="flex-1 text-sm">
                  <p class="text-highlighted font-semibold">
                    Pick the upload-mode port
                  </p>
                  <p class="text-muted mt-1">
                    Your drone is now in upload mode but the browser needs you to grant access to that port — it appears as a different USB device than the running firmware. Pick it once and we'll remember it.
                  </p>
                </div>
              </div>
              <div class="flex justify-end gap-2">
                <UButton color="neutral" variant="ghost" size="sm" @click="cancelBootloaderPick">
                  Cancel
                </UButton>
                <UButton color="primary" icon="i-lucide-plug-zap" size="sm" @click="pickBootloaderPort">
                  Pick bootloader port
                </UButton>
              </div>
            </div>
            <UAlert v-if="bootloaderPickError" color="warning" :description="bootloaderPickError" />

            <UAlert v-if="flashError" color="warning" :description="flashError" />
          </div>
        </UCard>
      </template>
    </template>

    <!-- =================== DFU / recovery path ================== -->
    <template v-else>
      <UAlert
        v-if="!webUsbSupported"
        color="warning"
        icon="i-lucide-triangle-alert"
        title="DFU mode needs Chrome or Edge"
        description="Recovery install talks to the chip's bootloader over WebUSB — only available in Chromium-based browsers."
      />

      <template v-else>
        <!-- Step 1: how to enter DFU mode. -->
        <UCard>
          <div class="flex items-start gap-3">
            <UIcon name="i-lucide-life-buoy" class="text-primary mt-1 size-5" />
            <div class="flex-1">
              <h2 class="text-highlighted font-semibold">
                Put your drone in DFU mode
              </h2>
              <p class="text-muted mt-1 text-sm">
                Use this when your drone won't connect normally, or for a fresh
                flight controller with no firmware on it. The chip's own
                bootloader takes over.
              </p>
              <ol class="text-default mt-3 list-decimal space-y-1 pl-5 text-sm">
                <li>Unplug the USB cable from your drone.</li>
                <li>Press and hold the <strong>BOOT</strong> button on the flight controller (check the board pinout if you can't find one).</li>
                <li>While still holding the button, plug the USB cable back in.</li>
                <li>Release the button after a few seconds.</li>
              </ol>
            </div>
          </div>

          <!-- Visual cue: a small illustration that shows the BOOT-then-plug
               sequence. Until we have proper art, an icon + animation
               hints at "hold + plug". -->
          <div class="bg-muted/40 mt-4 flex items-center justify-center gap-3 rounded-lg py-4">
            <UIcon name="i-lucide-circle-dot" class="text-primary size-6" />
            <UIcon name="i-lucide-arrow-right" class="text-muted size-4" />
            <UIcon name="i-lucide-usb" class="text-default size-6 animate-pulse" />
            <UIcon name="i-lucide-arrow-right" class="text-muted size-4" />
            <UIcon name="i-lucide-cpu" class="text-success size-6" />
          </div>
        </UCard>

        <!-- Step 2: pick the file. -->
        <UCard>
          <div class="flex items-start justify-between gap-3">
            <div>
              <h2 class="text-highlighted font-semibold">
                Choose a firmware file
              </h2>
              <p class="text-muted mt-1 text-sm">
                <code class="bg-muted rounded px-1 py-0.5">.apj</code> works for recovery (firmware only). For a fresh / bricked board, use the <code class="bg-muted rounded px-1 py-0.5">_with_bl.hex</code> file SmallFastDrone publishes alongside.
              </p>
            </div>
            <UButton color="primary" icon="i-lucide-file-plus" :disabled="isRunning" @click="openDfuPicker">
              Pick a file
            </UButton>
            <input
              ref="dfuFileInput"
              type="file"
              accept=".apj,.hex,application/json"
              class="hidden"
              @change="onDfuFileChosen"
            >
          </div>

          <UAlert v-if="dfuFileError" color="warning" class="mt-3" :description="dfuFileError" />

          <div v-if="dfuFile?.kind === 'apj'" class="mt-4 space-y-2 text-sm">
            <p>
              <span class="text-muted">File:</span>
              <span class="text-default ml-1 font-medium">{{ dfuFile.filename }}</span>
            </p>
            <p>
              <span class="text-muted">For:</span>
              <span class="text-default ml-1 font-medium">{{ dfuFile.apj.description }}</span>
              <span class="text-muted ml-1">(board {{ dfuFile.apj.boardId }})</span>
            </p>
            <p v-if="dfuFile.apj.summary">
              <span class="text-muted">Version:</span>
              <span class="text-default ml-1 font-medium">{{ dfuFile.apj.summary }}</span>
            </p>
            <p>
              <span class="text-muted">Image:</span>
              <span class="text-default ml-1 font-medium">{{ (dfuFile.apj.imageSize / 1024).toFixed(1) }} KB</span>
            </p>
          </div>

          <div v-else-if="dfuFile?.kind === 'hex'" class="mt-4 space-y-2 text-sm">
            <p>
              <span class="text-muted">File:</span>
              <span class="text-default ml-1 font-medium">{{ dfuFile.filename }}</span>
            </p>
            <p>
              <span class="text-muted">Spans:</span>
              <span class="text-default ml-1 font-medium">
                0x{{ dfuFile.hex.startAddress.toString(16).padStart(8, '0') }}
                – 0x{{ dfuFile.hex.endAddress.toString(16).padStart(8, '0') }}
              </span>
              <span class="text-muted ml-1">({{ dfuFile.hex.segments.length }} segments)</span>
            </p>
            <p>
              <span class="text-muted">Total:</span>
              <span class="text-default ml-1 font-medium">{{ (dfuFile.hex.totalBytes / 1024).toFixed(1) }} KB</span>
            </p>
          </div>
        </UCard>

        <!-- Step 3: device + flash. -->
        <UCard>
          <div class="flex items-start justify-between gap-3">
            <div>
              <h2 class="text-highlighted font-semibold">
                Connect to the bootloader
              </h2>
              <p class="text-muted mt-1 text-sm">
                Once your drone is in DFU mode, pick the device below. If it's not listed, give the browser permission to see it.
              </p>
            </div>
            <UButton
              color="neutral"
              variant="soft"
              icon="i-lucide-plus"
              :disabled="isRunning"
              @click="requestDfuPermission"
            >
              Find DFU device
            </UButton>
          </div>

          <UAlert v-if="dfuPickError" color="warning" class="mt-3" :description="dfuPickError" />

          <div v-if="dfuDevices.length === 0" class="text-muted mt-4 text-sm">
            No DFU devices visible yet. After the steps above, click <em>Find DFU device</em>.
          </div>

          <ul v-else class="mt-4 space-y-2">
            <li
              v-for="(d, i) in dfuDevices"
              :key="i"
              class="bg-muted/30 flex flex-wrap items-center justify-between gap-3 rounded-lg px-3 py-2"
            >
              <div class="flex items-center gap-2 text-sm">
                <UIcon name="i-lucide-cpu" class="text-primary size-4" />
                <span class="text-default font-medium">{{ d.label }}</span>
              </div>
              <div class="flex items-center gap-3">
                <label v-if="dfuFile" class="flex cursor-pointer items-center gap-1.5 text-xs" :title="wipeAllToggleTip">
                  <UIcon name="i-lucide-eraser" class="text-muted size-3.5" />
                  <span class="text-default">Wipe whole chip</span>
                  <USwitch v-model="wipeAll" size="xs" :disabled="isRunning" />
                </label>
                <UButton
                  color="primary"
                  icon="i-lucide-download"
                  :loading="isRunning"
                  :disabled="!canStartDfu"
                  @click="startDfuFlash(d)"
                >
                  Install in DFU mode
                </UButton>
              </div>
            </li>
          </ul>
          <UAlert
            v-if="eraseStrategyWarning"
            color="warning"
            class="mt-3"
            icon="i-lucide-triangle-alert"
            :description="eraseStrategyWarning"
          />

          <div v-if="phaseLabel" class="mt-4 space-y-2">
            <div class="flex items-center gap-2 text-sm">
              <UIcon v-if="phase === 'done'" name="i-lucide-circle-check" class="text-success size-4" />
              <UIcon v-else-if="phase === 'error'" name="i-lucide-triangle-alert" class="text-warning size-4" />
              <UIcon v-else name="i-lucide-loader-circle" class="text-muted size-4 animate-spin" />
              <span :class="phase === 'done' ? 'text-success font-medium' : 'text-default'">
                {{ phaseLabel }}
              </span>
            </div>
            <UProgress
              v-if="(phase === 'erasing' || phase === 'programming') && progress !== null"
              :model-value="Math.round((progress ?? 0) * 100)"
              color="primary"
              size="sm"
            />
            <UAlert v-if="flashError" color="warning" :description="flashError" />
          </div>
        </UCard>
      </template>
    </template>
  </div>
</template>
