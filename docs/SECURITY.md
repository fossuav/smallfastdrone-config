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
  never used in any customer flow. They are **compiled out** of SFD builds (F2)
  — attack surface with no remaining purpose.
- The `all_zero_keys() → check_signature() == true` fail-open path (an
  intentional upstream convenience) can never be reached with an empty array,
  because the array is never mutated. It is **fail-closed** on SFD builds
  anyway (F3), as belt and braces.
- The customer ceremony reduces to identity generation plus lock, neither of
  which requires a signature from a key the customer would have to hold.

Both are governed by one compile-time posture, **`AP_CHECK_FIRMWARE_FIXED_KEYS`**
(`AP_CheckFirmware_config.h`, default 0), which `SmallFastDronev1/hwdef.dat`
sets to 1 so a product build cannot forget it. It only has an effect on
`--signed-fw` builds; unsigned builds compile none of the command handling.
`AP_CHECK_FIRMWARE_IDENTITY_ENABLED` (the identity commands, F4) follows it.

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

**As landed (F1):** `struct ap_identity_data { sig[8]; private_key[32] }` is
the last member of `ap_secure_data`, after `public_key[10]`. Last matters:
`make_secure_bl.py` patches keys in place straight after the key signature, and
`set_public_keys()` / `check_signature()` / `GET_PUBLIC_KEYS` are all bounded by
`AP_PUBLIC_KEY_MAX_KEYS`, so none of them can reach it. The region carries its
**own 8-byte signature**, which `find_identity()` verifies — without it, on a
bootloader built before the region existed, the bytes at that offset would be
code and read as a non-zero "identity". All-zero means no identity has been
written; `set_identity()` is write-once and rejects a zero key, so a second
enable cannot silently orphan applets encrypted to the first key.

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
| 1 | Flash SFD firmware + its bootloader | Two routes, below. Bootloader carries SFD's key. |
| 2 | Reconnect on MAVLink | Existing `useReconnect()` |
| 3 | `GENERATE_IDENTITY` | Drone makes its keypair from the hardware TRNG, stores the private half, replies with UID + public key derived from what it just wrote. Denied while armed or if an identity already exists — the latter is not an error for the tool: fall through to step 4. No session key, no signature (see below). |
| 4 | **Verify** — `GET_IDENTITY`, a fresh read | Must succeed and match step 3 before step 6. Never lock a drone whose identity is unconfirmed. |
| 5 | Export identity file | Operator saves it; this is what reaches SFD |
| 6 | Set the lock bit in `BRD_OPTIONS` | Firmware raises RDP on next boot |
| 7 | Reboot, confirm locked state | Tool reports "SFD enabled" |

### Step 1 has two routes, and the serial one is the upgrade path

A **blank or bricked** board takes the DFU route: `_with_bl.hex` over WebUSB,
bootloader and firmware in one image. That is the existing hardware-verified
path and it is what recovery uses.

A board **already running ArduPilot** — the upgrade case, and the common one —
does not need DFU at all:

1. Flash the signed SFD `.apj` over the existing bootloader, the ordinary
   serial path. Any ArduPilot bootloader accepts it: a stock one holds no keys
   and `check_good_firmware()` fail-opens on an empty key set.
2. Ask the running firmware to flash the secure bootloader it carries in ROMFS:
   `MAV_CMD_FLASH_BOOTLOADER` with the magic `290876` in `param5`. The
   firmware's ROMFS bootloader is whatever `Tools/bootloaders/<board>_bl.bin`
   held at build time, so a build made after `build_bootloaders.py --signing-key`
   carries the secure one.

This matters because it is the difference between "plug in and press a button"
and "install DFU drivers". **Both steps are now in the tool**: step 1 via
`BootloaderClient`, step 2 via `flashRomfsBootloader()` in
`src/workflow/bootloader-update.ts`. Neither has a view yet — the enable
ceremony (T7) is where step 2 belongs.

Two things about step 2 that cost time to learn, so they are written down:

- **Leaving the bootloader needs the bootloader's own protocol.** Rebooting
  *into* it sets the hold flag, and it does not speak MAVLink, so a MAVLink
  reboot strands the board there until it is power-cycled.
- **`ACCEPTED` does not mean bytes were written.** ArduPilot maps `NO_CHANGE`
  to `ACCEPTED` so an operator isn't shown an error for a no-op. The drone
  says `"Bootloader up-to-date"` in text, and a refusal likewise explains
  itself only in text (`"Bootloader not signed"`), never in the result code.

`check_signed_bootloader()` guards the obvious footgun: a board that already
has keys refuses to flash a bootloader without any, so a secure build cannot
accidentally install an insecure bootloader from its own ROMFS.

**Verified on the bench 2026-09-04**, TBS_LUCID_H7 running vanilla ArduCopter
4.8.0-dev → signed SmallFastDronev1 4.7.0-beta via step 1, written and verified
in 25.8 s by the tool's own `BootloaderClient`; then step 2, after which the
board reports its bootloader as **`TBS_LUCID_H7-Secure-BL-v10`** and the signed
firmware still boots under it. `SmallFastDronev1` is
`include ../TBS_LUCID_H7/hwdef.dat` plus `USE_BOOTLOADER_FROM_BOARD`, so the
product board and a Lucid H7 are the same silicon — a plain `TBS_LUCID_H7`
build would *not* carry the identity commands, since `AP_CHECK_FIRMWARE_FIXED_KEYS`
is set only in the SmallFastDronev1 hwdef.

### The state between the two steps is a real state, and the tool misreads it

After step 1 but before step 2 the drone runs signed SFD firmware on a
bootloader with no `.apsec_data` region. Measured in that state:

| Probe | Result |
|---|---|
| `GET_SESSION_KEY` (upstream op 0) | `DENIED` — the handler is compiled in (`AP_SIGNED_FIRMWARE`) and F3's empty-key-set fail-closed bites |
| `GET_IDENTITY` | `FAILED` — F4 dispatches; `find_identity()` finds no region |
| `GENERATE_IDENTITY` | `FAILED`, with `"Failed to find identity signature"`. `set_identity()` locates the region by signature and refuses before it ever calls `write_bootloader()`, so this is safe to attempt |

**Fixed 2026-09-04, in the firmware.** `GET_IDENTITY` is SFD's own command, so
rather than inferring the difference tool-side it now *states* it: a failed read
returns one byte of reply data, `AP_IDENTITY_STATUS_NOT_SET` (region present,
generate into it) or `AP_IDENTITY_STATUS_NO_REGION` (bootloader predates the
region, update it). Firmware without the change sends no data, which the tool
still reads as an empty region, so nothing that already exists regresses.

The tool acts on it: `getIdentity()` keeps returning `null` for NOT_SET and
throws for NO_REGION, and the ceremony gained a **`no-region`** reason checked
*before* `unsupported` — a drone with no region is running SFD firmware and
answers normally, so sweeping it into "isn't running SFD secure firmware" would
tell the operator to reinstall what they already have.

Before the fix the ceremony read `FAILED` as "no identity yet", generated,
failed, and dead-ended the operator with "The drone couldn't complete the
identity operation." — a dead end for a situation with an obvious next step.

### The padlock in the UI, and what it claims

A connected drone gets one `GET_IDENTITY` read on connect, and its four
possible answers are four different things to tell an operator
(`src/workflow/drone-security.ts`): silence means an unsigned build, `NO_REGION`
means signed firmware on startup software too old to hold an identity,
`NOT_SET` means secured startup software with no identity yet, and a 44-byte
reply means the drone has its own identity.

**The padlock claims what the drone is running, never what it would refuse.**
The identity region exists only in a bootloader built as a signed one from the
SFD tree, so seeing it does establish the startup software is SFD's secured
build. It does *not* establish that the bootloader carries public keys and
would therefore reject unsigned firmware — asking that means `GET_PUBLIC_KEYS`,
which needs a signature by a bootloader key, and decision 10 says the tool holds
none. A unit test pins the copy against ever promising otherwise.

The badge is deliberately quiet: absent entirely on an ordinary drone rather
than a crossed-out lock declaring a perfectly good ArduPilot board "not
secure". The one unsecured state it does show is the part-way-upgraded one,
because that is the only one with a next step the operator can take.

### Telling whether a secure bootloader is installed

Harder than it looks, and worth writing down because the first two attempts
were wrong. `GET_IDENTITY` can't answer it (blank region and missing region
both reply `FAILED`). No other secure command can either: they all require a
signature the tool deliberately doesn't hold, so they all reply `DENIED`
whatever the key set — `GET_SESSION_KEY` included, since it is
signature-required upstream despite being the first step of the signed
protocol.

What does work is the bootloader's **USB product string**, which a secure
build marks: `TBS_LUCID_H7-Secure-BL-v10`. On Windows read the *bus-reported
device description* (`DEVPKEY_Device_BusReportedDeviceDesc`), not the friendly
name — the friendly name stays "ArduPilot" and pyserial's `product` is empty
there, which is how a first check reported a false negative.

### DFU entry is refused on signed firmware — but the tool never used it

`GCS_Common.cpp` refuses a MAVLink DFU-entry request under `#if AP_SIGNED_FIRMWARE`
(`"Refusing DFU for secure firmware"`, `MAV_RESULT_FAILED`) — confirmed on the
bench. Note the request sits behind a magic guard (`param1=42, param2=24,
param3=71, param4=99`); sent without it you get `UNSUPPORTED` and learn nothing.

This does **not** affect the tool: its DFU tab has always required the operator
to put the board into DFU by hand, so it never sends that command. The
practical consequence is for the operator, not the code — on an SFD board, DFU
means the physical BOOT0 pads, and that is the last-resort recovery once a
secure bootloader is on.

### Why the identity commands are unsigned

Upstream `SECURE_COMMAND` requires every operation to be signed by a private key
matching one of the bootloader's public keys. On an SFD build the only such key
is SFD's, and the tool must not hold it (decision 10). So `GENERATE_IDENTITY`
and `GET_IDENTITY` bypass `check_signature()` **by design**, and need no
`GET_SESSION_KEY` first. That costs nothing: generation is write-once and its
reply is public data; a stranger with link access to a fresh drone who
"pre-empts" generation has produced exactly the identity the customer would
have — the private half never leaves the chip either way. Every other operation
(`GET_PUBLIC_KEYS`, `GET_SESSION_KEY`, …) stays signed; on a fixed-key build
that means SFD-only.

Wire details, as landed (F4):

- Operations are **vendor-private numbers**, not additions to the MAVLink XML:
  `GENERATE_IDENTITY = 0x53464401`, `GET_IDENTITY = 0x53464402` ("SFD" + n),
  clear of the `SECURE_COMMAND_OP` enum (0–7). `data_length` and `sig_length`
  are both 0.
- Both reply with `data_length = 44`: bytes 0–11 the STM32 UID (the same bytes
  the `.lxa` v2 nonce prefix must match), bytes 12–43 the X25519 public key.
  The public half is never stored — it is derived from the private key in flash
  on each call, so the two cannot disagree, and a `GENERATE` reply is therefore
  already a read-back of what landed in flash.
- Results: `ACCEPTED`; `DENIED` = armed or identity already exists;
  `FAILED` = no identity to return / RNG or flash failure; `UNSUPPORTED` =
  firmware without the identity commands.
- `Tools/scripts/signing/sfd_identity.py` in the firmware repo is the bench and
  factory counterpart of the tool's ceremony — read, `--generate`, read back,
  compare, write the `sfd-identity/1` file. pymavlink only, no key material.

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

Companion to this document, landing on the **`SmallFastDrone-4.7-config`**
branch in `../smallfastdrone/` (origin `fossuav/smallfastdrone`) — that is
`pr-lua-encryption` rebased onto the 4.7 beta line plus the BLHeli-in-SITL
enablement, and it is the branch the `vendor/smallfastdrone/` submodule tracks.
Ordered by dependency, not priority. **Status 2026-09-04:** F1–F4 and F9 landed and are now **bench-verified on a TBS_LUCID_H7** running a signed SmallFastDronev1 build on a signed bootloader — the drone generated its identity, refused to generate a second, and returned the same public key after a reboot. F5–F8 and F10 remain open.

| # | Change | Where | Notes |
|---|---|---|---|
| F1 | Dedicated identity region in `.apsec_data` | `AP_CheckFirmware/AP_CheckFirmware.h` — `struct ap_identity_data`, last member of `ap_secure_data`; accessors in `AP_CheckFirmware_secure_command.cpp` | ✅ **Landed 2026-08-28** (`AP_CheckFirmware: add a per-drone identity region to the secure data`). `find_identity()` (nullptr on a bootloader without the region), `identity_is_set()`, write-once `set_identity()` that rewrites the bootloader sector through the existing `read_bootloader()` / `write_bootloader()` path and wipes its RAM copy after. Never returned by any MAVLink command; excluded from `check_signature()` and `set_public_keys()` by construction (see "Per-drone identity"). Compile-verified on a signed TBS_LUCID_H7 bootloader + signed SmallFastDronev1 firmware, and the built image checked byte-for-byte: region present and zero, untouched by `make_secure_bl.py --omit-ardupilot-keys`. **Bench-verified 2026-09-04:** `set_identity()` wrote the key into the bootloader sector and it survived a reboot unchanged, so the region is real flash and not RAM. |
| F2 | Compile out `SET_PUBLIC_KEYS` / `REMOVE_PUBLIC_KEYS` on SFD builds | `AP_CheckFirmware/AP_CheckFirmware_secure_command.cpp` — the `SECURE_COMMAND_OP` switch | ✅ **Landed 2026-08-28** (`AP_CheckFirmware: compile out MAVLink key management on fixed-key builds`). Under `AP_CHECK_FIRMWARE_FIXED_KEYS` both operations and `set_public_keys()` itself — the only writer of `public_key[]` — are gone; `read_bootloader()` / `write_bootloader()` remain for the identity region. Confirmed absent from the SmallFastDronev1 ELF. |
| F3 | Fail closed on an empty key array | same file — `all_zero_keys()` and its use in `check_signature()` | ✅ **Landed 2026-08-28** (`AP_CheckFirmware: fail closed on an empty key set when keys are fixed`). `check_signature()` returns false on an all-zero set under the same define. The bootloader's own `all_zero_public_keys()` fail-open in `check_good_firmware()` is untouched here — that is F7, and a bootloader change. |
| F4 | New secure commands: `GENERATE_IDENTITY`, `GET_IDENTITY` | same file | ✅ **Landed 2026-08-28** (`AP_CheckFirmware: add GENERATE_IDENTITY and GET_IDENTITY secure commands`). Identity only — lock/unlock are `BRD_OPTIONS` bits, not commands (F6). Generate: `hal.util->get_true_random_vals()` (100 ms timeout), X25519 clamp, `set_identity()` (write-once from F1), `crypto_wipe` the stack copy; denied while armed. Get: UID + `crypto_x25519_public_key()` of the key in flash. Both **unsigned** — see "Why the identity commands are unsigned". Gated by `AP_CHECK_FIRMWARE_IDENTITY_ENABLED`. **Bench-verified 2026-09-04** against a TBS_LUCID_H7 running a signed bootloader + signed SmallFastDronev1 build, driven through the tool's own `runEnableCeremony()` rather than the Python probe: generate returned UID + public key, a second generate was `DENIED` (write-once holds), and a read after reboot returned the same key. |
| F5 | `.lxa` v2 loader — ECDH + UID prefix check | `AP_Scripting/lua_scripts.cpp` — `load_encrypted_script()`, `decrypt_script()` | Replaces the symmetric slot-3 path. Check the nonce's UID prefix *before* attempting decryption, so a file for another airframe is refused cheaply. |
| F6 | RDP as `BRD_OPTIONS` bits, acting on next boot | `AP_BoardConfig/AP_BoardConfig.cpp` (the `OPTIONS` bitmask), `AP_HAL_ChibiOS/HAL_ChibiOS_Class.cpp` (`main_loop()`), `hwdef/common/flash.c` (`stm32_flash_set_rdp_flash`) | Currently unconditional from `main_loop()` when `HAL_FLASH_READOUT_PROTECTION` is compiled in, which breaks the pattern the adjacent write-protection options already follow (bits 4/5/6 → `unlock_flash()` / `protect_bootloader()`). Use free bits (10+). Lock must refuse when no verified identity exists. **Open:** one bit or two — one bit makes clearing it a mass erase an operator could reach by "undoing" something. **Unlock caveat:** `flash.c` has no `__RAMFUNC__`, so `stm32_flash_set_rdp_flash(0xAA)` runs from the flash the regression is erasing; upstream ships that call commented out, i.e. unexercised. Likely wants to be a RAM function, and wants bench verification. |
| F7 | Bootloader-side invariants | bootloader build of `AP_CheckFirmware` | Keys never emptied; RDP raise-only except through the deliberate unlock path; identity write-once unless the chip has been erased. Invariants held in the bootloader survive a buggy or hostile configurator; tool-side guards don't. |
| F8 | Fix `create_nonce()` | `AP_Scripting/lua_scripts.cpp` — `create_nonce()` | Called on the *decrypt* path, where it overwrites the nonce read from the file; and `nonce_len` goes into `get_system_id_unformatted(buf, len)` uninitialised, where `len` is in/out (see `GCS_Common.cpp` for the correct pattern). Keep the file's nonce and *verify* its prefix. |
| F9 | Confirm x25519 isn't compiled out of the FC monocypher build | `AP_CheckFirmware/monocypher.{h,cpp}` | ✅ **Resolved 2026-08-28.** Nothing trims it — the only conditionals in `monocypher.cpp` are BLAKE2 unrolling and Argon2. It was merely linker-GC'd for lack of a caller; F4's `crypto_x25519_public_key()` now links (`nm` on the SmallFastDronev1 ELF shows it). F5 can rely on `crypto_key_exchange`. |
| F10 | Optional: re-key `SCR_LD_ENCRYPT` | `AP_Scripting/lua_scripts.cpp` — `encrypt_all_scripts_in_dir()` | On-FC self-encryption still has value for a customer's *own* scripts, but under v2 it must ECDH to the drone's own public key. Low priority. |

**Bootloader changes get bench-verified on real hardware every time, not just
SITL.** It is the one component where a bug bricks boards with no recovery
except BOOT0 + DFU. Our DFU path being hardware-verified is what makes that
survivable.

Note that F1–F7 are permanent fork deltas that cannot be upstreamed — SFD-specific
lockdown is the whole point. `AP_CheckFirmware` is small and stable, so the
rebase burden is low.

## Tool work list

**Status 2026-09-04:** T1, T4, T5, T6 landed, T2's identity half landed, and **T7's enable wizard has landed and run against a real drone**; T3 (exit ceremony), the recovery wizard and the lock step remain open.

| # | Module | Purpose |
|---|---|---|
| T1 | `src/protocol/secure-command.ts` | ✅ **Landed 2026-08-28.** `SecureCommandClient` (same `send` / `subscribe` / sysid / compid shape as `MavFtp`): `getIdentity()` → identity or `null` when the drone has none (the firmware answers FAILED to a blank region); `generateIdentity()` → the identity the drone read back after writing; generic `request(op, data, timeoutMs)` for anything else. Unsigned and sessionless — `sig_length = 0`, no `GET_SESSION_KEY` — so it holds no key material. Replies matched on `sequence` + `operation`; the sequence starts random so a stale reply from an earlier session can't match. Non-ACCEPTED verdicts, timeouts and malformed replies all surface as `SecureCommandError` with the drone's `result` (DENIED / UNSUPPORTED / FAILED, or `null` for no verdict) so the enable workflow can branch without string-matching; a timeout is also what a non-signed firmware looks like, since it never answers. 15 s allowance on GENERATE for the sector rewrite. 14 unit tests against a fake link (`test/unit/secure-command.spec.ts`); not SITL-testable — the handler exists only in signed builds — so bench is the integration test. |
| T2 | `src/workflow/sfd-enable.ts` + `use-sfd-enable.ts` | ✅ **Identity half landed 2026-08-28** (steps 3–5): `runEnableCeremony(client, ctx, onPhase)` is pure — drone behind an `IdentityClient` interface, time injected — and unit-tested (13 cases); `useSfdEnable()` wires it to the session store for a view. Flow: read → generate if absent (a DENIED generate followed by a successful read is "it already has one", not an error; DENIED with still nothing to read is "armed") → **verify by a fresh read** that must byte-match and whose uid must be a prefix of the session's `fcUid` → build the file. Stops with a typed `EnableError` reason — `unsupported` (UNSUPPORTED or no answer at all, which is what non-SFD firmware looks like), `armed`, `mismatch` ("don't lock this drone"), `failed` — and never yields a file when it stops. **Not here:** the flash (step 1, the Firmware view) and the **lock (steps 6–7), which waits on F6**; it will attach to a completed `EnableOutcome`, never run inside the ceremony, so the ordering stays the security property. |
| T3 | `src/workflow/sfd-recover.ts` | Exit ceremony — backup → unlock → flash → restore. The unlock and the backup/restore halves both exist; this is the piece that sequences them. |
| T4 | `DfuClient.readUnprotect()` | ✅ Landed. DfuSe `READ_UNPROTECT` for RDP regression on a dead drone, surfaced in the Firmware view's recovery tab. Bench verification pending — no SITL substitute for DFU. |
| T5 | `src/workflow/param-backup.ts` + `src/protocol/param-pack.ts` | ✅ Landed. Delta backup (changed-from-default, minus read-only) + restore planning with the not-reverted report. Defaults come from the drone via `@PARAM/param.pck?withdefaults=1`. |
| T6 | `src/workflow/drone-identity.ts` | ✅ **Landed 2026-08-28.** The `sfd-identity/1` document: `buildIdentityFile` / `serializeIdentityFile` / `parseIdentityFile` (operator-readable rejections, uid normalised to lower case) / `identityFromFile` / `sameIdentity` / `identityMatchesFc` / `identityFilename`. Snake_case fields because the firmware repo's `sfd_identity.py` writes the same file and SFD's Python tooling reads it — one of the 15 unit tests parses the probe's output verbatim. `board_id` comes from a new `boardId` on the session store (`AUTOPILOT_VERSION.board_version >> 16`). |
| T7 | Views | ✅ **Enable wizard landed 2026-09-04** — `src/wizards/sfd-enable/`, category `safety`, in the wizard library **and** as the last tab of the bringup ribbon. It is an **optional** ribbon area: bringup's completion gate counts required areas only, because most drones cannot be secured at all and gating on it would mean an ordinary ArduPilot drone could never finish bringup. It branches on `session.securityPosture`, so it *tells* the operator which situation they are in instead of offering a button that cannot work — ordinary ArduPilot sends them to the Firmware page, a part-way-upgraded drone gets an **Update startup software** button that drives `flashRomfsBootloader()` in place (the first UI for it), a ready drone gets one button, and a drone that already has an identity gets its file again. The lock is shown as "still to come" rather than pretended at. The visual is the identity itself — a mark derived from the drone's own public key plus a short fingerprint, so an operator can check a saved file belongs to the drone in front of them. **Recovery wizard still waits on T3.** |

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
- **Don't make `GENERATE_IDENTITY` or `GET_IDENTITY` require a signature.** The
  tool has no key to sign with, and nothing either command does needs one.
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
