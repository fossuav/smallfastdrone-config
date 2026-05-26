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

// Per-board flash layout used by the DFU path when an `.apj` is the
// input. The `.apj` carries only the firmware image (no bootloader,
// no addresses) — we need to know where on the chip to write it, and
// the bootloader path normally takes care of that for us. For DFU we
// go around the bootloader, so we look that metadata up here.
//
// Source of truth: SFD/ArduPilot hwdef:
//   - `APJ_BOARD_ID <NAME>`           — maps the .apj `board_id` int.
//   - `MCU STM32H7xx STM32H743xx`     — chip family (sector size).
//   - `FLASH_SIZE_KB <n>`             — total user flash.
//   - `FLASH_RESERVE_START_KB <n>`    — bootloader region; app starts
//                                       at flash_base + reserve.
//
// All STM32 boards share flash_base = 0x08000000.
//
// v1 covers the SFD primary target (TBS_LUCID_H7-based) plus a small
// set of common AP H7 boards. If an operator hits an unknown board id
// on the DFU/.apj path, we surface "we don't have a flash map for this
// board yet — use the `_with_bl.hex` artefact instead" — that route
// embeds its own addresses and works for any board.
//
// Note: the bootloader-over-USB-serial path does NOT use this map —
// the FC bootloader knows its own layout and we just hand it the image.

export interface BoardFlashLayout {
  // Where on the chip the app image starts. Absolute address (e.g.
  // 0x08020000 for a 128 KB-reserve H7).
  appAddress: number
  // Where all of flash starts. STM32 = 0x08000000 universally; kept
  // explicit so a non-STM target later is a data change, not a code
  // change.
  flashBase: number
  // Total user flash in bytes — used to bounds-check images.
  flashSize: number
  // Operator-facing label so error copy can name the board.
  name: string
}

// Standard STM32 internal-flash base for every board we'd ever target.
const FLASH_BASE_STM32 = 0x08000000

// Board-id → layout map. IDs come from
// `vendor/smallfastdrone/Tools/AP_Bootloader/board_types.txt`. Reserve
// values are the per-board `FLASH_RESERVE_START_KB` (defaults to 16 on
// F4/F7, typically 128 on H7).
const BOARDS: Record<number, BoardFlashLayout> = {
  // --- H7 (SFD primary + common siblings) ---------------------------
  // AP_HW_TBS_LUCID_H7 — SmallFastDronev1's basis. App at +128 KB.
  5250: layout('TBS_LUCID_H7 / SmallFastDronev1', 2048, 128),
  // AP_HW_MATEKH743 — common H7 board. Same layout.
  1013: layout('MatekH743', 2048, 128),
  // AP_HW_CUBEORANGE — 2 MB H7, 128 KB reserve.
  140: layout('CubeOrange', 2048, 128),
  // AP_HW_CUBEORANGEPLUS — same layout.
  1063: layout('CubeOrangePlus', 2048, 128),
}

// Look up a board's flash layout by .apj board_id. Returns `null` if
// we don't have an entry — callers turn that into operator copy
// telling them to use the `_with_bl.hex` artefact instead.
export function lookupBoardFlash(boardId: number): BoardFlashLayout | null {
  return BOARDS[boardId] ?? null
}

// Local helper — keep the BOARDS table dense and readable.
function layout(name: string, flashSizeKb: number, reserveKb: number): BoardFlashLayout {
  return {
    name,
    flashBase: FLASH_BASE_STM32,
    flashSize: flashSizeKb * 1024,
    appAddress: FLASH_BASE_STM32 + reserveKb * 1024,
  }
}
