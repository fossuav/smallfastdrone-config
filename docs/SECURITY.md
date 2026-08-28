# Security Design — SFD enablement

> Read [PLAN.md](../PLAN.md) and [ARCHITECTURE.md](ARCHITECTURE.md) first.
> [FIRMWARE.md](FIRMWARE.md) covers the flashing mechanics this document builds on.

## What this is for

SmallFastDrone's differentiation is not a better ports table — it is that an
SFD drone arrives **enabled**: it configures itself, and it runs applets that
physically cannot run anywhere else. That second half needs a way to ship Lua to
a customer that only *their* drone can decrypt.

This document is the architecture for that. It replaces the earlier "v1 ships
the seam, not the implementation" stance, which assumed the crypto lived
entirely elsewhere and the tool merely avoided precluding it. It doesn't: the
enablement ceremony has no other sensible home, because this tool is already the
thing that flashes firmware, installs Lua, and reads params.

**The tool still contains no cryptography.** It orchestrates ceremonies and
moves opaque blobs. All crypto is on the FC or in SFD's offline build tooling.

## Trust model

Exactly two secrets exist. Everything else — this document, the firmware source,
the file formats, the ceremonies — is public and can be published without
weakening anything.

| Secret | Held by | Protected by |
|---|---|---|
| SFD firmware signing private key | SFD, offline | Key custody (never leaves SFD) |
| SFD applet master secret | SFD, offline | Key custody (never leaves SFD) |
| Per-drone identity private key | The drone, alone | STM32 RDP Level 1 |

The customer's laptop is **untrusted**. This is a topology fact, not a code
fact, and no amount of firmware control changes it. It is the single reason the
drone must generate its own identity key rather than being given one: anything
the configurator writes has passed through the customer's hands.

SFD's source being public (GPLv3) does not weaken this. Someone can fork SFD,
strip the decrypt path, add a plaintext dump, and flash it — to *their* drone. A
`.lxa` is encrypted to a *specific* drone's public key, so their modified
firmware faithfully attempts decryption and gets nothing. The attack fails at
the crypto, not at the firmware gate.

### The trust chain

"Only this drone can decrypt" rests on four links. Break any one and the other
three are worthless.

1. **RDP Level 1** — no debug or DFU readout of the identity private key.
2. **Signed firmware, enforced by the bootloader** — otherwise the customer
   flashes a build that dumps plaintext straight after `luaL_loadbuffer`.
3. **Bootloader sector write-protected** — otherwise they swap in a bootloader
   that skips the check. `AP_CheckFirmware::check_signed_bootloader()` already
   refuses to load an unsigned bootloader onto a keyed board.
4. **Only SFD's key trusted** — otherwise anyone holding an upstream ArduPilot
   signing key can sign firmware this board accepts, collapsing link 2.

Link 4 is a **build-time** property, not a runtime one — see "Key custody"
below. That is what makes the customer-facing ceremony short.

### Accepted risks

- **RDP Level 1 is not a secure element.** Fault-injection attacks against STM32
  readout protection are a documented research area; a lab with glitching gear
  and physical access is a different adversary from a determined customer.
  Accepted by decision: the bar is specialist equipment, which is the right
  level for protecting commercial Lua.
- **RDP Level 2 must never be used.** It is irreversible, it would remove the
  exit ceremony, and it would make the GPL position below indefensible. No code
  path in this tool or in SFD firmware may set it.

## Key custody — build time, not enable time

SFD builds its own bootloaders carrying **only** SFD's public signing key:

```
Tools/scripts/build_bootloaders.py <board> \
    --signing-key sfd_public_key.dat \
    --omit-ardupilot-keys
```

`--omit-ardupilot-keys` already exists upstream. Because the customer installs
that bootloader as part of the `_with_bl.hex` DFU artefact, link 4 holds from
first boot with nothing to add or remove at runtime.

**Consequences, all of them good:**

- `SECURE_COMMAND_SET_PUBLIC_KEYS` and `SECURE_COMMAND_REMOVE_PUBLIC_KEYS` are
  never used in any customer flow. They should be **compiled out** of SFD
  builds — they are attack surface with no remaining purpose.
- The `all_zero_keys() → check_signature() == true` fail-open path (an
  intentional upstream convenience) can never be reached with an empty array,
  because the array is never mutated. It should still be made **fail-closed** on
  SFD builds as belt and braces.
- The customer ceremony reduces to identity generation plus lock, neither of
  which requires a signature from a key the customer would have to hold.

## Per-drone identity

At enable time the drone generates an **X25519 keypair** from the STM32 hardware
TRNG (`hal.util->get_true_random_vals()`), stores the private half in a
dedicated region of `.apsec_data`, and returns only the public half plus its
STM32 UID.

The identity private key lives in its **own region** — *not* a slot in the
`public_key[]` array. Reusing that array would mean:

- `SECURE_COMMAND_GET_PUBLIC_KEYS` `memcpy`s raw slot bytes into a reply and
  would hand the private key out over MAVLink;
- `check_signature()` would treat it as a candidate command-authorising key;
- `set_public_keys()`'s pack-toward-front logic would move it, while
  `encrypt_script()` hard-codes index 3.

A separate region removes all three by construction rather than patching each.

### Drone identity file

The tool exports a small, **non-secret** artefact after enablement:

```json
{
  "schema": "sfd-identity/1",
  "uid": "<STM32 96-bit UID, hex>",
  "public_key": "<32-byte X25519 public key, base64>",
  "board_id": 1063,
  "enabled_at": "2026-08-27T00:00:00Z"
}
```

This is what SFD needs to encrypt applets for that airframe. It contains no
secret and can travel by any channel.

## Applet encryption (`.lxa` v2)

Ephemeral-static ECDH. SFD encrypts to the drone's public key with a throwaway
keypair; only the drone's private key recovers the plaintext.

```
offset  size  field
0       6     magic "LUA2.0"
6       32    ephemeral X25519 public key
38      16    Poly1305 MAC
54      24    nonce  — bytes 0..11 = target STM32 UID, 12..23 derived
78      N     ciphertext (XChaCha20-Poly1305)
```

**Encrypt (SFD, offline):**

```
e_priv  = KDF(sfd_master, drone_pub ‖ applet_id ‖ content_hash)
e_pub   = crypto_x25519_public_key(e_priv)
shared  = crypto_key_exchange(e_priv, drone_pub)
nonce   = drone_uid ‖ KDF(sfd_master, drone_pub ‖ applet_id ‖ content_hash ‖ "n")[0..11]
crypto_lock(mac, ct, shared, nonce, plaintext)
```

**Decrypt (FC):** check magic → check `nonce[0..11]` against this board's own
UID and **reject before any crypto** if it differs → `crypto_key_exchange`
with the identity private key → `crypto_unlock` → `crypto_wipe` the shared
secret.

The UID prefix is a second, independent gate: a `.lxa` copied to another
airframe is refused without decryption even being attempted.

### Why the ephemeral key is derived, not random

Deterministic derivation makes every artefact SFD has ever shipped reproducible
byte-for-byte from the master secret plus the drone identity file, with nothing
stored per file. That gives support, re-issue, and revocation audits ("what
exactly did we ship to drone 47?") without a key database — which matters
because there is no server.

**`content_hash` must be a hash of the applet source, never a hand-maintained
version string.** Both the key and the nonce derive from it. If the source
changed without the identifier changing, the same key would encrypt different
plaintext under the same nonce — catastrophic keystream reuse in XChaCha20.
Deriving from content makes that impossible by construction.

## The enable ceremony

Operator-facing: connect the drone, press **SFD enable**, wait. Everything below
is what the tool does behind that.

| # | Step | Notes |
|---|---|---|
| 1 | Flash SFD firmware (`_with_bl.hex`, DFU) | Bootloader carries only SFD's key. Uses the existing hardware-verified DFU path. |
| 2 | Reconnect on MAVLink | Existing `useReconnect()` |
| 3 | `GET_SESSION_KEY` | Opens the secure-command session |
| 4 | `GENERATE_IDENTITY` | Drone makes its keypair, stores the private half, returns UID + public key. Refused if an identity already exists. |
| 5 | **Verify** — read the identity back | Must succeed before step 6. Never lock a drone whose identity is unconfirmed. |
| 6 | Export identity file | Operator saves it; this is what reaches SFD |
| 7 | Set the lock bit in `BRD_OPTIONS` | Firmware raises RDP on next boot |
| 8 | Reboot, confirm locked state | Tool reports "SFD enabled" |

**Ordering is load-bearing.** Identity must exist and be verified before the
lock. Locking first strands the drone — recoverable only via the exit ceremony,
but that is a wipe the customer did not ask for. The firmware must enforce this
ordering too; a tool-side check protects only against our own tool.

## The exit ceremony

Non-negotiable and must be as polished as the enable path. It is both the
customer's escape hatch and, as far as I can tell, the GPL answer below.

The silicon dictates the shape: **RDP 1→0 triggers a mass erase.** That is not a
choice we make. Seamlessness has to come from what we save and restore around
it.

| # | Step | Notes |
|---|---|---|
| 1 | **Back up params** | Full snapshot to disk. Non-negotiable — everything after this is destructive. |
| 2 | Unlock | `stm32_flash_set_rdp_flash(0xAA)` — see two routes below |
| 3 | Mass erase (automatic) | Silicon. Destroys firmware, bootloader, **and the identity key**. |
| 4 | DFU flash vanilla SFD `_with_bl.hex` | Chip is blank including the bootloader, so this is the DFU path, not the serial bootloader path |
| 5 | Restore params | With an explicit report of anything that did not survive |

**Two unlock routes, and we need both:**

- **Firmware-initiated** — a `BRD_OPTIONS` bit acting on next boot, the same
  shape the flash write-protection options already use. Convenient, and an
  ordinary parameter rather than a custom command. Requires a drone that
  still boots and still talks.
- **DFU read-unprotect** — the DfuSe `READ_UNPROTECT` command (`0x92`), which
  asks the ST bootloader to drop RDP itself. Works on a drone that will not
  boot, which makes it the real get-out-of-jail card — and that is the case
  you are usually in when you need to unlock at all, so the parameter route
  above cannot replace it.

  Deliberately **not** an option-byte write. Programming the RDP field by hand
  means getting a chip-specific register offset right, and writing `0xCC` there
  sets Level 2 — irreversible, and the board is scrap. Handing the request to
  the bootloader means that value is never encoded anywhere in this codebase.

  Note the inverted success condition: the bootloader resets itself the moment
  the transition completes, so the final status read is *expected* to fail. A
  device that answers did **not** unprotect.

The unlock **must not** require an SFD signature. The customer must be able to
exit unaided — that is what makes it an escape hatch rather than a hostage
situation, and it is the crux of the GPL position. It is not an information
disclosure: it erases everything, including the key it would otherwise expose.

**The identity dies with the erase**, so re-enabling produces a *new* keypair and
SFD re-issues that customer's applets against the new public key. This is
inherent to drone-generated keys. The alternative — keys that survive the wipe —
is exactly the design that lets the customer decrypt.

### Why this ordering is the security property

There is no state in which the customer holds both an unlocked chip and a live
identity key. Extracting the key requires running modified firmware, which
requires lowering RDP, which mass-erases the key first. That ordering is
enforced by hardware, not by us, which is precisely why it can be trusted.

## GPLv3 position

ArduPilot is GPLv3, and §6's anti-tivoization provision requires that for "User
Products", conveying object code in hardware that refuses user-modified builds
obliges you to provide Installation Information. A locked bootloader accepting
only signed firmware is squarely the shape that clause addresses.

The exit ceremony appears to be the answer: the customer **can** install modified
GPL firmware on hardware they own — unlock, wipe, flash whatever they like. What
they lose is the commercial applets, because the identity key dies with the
erase. That is a restriction on the commercial content, not on their freedom to
modify the GPL firmware.

**This is an engineering reading, not a legal opinion, and it should be checked
by someone qualified before a product line depends on it.** It is cheap to check
now and expensive to discover later.

## Division of responsibility

| Concern | Where | Why |
|---|---|---|
| Identity keygen, ECDH, decrypt | SFD firmware | Only place the private key may exist |
| RDP raise / lower | SFD firmware + DfuSe `READ_UNPROTECT` | Needs privileged flash access |
| Ceremony orchestration, param backup/restore, UX | This tool | Already owns flashing, Lua install, params |
| Applet encryption, key custody | SFD offline build tooling | Master secret must never ship |

**This tool holds no key material and performs no cryptography.** If that ever
stops being true, it is a design regression, not a feature.

## Firmware work list

Companion to this document, to land on the `pr-lua-encryption` branch in
`../smallfastdrone/`. Ordered by dependency, not priority.

| # | Change | Where | Notes |
|---|---|---|---|
| F1 | Dedicated identity region in `.apsec_data` | `AP_CheckFirmware/AP_CheckFirmware.{h,cpp}` — `struct ap_secure_data`, and the `.apsec_data` section attribute | Write-once; never returned by any MAVLink command; excluded from `check_signature()`'s loop; not subject to `set_public_keys()`'s pack-toward-front. **Do this first** — F4 and F5 both build on it, and it closes a live disclosure hole today. |
| F2 | Compile out `SET_PUBLIC_KEYS` / `REMOVE_PUBLIC_KEYS` on SFD builds | `AP_CheckFirmware/AP_CheckFirmware_secure_command.cpp` — the `SECURE_COMMAND_OP` switch | Unused once keys are build-time (decision 33); pure attack surface. |
| F3 | Fail closed on an empty key array | same file — `all_zero_keys()` and its use in `check_signature()` | `all_zero_keys() → check_signature() == true` is a sensible convenience for stock ArduPilot and exactly wrong for us. Make the posture compile-time. |
| F4 | New secure commands: `GENERATE_IDENTITY`, `GET_IDENTITY` | same file | Identity only — lock/unlock are `BRD_OPTIONS` bits, not commands (F6). `GENERATE_IDENTITY` refused when an identity already exists, so re-running enable can't silently orphan a customer's applets. |
| F5 | `.lxa` v2 loader — ECDH + UID prefix check | `AP_Scripting/lua_scripts.cpp` — `load_encrypted_script()`, `decrypt_script()` | Replaces the symmetric slot-3 path. Check the nonce's UID prefix *before* attempting decryption, so a file for another airframe is refused cheaply. |
| F6 | RDP as `BRD_OPTIONS` bits, acting on next boot | `AP_BoardConfig/AP_BoardConfig.cpp` (the `OPTIONS` bitmask), `AP_HAL_ChibiOS/HAL_ChibiOS_Class.cpp` (`main_loop()`), `hwdef/common/flash.c` (`stm32_flash_set_rdp_flash`) | Currently unconditional from `main_loop()` when `HAL_FLASH_READOUT_PROTECTION` is compiled in, which breaks the pattern the adjacent write-protection options already follow (bits 4/5/6 → `unlock_flash()` / `protect_bootloader()`). Use free bits (10+). Lock must refuse when no verified identity exists. **Open:** one bit or two — one bit makes clearing it a mass erase an operator could reach by "undoing" something. **Unlock caveat:** `flash.c` has no `__RAMFUNC__`, so `stm32_flash_set_rdp_flash(0xAA)` runs from the flash the regression is erasing; upstream ships that call commented out, i.e. unexercised. Likely wants to be a RAM function, and wants bench verification. |
| F7 | Bootloader-side invariants | bootloader build of `AP_CheckFirmware` | Keys never emptied; RDP raise-only except through the deliberate unlock path; identity write-once unless the chip has been erased. Invariants held in the bootloader survive a buggy or hostile configurator; tool-side guards don't. |
| F8 | Fix `create_nonce()` | `AP_Scripting/lua_scripts.cpp` — `create_nonce()` | Called on the *decrypt* path, where it overwrites the nonce read from the file; and `nonce_len` goes into `get_system_id_unformatted(buf, len)` uninitialised, where `len` is in/out (see `GCS_Common.cpp` for the correct pattern). Keep the file's nonce and *verify* its prefix. |
| F9 | Confirm x25519 isn't compiled out of the FC monocypher build | `AP_CheckFirmware/monocypher.{h,cpp}` | `crypto_key_exchange` / `crypto_x25519` are declared; check they survive the build's feature trimming before F5 depends on them. |
| F10 | Optional: re-key `SCR_LD_ENCRYPT` | `AP_Scripting/lua_scripts.cpp` — `encrypt_all_scripts_in_dir()` | On-FC self-encryption still has value for a customer's *own* scripts, but under v2 it must ECDH to the drone's own public key. Low priority. |

**Bootloader changes get bench-verified on real hardware every time, not just
SITL.** It is the one component where a bug bricks boards with no recovery
except BOOT0 + DFU. Our DFU path being hardware-verified is what makes that
survivable.

Note that F1–F7 are permanent fork deltas that cannot be upstreamed — SFD-specific
lockdown is the whole point. `AP_CheckFirmware` is small and stable, so the
rebase burden is low.

## Tool work list

| # | Module | Purpose |
|---|---|---|
| T1 | `src/protocol/secure-command.ts` | `SECURE_COMMAND` client — session key, sequencing, reply handling. Blocked on F4. |
| T2 | `src/workflow/sfd-enable.ts` | Enable ceremony orchestrator. Blocked on F1/F4/F6. |
| T3 | `src/workflow/sfd-recover.ts` | Exit ceremony — backup → unlock → flash → restore. The unlock and the backup/restore halves both exist; this is the piece that sequences them. |
| T4 | `DfuClient.readUnprotect()` | ✅ Landed. DfuSe `READ_UNPROTECT` for RDP regression on a dead drone, surfaced in the Firmware view's recovery tab. Bench verification pending — no SITL substitute for DFU. |
| T5 | `src/workflow/param-backup.ts` + `src/protocol/param-pack.ts` | ✅ Landed. Delta backup (changed-from-default, minus read-only) + restore planning with the not-reverted report. Defaults come from the drone via `@PARAM/param.pck?withdefaults=1`. |
| T6 | `src/workflow/drone-identity.ts` | Identity file read/write/export. Blocked on F4. |
| T7 | Views | SFD-enable and recovery wizards, both bringup-ribbon mountable. Blocked on T1–T3. |

Encrypted applet install routes through the existing seam as
`kind: 'lua_script'` — the tool moves an opaque blob and never inspects it.

## The upload seam

`src/security/uploader.ts` — unchanged in shape, and now genuinely load-bearing
rather than aspirational:

```ts
interface SignedArtifactUploader {
  requires_signature: (kind: ArtifactKind) => Promise<boolean>
  upload: (kind: ArtifactKind, bytes: Uint8Array, opts?: UploadOpts) => Promise<UploadResult>
}

type ArtifactKind = 'firmware' | 'lua_script' | 'mission' | 'param_blob' | 'esc_firmware'
```

Every upload from the tool to the FC (or to an ESC via the FC) goes through
this. UI never calls `protocol/files.ts`, `protocol/dfu.ts`, or
`protocol/fourway.ts` upload primitives directly.

## Logs

Encrypted log retrieval remains future work. The Phase 4 download path **must
not** assume cleartext-only — design the pipeline to allow a
`decrypt(bytes) → bytes` step in the middle, even though v1 ships without one.

## What contributors must NOT do

- **Don't put key material in this tool.** No master secrets, no signing keys,
  no per-drone keys. The tool orchestrates; it never holds.
- **Don't add a `SET_PUBLIC_KEYS` path to the customer flow.** Key custody is
  build-time. If you find yourself needing runtime key installation, the design
  has drifted — raise it.
- **Don't make the exit ceremony require an SFD signature.** It is the customer's
  escape hatch and the GPL position depends on it.
- **Don't set RDP Level 2.** Irreversible; removes the exit ceremony entirely.
- **Don't lock a drone before its identity is verified.**
- **Don't add direct firmware-upload paths in UI components or views.** DFU is no
  exception — `protocol/dfu.ts` exposes the primitive; `security/uploader.ts` is
  the only legitimate caller.
- **Don't add direct ESC-firmware-flash paths.** The 4-way `flash` primitive is
  only callable via `security/uploader.ts` with `kind: 'esc_firmware'`.
- **Don't bake cleartext-only assumptions into the log pipeline.**
- **Don't introduce a backend service** "to handle key exchange" without a
  PLAN.md decision. The design is deliberately serverless.
- **Don't import a competing crypto library.** If client-side crypto ever proves
  necessary (it should not), use the Web Crypto API.
- **Don't re-enable `string.dump` or the `debug`/`os`/`package` Lua libraries.**
  They are already disabled in `linit.c` and `lstrlib.c`; that is what stops a
  customer's own script extracting bytecode from a Pro applet sharing the
  `lua_State`. Worth a regression test.
