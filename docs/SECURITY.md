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

**The tool still holds no SFD key material.** It orchestrates ceremonies and
moves opaque blobs; all inbound crypto is on the FC or in SFD's offline build
tooling. The one qualification, added 2026-09-07, is the **owner keypair** —
the operator's own key, which the tool brokers so that params and logs can
travel outbound to one reader and no other. See "Outbound confidentiality" and
PLAN.md decision 10, which was revised rather than quietly stretched.

## Trust model

Four secrets exist. Everything else — this document, the firmware source, the
file formats, the ceremonies — is public and can be published without weakening
anything.

| Secret | Held by | Protected by |
|---|---|---|
| SFD firmware signing private key | SFD, offline | Key custody (never leaves SFD) |
| SFD applet master secret | SFD, offline | Key custody (never leaves SFD) |
| Per-drone identity private key | The drone, alone | STM32 RDP Level 1 |
| Owner private key | The operator, alone | Custody outside the tool — open, see PLAN.md decision 37 |

The first three protect **SFD** from the customer. The fourth protects the
**customer** from everyone else, and it is the only one that runs that way —
which is why it needs its own keypair rather than a reuse of the identity.

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

## Outbound confidentiality — the owner keypair

Everything above runs one direction. SFD encrypts **to** the drone, and the
drone decrypts with a key that never leaves it. Nothing in that arrangement
lets the drone send something only one particular reader can open, because the
drone knows no reader's public key.

Parameters and logs need the opposite direction. That needs a second keypair,
mirrored (operator decision 2026-09-07):

| | Drone identity keypair | Owner keypair |
|---|---|---|
| Generated by | the drone, from its TRNG (F4) | the operator, at enable time |
| Private half | `.apsec_data`, never leaves the chip | generated offline, kept by the operator, imported into the browser as a non-extractable key — never on the drone |
| Public half | the `sfd-identity/1` file | written once into the drone's `.apsec_data` |
| Protects | **inbound** — applets and tunes only this airframe can read | **outbound** — params and logs only this owner can read |

The name matters. It is the **owner** key, not "the tool key": it has to outlive
any particular browser profile, laptop or install, or the drone becomes
unreadable the first time somebody reinstalls their operating system.

### One key agreement gives both properties

The drone makes a fresh ephemeral pair per artefact and mixes two X25519
agreements into the content key:

```
drone, per artefact:
  e_priv, e_pub = TRNG ephemeral X25519 pair
  k_conf = crypto_key_exchange(e_priv,        owner_pub)   -- only the owner can re-derive
  k_auth = crypto_key_exchange(identity_priv, owner_pub)   -- only this drone can produce
  key    = blake2b_32(k_conf || k_auth || "sfd-outbound/1" || content_type)
  crypto_wipe(e_priv); crypto_wipe(k_conf); crypto_wipe(k_auth)

owner:
  k_conf = crypto_key_exchange(owner_priv, e_pub)
  k_auth = crypto_key_exchange(owner_priv, drone_identity_pub)
```

`k_conf` conceals and `k_auth` authenticates, and because `k_conf` is fresh
per artefact the derived key is too — which is what keeps a static-static
agreement from becoming a fixed key over every file the drone ever writes.
Nothing new has to be built for it: `crypto_key_exchange` and
`crypto_blake2b_general` are both in the vendored monocypher and both already
link.

**The owner needs the drone's identity file to read anything**, because
`k_auth` is derived against the drone's identity public key. That promotes the
`sfd-identity/1` file from a record to an operational secret-adjacent
artefact: lose it and the logs are unreadable even with the owner key. The tool
must treat it the way it treats the settings backup — see the exit ceremony.

### The gate is the absence of a cleartext endpoint, not a session

This is the part that makes the design cheap. Access control here needs no
handshake, no challenge nonce, no replay window and no session state. Once an
owner key is set the drone simply stops offering the artefact in cleartext:

- `@PARAM/param.pck` is joined by `@PARAM/param.sfx`, and the cleartext one is
  withdrawn.
- Log files are written to the card already encrypted, so `LOG_REQUEST_LIST`
  and `LOG_REQUEST_DATA` carry ciphertext **with no change to either path** —
  `AP_Logger_File::_get_log_time()` reads the filesystem mtime rather than the
  file, and `get_log_data()` is a raw `lseek` + `read`.

A third party can still connect and still ask. They get ciphertext. That is the
whole mechanism.

### Provisioning is the attack surface

`set_owner_key()` mirrors F1's `set_identity()` — its own region in
`.apsec_data`, its own 8-byte region signature, refuses a zero key, refuses
while armed. It is **once-and-for-all only after the drone is sealed**
(operator decision 2026-09-07, decision 39). Before the seal a re-claim is a
correction on a bench; after it, a re-claim is somebody with link access
re-pointing a deployed drone's logs at themselves.

**Sealed means the silicon says so.** `AP_CheckFirmware::is_sealed()` reads the
option bytes through `stm32_flash_is_read_protected()`. `BRD_OPTIONS` bit 10 is
the raise-only *request*, not the state — clearing it leaves the protection in
place — so an ownership rule resting on that parameter could be undone by a
plain parameter write.

A re-claim moves **future** logs only. Bench-verified: the log opened after a
re-claim reads with the new key and refuses the old one, and the log before it
does the reverse. Past logs stay with the owner who was in place when they were
written, which is the only coherent answer — their keys were agreed at the time.

The argument that makes `GENERATE_IDENTITY` safe to leave unsigned **does not
carry over**. There, a stranger who pre-empts the customer has produced exactly
the identity the customer would have got, and the private half never leaves the
chip either way. Here, a stranger who pre-empts the customer *owns the drone's
output*. So an unsealed drone can be claimed — or since decision 39,
**re-claimed** — by whoever plugs in first, and the mitigation is procedural:
the enable ceremony sets the identity, the owner key and the seal in one
sitting, on the bench, with the operator physically present. A drone must not
leave that bench enabled but unowned. Decision 39 widens this window
deliberately, trading it against a lost owner key being unrecoverable.

This is also precisely what makes **remote key exchange** hard rather than
merely unbuilt: it is the case where the operator is *not* present, so
physical presence cannot be what authorises the write, and nothing else
currently can.

### Consequence: an owned drone is not a standard ArduPilot drone

Withdrawing cleartext parameter access breaks every other ground station.
Mission Planner and QGC read `@PARAM/param.pck` or stream `PARAM_REQUEST_LIST`;
neither can open the envelope. An owned drone is configurable only by this tool,
holding the owner key.

That is a **product decision, not an implementation detail**, and it has a
middle setting: withhold only the location-bearing subset — missions, rally
points, fences, and the parameters that carry coordinates — and leave the rest
cleartext, so a third-party GCS still flies the aircraft but cannot read where
it has been told to go. Open; see PLAN.md.

### Threat ordering — logs first, params last

The priority follows the threat rather than the difficulty, and they run
opposite ways:

- **Logs** hold the entire flight path and sit on a **removable card, outside
  the seal**. They are the only artefact a third party can read today with no
  link access at all. Highest value, and the cheapest to fix.
- **Missions, rally points and fences** hold the coordinates somebody actually
  typed. They live in the internal-flash storage region, so F6's seal already
  covers them at rest — but they are served over the link in cleartext.
- **Parameters** carry the least of it. On this board the storage region is
  internal flash (`STORAGE_FLASH_PAGE 14`, no FRAM), so a sealed drone already
  refuses to give them up to a debugger.
- And none of it counts for much while the drone broadcasts
  `GLOBAL_POSITION_INT` in the clear to anyone listening, which it does.
  Encrypting the stored record while streaming the live one is a half-measure,
  and it should be named as one rather than sold as privacy.

### Envelope format (`.sfx`)

One format for both, because they differ only in whether the body is seekable:

```
offset size  field
  0     6    magic "SFDX10"
  6     1    content type — 1 = parameters, 2 = log
  7     1    flags — bit 0: body is an unauthenticated seekable stream
  8    12    source board id (this drone's STM32 UID), plaintext
 20    32    the drone's per-artefact ephemeral X25519 public key
 52    24    nonce
 76    16    Poly1305 tag over bytes 0..75, and over the body when bit 0 is clear
 92   ...    ciphertext
```

**Parameters** (bit 0 clear) are tens of kilobytes, so the body is a one-shot
`crypto_lock` and the tag covers everything.

**Logs** (bit 0 set) are written with `crypto_xchacha20_ctr()`, which returns
the next counter and so encrypts an arbitrary byte range at an arbitrary
offset. Ciphertext is the same length as plaintext, which is what lets the
existing io path stand unchanged: `AP_Logger_File::_io_timer()` writes
whatever the ring buffer holds and truncates to fsync boundaries, and a
seekable stream cipher does not care.

**A log body is confidential but not tamper-evident, and that is deliberate.**
A trailer MAC cannot be written by an aircraft that lost power, which is
exactly the log worth reading; per-block MACs would change the file length and
break the raw-offset download path. The tag therefore covers the header only,
so the ephemeral key and board id cannot be swapped, and the body is
confidentiality-only. Do not describe an encrypted log as authenticated.

### What has been verified, and what has not

**Bench-verified 2026-09-07 on TBS_LUCID_H7 / SmallFastDronev1**, end to end.
The board was upgraded to the new firmware and a hand-patched secure bootloader,
generated an identity, was claimed with a bench owner key, and wrote logs:

- The log on the card begins `SFDX10`, content type 2, stream flag set, and
  carries the board's own UID. Its body is **32640 bytes — exactly 510 × 64**,
  which is the block-aligned writing doing what it was designed to.
- Decrypted with the owner private key plus the drone's identity file, the
  plaintext begins `a3 95 80 80 … FMT` and **pymavlink parses it: 643 messages,
  32 distinct types** (PARM, FMT, IMU, XKF…). A real, readable ArduPilot log
  recovered from an encrypted file.
- A **different owner key is refused**, and the file as it sits on the card
  yields pymavlink nothing but `BAD_DATA` — 3352 of them and **zero real
  message types**, against 2 stray `a3 95` pairs in 32640 bytes where chance
  predicts about 0.5.

Before that, the envelope was round-tripped against **pymonocypher**, an
independent implementation, at the firmware's own offsets — a body encrypted in
the ragged 64-byte chunks the io thread produces decrypts to its input, and a
different owner key, a different drone identity, a tampered board id, a swapped
ephemeral key and altered flags are each refused.

**Still not established:** the throughput figure below is scaled from a host
measurement and has never been measured on the board, and no log has been
written under flight-rate logging load — the bench logs are boot-time FMT and
PARM dumps, not a flight.

### Where the owner private key lives

**Generated offline, backed up offline, imported into the browser as a
non-extractable WebCrypto key** (decision 37). Measured on Chromium 148 before
choosing rather than assumed:

| | |
|---|---|
| X25519 in WebCrypto | works |
| A non-extractable private key performs `deriveBits` | works — 32 bytes |
| Exporting that private key | **refused by the browser** |
| Survives IndexedDB and derives the same secret | works |

So the tool decrypts without ever being able to read the key. That is less a
loosening of decision 10 than the tool orchestrating a key it is structurally
incapable of holding.

Generating the key *in* the browser is strictly worse and must not be done:
there would be nothing to back up, and clearing site data would destroy every
log that drone has ever written. **The offline original is the backup**, and
keeping it is the operator's job — which is a real burden the design places on
them, not a detail. Losing it before the seal costs a re-claim; losing it after
costs every log the drone will ever write.

### Why an operation that worked used to report failure

`GENERATE_IDENTITY` and `SET_OWNER_KEY` rewrote their flash sector and
delivered no verdict; so did `MAV_CMD_FLASH_BOOTLOADER`. **Diagnosed and fixed
2026-09-07**, and the answer was not the one the timeout suggested.

**It was never late — it was never sent.** Listening for forty seconds, nearly
three times the client's allowance, produced no reply at all, while heartbeats
carried on with a one-second gap where the sector write stalled the board.
Instrumenting the firmware showed it reaching the send with `ACCEPTED`, and the
statustexts on either side of that line arriving normally.

The difference between those statustexts and the reply is **size and retry**.
`comm_send_lock()` sets `chan_discard` when `txspace()` is smaller than the
message, and `comm_send_buffer()` then returns without sending — silently, and
by design. A `SECURE_COMMAND_REPLY` carries a 220-byte data field, so it needs
roughly 240 bytes at the instant a second of backed-up telemetry is draining. A
54-byte statustext fits, and is queued and retried besides.

The firmware now waits for room before replying, bounded at half a second
against a handler that has already blocked far longer. On the board the reply
arrives every time, 1.85 s after the request — well inside the allowance that
was never the problem. `MAV_CMD_FLASH_BOOTLOADER` got the same treatment; its
failure was measured with a real write, but the fix has not been re-observed
under a stall, because forcing one means manufacturing a different bootloader.

**The rule stands anyway: read back before concluding a flash write failed.**
Firmware without the fix will be out there for a long time, and a write-once
operation is exactly where a caller must not trust silence.

**The general lesson is bigger than these three.** Any MAVLink message sent
straight after a flash write can be discarded for want of buffer space, and
nothing reports it. If a new operation writes flash and then answers, it needs
the same wait — or its caller needs to verify by reading.

### A log that is still open reads as 92 bytes

Its size at the header fsync. The directory entry is not updated again until
the file is synced or closed, so a live log looks empty and the one before it
reads its true size. Worth knowing before concluding the body never got
written.

One trap worth recording, because a test hit it and passed by accident.
Flipping a low bit of byte 0 of an X25519 private key does **not** produce a
different key — clamping discards those bits. A negative test that "proves" a
wrong key is refused that way proves nothing.

### Cost, measured where it could be

`crypto_xchacha20_ctr` from the vendored monocypher benchmarks at **~1.0 GB/s
scalar** on an x86 dev machine (~5.5 cycles/byte). The STM32H743 runs at
480 MHz with **no crypto accelerator** — that is the H753 — so the same C
should land somewhere around 20–40 MB/s against logging rates of a few hundred
KB/s, i.e. low single-figure percent of the IO thread. **That is a scaled host
measurement, not an on-board one**, and it needs a bench run before anyone
plans around it.

### The `rand()` nonce becomes a live problem

`lua_scripts.cpp`'s `create_nonce()` fills 24 bytes from `rand()`. That is
harmless today only because every `.lxa` carries a unique ephemeral key, so a
repeated nonce costs nothing. Any long-lived key changes that: a nonce
collision under a fixed key is keystream reuse. The `.sfx` construction above
avoids it by deriving a fresh key per artefact, but nonces on this path must
come from `hal.util->get_true_random_vals()`, not `rand()`.

### What the owner keypair fixes, on the way past

The settings backup problem noted against the exit ceremony resolves itself
here. A backup encrypted to the **drone's** identity is undecryptable the
moment T3's mass erase destroys that identity — i.e. exactly when the restore
needs it. A backup encrypted to the **owner** key survives the wipe, because
the owner key was never on the drone. The owner keypair is the only key in the
system that outlives the airframe.

## Remote key exchange

The third leg of the outbound arc, and the one with no construction until
now. **Designed 2026-09-07; not built, and one decision below is the
operator's.**

### The problem, precisely

`SET_OWNER_KEY` is unsigned, because the tool holds no key it could sign
with. What authorises it is physical presence: an operator on a bench,
enabling a drone in one sitting. That is why an unsealed drone belongs to
whoever plugs in first, and why sealing has to be the point where
ownership stops changing.

Remote provisioning is the case where nobody is at the drone. Presence
therefore cannot be the authorisation, and nothing else currently is.

Two situations want it, and only one is a convenience:

- **Rotating a key you still hold.** A nuisance today: it means a bench.
- **Replacing a key you have lost.** Today this is unrecoverable on a
  sealed drone. The drone keeps recording, nobody can ever read it, and
  the only way back is the exit ceremony's mass erase — which is a harsh
  penalty for losing a file, and lands on the operator rather than on an
  attacker.

### The construction: an ownership grant SFD signs

The drone already trusts exactly one key — SFD's, in the bootloader, and
`check_signature()` already verifies a 64-byte signature against it. So
the authorisation exists; it has simply never been used for this.

```
  0   6  magic "SFDOWN"
  6   1  version
  7   1  reserved
  8  12  the drone's STM32 UID — this grant is for one airframe
 20  32  the owner public key being granted
 52   8  issued-at, so a grant can be ordered against another
 60  64  Ed25519 signature over bytes 0..59, by SFD's signing key
```

The flow moves files, not connections:

1. The customer generates an owner keypair offline (`owner_key.py`) and
   sends SFD the public half and the drone's `sfd-identity/1` file. Both
   are already non-secret and already travel this way.
2. SFD signs a grant offline, with the key it already signs firmware
   with.
3. The customer feeds the grant to the configurator, which relays it to
   the drone as a signed `SET_OWNER_KEY`.
4. The drone verifies it against the bootloader's key, checks the UID is
   its own, and writes the owner key.

**Nothing about the serverless design changes.** No key material reaches
the tool, no service stands between customer and drone, and the whole
exchange is two files and an email — the same shape as the identity file
that already works.

### What it costs, and this is the decision

A signed grant works on a **sealed** drone, which is the point: it is
what makes a lost owner key recoverable. But it means **SFD can re-point
any drone's ownership at any time**, including at a key SFD holds — and
therefore can arrange to read a customer's future recordings.

The honest framing is that this is not a *new* power. SFD signs the
firmware, so SFD can already ship a build that does anything, including
dumping logs in the clear. A drone trusts SFD completely and always has.

But it is a **cheaper** power, and cheapness matters. Shipping malicious
firmware is an act the customer performs, on an artefact they can keep
and inspect. A signed grant is a quiet write over a link. "SFD could, but
it would take a firmware release someone might notice" is a meaningfully
different promise from "SFD can, silently, today".

**Decided 2026-09-07: grants work on a sealed drone** (PLAN.md decision 42).
The deciding argument is that the change **announces itself** — the owner's key
stops opening new recordings at the next download, so a re-point is a loud act
rather than a quiet one. Refusing grants after sealing would trade a real,
recoverable failure (a lost key) for an obstacle that stops nobody: an SFD
willing to re-point ownership would ship a firmware build instead.

Three conditions came out of deciding, and the first is a hole in the sketch
above:

1. **A monotonic counter, not a timestamp.** The drone has no clock and no
   memory of what it has applied, so the `issued-at` field above does not
   prevent replay: an old grant can be re-applied to restore a key the operator
   rotated away from. The drone must store the last value applied, in the owner
   region, and refuse anything not strictly newer.
2. **The tool shows the fingerprint a grant would install, and the operator
   confirms it.** The attack here is not on the crypto but on the customer, who
   relays a file somebody sent them. A grant pointing at an attacker's key is
   caught by a person reading a fingerprint, and by nothing else.
3. **The tool says when the drone's owner is not the key in hand**, rather than
   leaving the operator to infer it from a decryption failure. This is what
   makes the self-announcing property something an operator actually sees.

The options considered, kept for the record:

- **Grants work on sealed drones.** Lost keys are recoverable; SFD can
  re-point ownership silently. Simplest, and the only option that solves
  the case that motivated this.
- **Grants are refused once sealed.** Preserves "after sealing, ownership
  is fixed and even SFD cannot move it". A lost key stays unrecoverable,
  and remote provisioning only helps before sealing — which is the
  cheaper half of the problem.
- **A grant on a sealed drone wipes the recordings first.** Ownership
  moves, but nothing written under the old owner survives it, so a
  re-point cannot be used to read the past. Does not stop SFD reading the
  *future*, and adds a destructive step to a support flow.

### As built (F15 + T11, 2026-09-07)

The grant is 124 bytes, and the signature lives **inside it** rather than in
`SECURE_COMMAND`'s `sig` field. That is the one structural departure and it is
forced: `check_signature()` covers a session key the drone issues, which makes
it interactive, and a grant is signed offline weeks before use.
`AP_CheckFirmware::verify_signed_blob()` checks a detached signature over the
grant alone, against the same bootloader keys.

**The counter is in the owner region**, written in the same flash operation as
the key it authorised so the two cannot disagree after an interrupted write. A
drone claimed only in person has a counter of zero, so a first grant needs at
least 1. `sign_owner_grant.py` refuses a zero rather than producing a grant that
can never apply.

Checks run cheapest first and the signature last, so a grant for another
airframe costs a `memcmp`; and the counter is checked before anything is
written, so a replayed grant never reaches flash.

**Bench-verified on a TBS_LUCID_H7**, all five paths: a valid grant applied; the
same grant replayed **refused as superseded**; a grant for another drone
refused; one signed by an untrusted key refused; and a newer grant rotating to a
different key applied.

**Not verified: the sealed case**, which is the whole point of decision 42.
Testing it costs the board's identity to undo, so it is reasoned rather than
observed — the code path does not consult the seal at all, which is what makes
it work, but that is an argument rather than a measurement.

**The region grew again.** A drone needs a bootloader carrying the counter
field before it can take a grant, and updating a bootloader erases the identity,
since they share a sector. So this is not a firmware-only upgrade for a drone
already in the field: it is a re-enable.

### The half that needs no decision

**An owner-signed re-claim** covers rotating a key you still hold, and
involves SFD not at all: the grant is signed by the *current* owner
rather than by SFD, and the drone verifies it against the owner key it
already holds. Safe on a sealed drone by construction — only the current
owner can authorise the change — and worth building whichever way the
above goes. It just cannot help the case where the key is lost, which is
the case that hurts.

### What this does not solve

The claiming window stays open. A drone that ships enabled but unowned
can still be claimed by whoever plugs in first, because a drone with no
owner has nobody to authorise a grant and no reason to demand one.
Closing that needs the owner key written before the drone leaves — which
is factory provisioning, not remote key exchange, and is a separate
question about how drones are shipped.

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

### The `.lxa` v2 script format

What the identity is *for*. A script encrypted under v2 can be read by one
airframe and no other, which is the capability the whole enable ceremony
exists to deliver.

```
  0    6   magic "LXA2.0"
  6   12   target board id, plaintext
 18   32   sender's ephemeral X25519 public key
 50   24   nonce
 74   16   Poly1305 tag
 90  ...   XChaCha20-Poly1305 ciphertext
```

The sender generates an ephemeral key pair, X25519s its private half against
the drone's identity **public** key, and writes only the public half. The drone
re-derives the same secret from its identity **private** key, which never
leaves the chip. Nothing secret is in the file, and losing the ephemeral
private half costs nothing — it existed for one file.

The board id is checked before any cipher work. A drone carrying somebody
else's script is an ordinary situation, not an attack, and it should cost a
`memcmp` rather than a decryption attempt. Flipping that field gains an
attacker nothing: the key agreement is what gates decryption and does not
involve it.

**v1 is gone, not deprecated.** It encrypted with a bootloader public key used
as a symmetric key — a key present in every bootloader, so anyone with the
firmware could read any script. Keeping a reader for it would keep that path
alive for no benefit, and nothing has shipped that writes it.

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
| 5 | Restore params | With an explicit report of anything that did not survive. **Includes telling the drone its restored calibration is valid** — see below. |

**Restoring a calibration is not restoring a calibration.** A backup carries the
compass and accelerometer calibration *values* (`COMPASS_OFS_*`, `INS_ACCOFFS_*`,
`INS_ACCSCAL_*`) but not the sensor ids that bind them to detected hardware —
those are read-only and describe the hardware, so a backup rightly has no
business carrying them. Write the values back on their own and the firmware
still considers the drone uncalibrated: `accel_calibrated_ok_all()` fails on
`_accel_id_ok`, and the drone refuses to arm having apparently forgotten a
calibration the operator performed. So step 5 finishes by sending
`MAV_CMD_PREFLIGHT_CALIBRATION` with the accept-stored magic (76) in the
compass and accel slots. ArduPilot's own comment on that path names this exact
case: *"useful when reloading parameters after a full parameter erase"*.

The slots matter and are pinned by a unit test: the same command **starts** a
gyro calibration on `param1 = 1` and a real accelerometer calibration on
`param5 = 4`, neither of which should begin while an operator is putting
settings back.

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
| Outbound encryption (params, logs) | SFD firmware | Only place the identity private key exists |
| Owner keypair custody | The operator's authenticator / key file | Must survive a laptop; must not sit in the tool's own storage |
| Outbound decryption | This tool, brokering the operator's key | The reader has to be somewhere, and it is not the drone |

**This tool holds no *SFD* key material and no drone private key.** It brokers
an owner key it does not own, and where the platform allows that key must live
outside the tool — see PLAN.md decisions 10 and 37. Anything beyond that is a
design regression, not a feature.

## Firmware work list

Companion to this document, landing on the **`SmallFastDrone-4.7-config`**
branch in `../smallfastdrone/` (origin `fossuav/smallfastdrone`) — that is
`pr-lua-encryption` rebased onto the 4.7 beta line plus the BLHeli-in-SITL
enablement, and it is the branch the `vendor/smallfastdrone/` submodule tracks.
Ordered by dependency, not priority. **Status 2026-09-07: F1–F10 have all landed** — those are the inbound arc, and it is complete. **F11–F14 are the outbound arc** (params and logs to the owner keypair), designed 2026-09-07 and not started. F1–F4 and F9 are **bench-verified on a TBS_LUCID_H7** running a signed SmallFastDronev1 build on a signed bootloader — the drone generated its identity, refused to generate a second, and returned the same public key after a reboot. **F5–F8 and F10 are not bench-verified** — F5/F10 need a microSD in the board, and F7 would mean deliberately emptying a keyed board's keys to see it refuse. Each row says what was verified instead.

| # | Change | Where | Notes |
|---|---|---|---|
| F1 | Dedicated identity region in `.apsec_data` | `AP_CheckFirmware/AP_CheckFirmware.h` — `struct ap_identity_data`, last member of `ap_secure_data`; accessors in `AP_CheckFirmware_secure_command.cpp` | ✅ **Landed 2026-08-28** (`AP_CheckFirmware: add a per-drone identity region to the secure data`). `find_identity()` (nullptr on a bootloader without the region), `identity_is_set()`, write-once `set_identity()` that rewrites the bootloader sector through the existing `read_bootloader()` / `write_bootloader()` path and wipes its RAM copy after. Never returned by any MAVLink command; excluded from `check_signature()` and `set_public_keys()` by construction (see "Per-drone identity"). Compile-verified on a signed TBS_LUCID_H7 bootloader + signed SmallFastDronev1 firmware, and the built image checked byte-for-byte: region present and zero, untouched by `make_secure_bl.py --omit-ardupilot-keys`. **Bench-verified 2026-09-04:** `set_identity()` wrote the key into the bootloader sector and it survived a reboot unchanged, so the region is real flash and not RAM. |
| F2 | Compile out `SET_PUBLIC_KEYS` / `REMOVE_PUBLIC_KEYS` on SFD builds | `AP_CheckFirmware/AP_CheckFirmware_secure_command.cpp` — the `SECURE_COMMAND_OP` switch | ✅ **Landed 2026-08-28** (`AP_CheckFirmware: compile out MAVLink key management on fixed-key builds`). Under `AP_CHECK_FIRMWARE_FIXED_KEYS` both operations and `set_public_keys()` itself — the only writer of `public_key[]` — are gone; `read_bootloader()` / `write_bootloader()` remain for the identity region. Confirmed absent from the SmallFastDronev1 ELF. |
| F3 | Fail closed on an empty key array | same file — `all_zero_keys()` and its use in `check_signature()` | ✅ **Landed 2026-08-28** (`AP_CheckFirmware: fail closed on an empty key set when keys are fixed`). `check_signature()` returns false on an all-zero set under the same define. The bootloader's own `all_zero_public_keys()` fail-open in `check_good_firmware()` is untouched here — that is F7, and a bootloader change. |
| F4 | New secure commands: `GENERATE_IDENTITY`, `GET_IDENTITY` | same file | ✅ **Landed 2026-08-28** (`AP_CheckFirmware: add GENERATE_IDENTITY and GET_IDENTITY secure commands`). Identity only — lock/unlock are `BRD_OPTIONS` bits, not commands (F6). Generate: `hal.util->get_true_random_vals()` (100 ms timeout), X25519 clamp, `set_identity()` (write-once from F1), `crypto_wipe` the stack copy; denied while armed. Get: UID + `crypto_x25519_public_key()` of the key in flash. Both **unsigned** — see "Why the identity commands are unsigned". Gated by `AP_CHECK_FIRMWARE_IDENTITY_ENABLED`. **Bench-verified 2026-09-04** against a TBS_LUCID_H7 running a signed bootloader + signed SmallFastDronev1 build, driven through the tool's own `runEnableCeremony()` rather than the Python probe: generate returned UID + public key, a second generate was `DENIED` (write-once holds), and a read after reboot returned the same key. |
| F5 | `.lxa` v2 loader — ECDH + board-id check | `AP_Scripting/lua_scripts.cpp`, `Tools/scripts/signing/encrypt_lua.py` | ✅ **Landed 2026-09-05** (`6709fba30c`, `edbe52a371`). v1 encrypted with a bootloader *public* key used as a symmetric key — obfuscation, not encryption, since that key is in every bootloader; decryption even tried all ten slots in turn, which only makes sense when the key is a guess. v2 agrees a key: the sender X25519s an ephemeral private key against the drone's **identity public key** and ships only the public half, and the drone re-derives the same secret from the private half that never leaves its chip. **The board id gets its own header field** rather than prefixing the nonce as sketched below, so the nonce stays fully random and the check reads as the check it is; it is tested before any cipher work. **v1 is not accepted** — keeping it would keep the weak path alive. Encrypting is now done from the `sfd-identity/1` file the configurator saves, which closes the loop with the enable ceremony. Round-tripped against pymonocypher at the firmware's own offsets: the drone recovers the script and a different identity cannot. **Not bench-run** — needs a card in the board. |
| F6 | RDP as a `BRD_OPTIONS` bit, acting on next boot | `AP_BoardConfig` (bit 10 + `secure_memory()`), `AP_HAL_ChibiOS/HAL_ChibiOS_Class.cpp` | ✅ **Landed 2026-09-04** (`badba877f8`, `2648771d65`). **The "one bit or two" question is resolved by neither: one bit, raise-only.** Setting BRD_OPTIONS bit 10 asks for readout protection at the next boot; clearing it does *nothing*, because the firmware never lowers protection. That removes the hazard the two-bit design existed to dodge — an operator un-ticking a box and mass-erasing their drone — without needing a second bit. Unlocking stays exclusively the DFU route, which is also the case that matters since a drone needing an unlock has usually stopped booting. **The `__RAMFUNC__` caveat evaporates with it:** `stm32_flash_set_rdp_flash(0xAA)`, the call that would run from the flash it is erasing, is never invoked from firmware and stays commented out upstream. The only live call is `0xBB` (level 1); `0xCC`, which is irreversible and scraps the board, appears nowhere in the tree. Locking is **refused without a verified identity**. Note that nothing was protected before this either: `HAL_FLASH_READOUT_PROTECTION` defaults to 0 and no board set it, so the old unconditional call was unreachable — SmallFastDronev1 now compiles it in, which only makes the option available. **Not bench-verified**, and doing so costs the board's identity — see below. |
| F7 | Bootloader-side invariants | `AP_CheckFirmware/AP_CheckFirmware.cpp`, bootloader build | ✅ **Landed 2026-09-05** (`33903945b9`). Two of the three invariants turned out to hold by construction and are recorded rather than added: the bootloader **never touches RDP** and **never writes an identity**, so "raise-only" and "write-once" cannot be violated from there. The one that did not hold: the bootloader booted unsigned firmware whenever its key set was empty — deliberate on an unsecured board, and the comment above it named the path (remove keys over `SECURE_COMMAND`, then load unsigned). On a drone holding an identity that is a downgrade, since such a drone was keyed when the identity was written. Both fail-open sites now refuse in that case. The identity is read straight from `public_keys`, the bootloader's own `.apsec_data`, with no signature check needed — unlike the firmware, which must find the region inside an image it read out of flash, here the linker placed it. **Inert on every board today**: it bites only when keys are empty *and* an identity is present. **Not bench-run**, and testing it would mean deliberately emptying a keyed board's keys. |
| F8 | Fix `create_nonce()` | `AP_Scripting/lua_scripts.cpp` | ✅ **Landed 2026-09-05** (`8d04921203`). `create_nonce()` was called on the *decrypt* path, where it overwrote the nonce just read from the file — so decryption could only ever have worked with the board-id prefixing compiled out, which is the default and why it went unnoticed. The nonce is now verified, not regenerated, and before decrypting rather than after. The uninitialised `nonce_len` could not overrun (the callee caps at 12) but was undefined and silently truncated the prefix; a short read now zeroes it rather than leaving something that looks checked. |
| F9 | Confirm x25519 isn't compiled out of the FC monocypher build | `AP_CheckFirmware/monocypher.{h,cpp}` | ✅ **Resolved 2026-08-28.** Nothing trims it — the only conditionals in `monocypher.cpp` are BLAKE2 unrolling and Argon2. It was merely linker-GC'd for lack of a caller; F4's `crypto_x25519_public_key()` now links (`nm` on the SmallFastDronev1 ELF shows it). F5 can rely on `crypto_key_exchange`. |
| F10 | Re-key on-FC self-encryption | `AP_Scripting/lua_scripts.cpp` — `encrypt_all_scripts_in_dir()` | ✅ **Landed 2026-09-05** with F5. The drone makes an ephemeral pair from its TRNG, agrees a key against its **own** identity public key, wipes the private half immediately and writes only the public one — so a script the drone encrypts for itself is readable by itself and nothing else. Refused outright on a drone with no identity, rather than falling back to something weaker. |
| F11 | Owner key region in `.apsec_data` | `AP_CheckFirmware.h` — `struct ap_owner_data`; accessors in `AP_CheckFirmware_secure_command.cpp` | ✅ **Landed and bench-verified 2026-09-07** (`8689b1d3f1`). On hardware, `GET_OWNER_KEY` answers with its own status byte where the firmware before it answered DENIED to an operation it had never heard of — the region is really there. `find_owner_key()` (nullptr on a bootloader predating the region), `owner_key_is_set()`, write-once `set_owner_key()`. Placed after `ap_identity_data`, which is what makes it invisible to `make_secure_bl.py`. **Additionally refuses without an identity**, since the outbound agreement authenticates with the identity private key — that puts the ceremony's ordering in firmware, not only in the tool. No wipe after writing: the key is public, and wiping would imply otherwise. **Verified on a built signed TBS_LUCID_H7 bootloader:** region present at offset 368 of the secure data and all-zero; each of the three region signatures occurs **exactly once** in the image (the F7 lesson about unique markers); and `make_secure_bl.py --omit-ardupilot-keys` changes exactly 32 bytes, all inside `public_key[0]`, reaching neither region. Signed SmallFastDronev1 copter builds clean. **Not bench-run** — nothing writes the region until F12. |
| F12 | `SET_OWNER_KEY` secure command | `AP_CheckFirmware_secure_command.cpp` | ✅ **Landed and bench-verified 2026-09-07** (`f279ba4341`). The board was claimed and read the key back byte-for-byte. `SET_OWNER_KEY` (`0x53464403`) and `GET_OWNER_KEY` (`0x53464404`), both unsigned, both replying with UID + the key **read back out of flash** so an ACCEPTED is already evidence of what landed. Every refusal carries a status byte — armed / no region / already owned / no identity — because the remedies differ and a bare DENIED makes the caller guess; the same lesson `GET_IDENTITY` learned. **Still the one with a real open question.** Write-once plus physical presence is the proposed authorisation, because the reasoning that makes `GENERATE_IDENTITY` safe unsigned does not carry: pre-empting an identity gains an attacker nothing, pre-empting an owner key gains them every future log. Vendor-private op `0x53464403`. See "Provisioning is the attack surface", and PLAN.md's open question on claiming an unowned drone. |
| F13 | Encrypted log writer | `AP_Logger_File.cpp`, and the envelope in `AP_CheckFirmware_outbound.cpp` | ✅ **Landed and bench-verified 2026-09-07** (`0d908dd9ba` envelope, `bcb268939c` logger, `4a4559c8ad` reader). Header written and fsync'd before any log data, and the open **fails** if it does not land — half a file cannot be read at all. Body encrypted **in place in the write buffer, in whole 64-byte blocks**: in place so a short write costs nothing (what the filesystem declines stays encrypted and the next pass carries on), whole blocks because the counter is a block counter. The sub-64-byte remainder waits, and is discarded at close — which is what `stop_logging()` already does to it, so this costs at most 63 bytes more than before. Listing and download are **unchanged**, as predicted. File backend only; block backends are on internal flash, already behind the seal. |
| — | `Tools/scripts/signing/decrypt_sfx.py` | ✅ **Landed 2026-09-07** (`4a4559c8ad`). The owner-side reader, and the independent check on the construction — see the F13 verification note below. |
| F14 | Encrypted parameter endpoint | `GCS_FTP.cpp`, `AP_Param` | ⏸ **Deferred by operator decision 2026-09-07** — logs first, params when there is a reason. The rest of the outbound arc does not wait on it. When taken up: `@PARAM/param.sfx` alongside `@PARAM/param.pck`, and withdrawal of the cleartext endpoint (and of `PARAM_REQUEST_LIST`, and of the mission / rally / fence protocols) once an owner key is set. **Scope is an open product decision** — everything, or only the location-bearing subset; the first makes the drone unreadable by any other ground station. |

## Tool work list

Companion to the firmware list above. **T1–T7 are the inbound arc and are
complete; T8–T10 are the outbound arc** (decision 36) and are not started.

| # | Module | Purpose |
|---|---|---|
| T1 | `src/protocol/secure-command.ts` | ✅ **Landed 2026-08-28.** `SecureCommandClient` (same `send` / `subscribe` / sysid / compid shape as `MavFtp`): `getIdentity()` → identity or `null` when the drone has none (the firmware answers FAILED to a blank region); `generateIdentity()` → the identity the drone read back after writing; generic `request(op, data, timeoutMs)` for anything else. Unsigned and sessionless — `sig_length = 0`, no `GET_SESSION_KEY` — so it holds no key material. Replies matched on `sequence` + `operation`; the sequence starts random so a stale reply from an earlier session can't match. Non-ACCEPTED verdicts, timeouts and malformed replies all surface as `SecureCommandError` with the drone's `result` (DENIED / UNSUPPORTED / FAILED, or `null` for no verdict) so the enable workflow can branch without string-matching; a timeout is also what a non-signed firmware looks like, since it never answers. 15 s allowance on GENERATE for the sector rewrite. 14 unit tests against a fake link (`test/unit/secure-command.spec.ts`); not SITL-testable — the handler exists only in signed builds — so bench is the integration test. |
| T2 | `src/workflow/sfd-enable.ts` + `use-sfd-enable.ts` | ✅ **Identity half landed 2026-08-28** (steps 3–5): `runEnableCeremony(client, ctx, onPhase)` is pure — drone behind an `IdentityClient` interface, time injected — and unit-tested (13 cases); `useSfdEnable()` wires it to the session store for a view. Flow: read → generate if absent (a DENIED generate followed by a successful read is "it already has one", not an error; DENIED with still nothing to read is "armed") → **verify by a fresh read** that must byte-match and whose uid must be a prefix of the session's `fcUid` → build the file. Stops with a typed `EnableError` reason — `unsupported` (UNSUPPORTED or no answer at all, which is what non-SFD firmware looks like), `armed`, `mismatch` ("don't lock this drone"), `failed` — and never yields a file when it stops. **Not here:** the flash (step 1, the Firmware view) and the **lock (steps 6–7), which waits on F6**; it will attach to a completed `EnableOutcome`, never run inside the ceremony, so the ordering stays the security property. |
| T3 | `src/workflow/sfd-recover.ts` | ✅ **Landed 2026-09-04.** `runExitCeremony(driver, onPhase)` sequences capture → **operator confirms they hold the file** → DFU → unlock → flash → reconnect → restore, over an injected `RecoveryDriver` so the ordering is testable without a board. **The gate is the point:** nothing irreversible runs until the operator confirms the backup is saved, and unit tests assert `unlock` and `flash` were never called on every pre-gate failure path. Every failure carries the backup and an explicit `destructive` flag, so a view can say "your drone needs finishing" rather than "nothing happened" — and so an operator is never failed twice by losing the file on the way to reporting something else. `hasUnfinishedBusiness()` refuses to call a restore that dropped settings a success. **Only the DFU unlock route** is offered: the `BRD_OPTIONS` route needs F6, and the tool never puts the drone into DFU because signed firmware refuses that by design (bench-confirmed) — the operator uses the BOOT0 pads and the driver waits. **View landed** the same day (`src/wizards/sfd-recover/`). **No bench run**: exercising it would mass-erase the board and destroy the identity we generated. |
| T4 | `DfuClient.readUnprotect()` | ✅ Landed. DfuSe `READ_UNPROTECT` for RDP regression on a dead drone, surfaced in the Firmware view's recovery tab. Bench verification pending — no SITL substitute for DFU. |
| T5 | `src/workflow/param-backup.ts` + `src/protocol/param-pack.ts` | ✅ Landed. Delta backup (changed-from-default, minus read-only) + restore planning with the not-reverted report. Defaults come from the drone via `@PARAM/param.pck?withdefaults=1`. |
| T6 | `src/workflow/drone-identity.ts` | ✅ **Landed 2026-08-28.** The `sfd-identity/1` document: `buildIdentityFile` / `serializeIdentityFile` / `parseIdentityFile` (operator-readable rejections, uid normalised to lower case) / `identityFromFile` / `sameIdentity` / `identityMatchesFc` / `identityFilename`. Snake_case fields because the firmware repo's `sfd_identity.py` writes the same file and SFD's Python tooling reads it — one of the 15 unit tests parses the probe's output verbatim. `board_id` comes from a new `boardId` on the session store (`AUTOPILOT_VERSION.board_version >> 16`). |
| T7 | Views | ✅ **Enable wizard landed 2026-09-04** — `src/wizards/sfd-enable/`, category `safety`, in the wizard library **and** as the last tab of the bringup ribbon. It is an **optional** ribbon area: bringup's completion gate counts required areas only, because most drones cannot be secured at all and gating on it would mean an ordinary ArduPilot drone could never finish bringup. It branches on `session.securityPosture`, so it *tells* the operator which situation they are in instead of offering a button that cannot work — ordinary ArduPilot sends them to the Firmware page, a part-way-upgraded drone gets an **Update startup software** button that drives `flashRomfsBootloader()` in place (the first UI for it), a ready drone gets one button, and a drone that already has an identity gets its file again. The lock is shown as "still to come" rather than pretended at. The visual is the identity itself — a mark derived from the drone's own public key plus a short fingerprint, so an operator can check a saved file belongs to the drone in front of them. **Recovery wizard landed 2026-09-04** — `src/wizards/sfd-recover/`, also `safety`, library-only and deliberately *not* in the bringup ribbon: it is a destructive escape hatch, not a setup step. It supplies the I/O behind T3's `RecoveryDriver`, with the ceremony's two blocking gates ("do you really hold the file", "is it in update mode") as promises the view resolves from button clicks, so an irreversible decision stays with a person rather than a timeout. Three things it has to get right and does: the unlock resets the chip so the DFU handle must be **re-acquired** before flashing (no new permission prompt — the device is still authorised); the image must be a `_with_bl.hex` because the chip comes back blank *including its bootloader*, and Start stays disabled until one is chosen; and the operator is told **before** they commit that the identity dies and a new one would be a different identity, so anything SFD sent for that airframe stops working. |
| T8 | Owner keypair custody | ✅ **Landed 2026-09-07.** `src/workflow/owner-key.ts` + `owner-key-store.ts`, with `Tools/scripts/signing/owner_key.py` making the key offline. Imported **non-extractable**, so the browser performs the agreement and refuses to return the key; the tests exercise real WebCrypto because a stub would assert that property into existence, and one of them asks for the key back and requires the failure. Import also checks the file's halves belong together, by agreeing a secret both ways against a throwaway pair — a non-extractable private key cannot be asked for its public half, and the public half is what gets written into a drone. **Superseded plan:** Generate the operator's X25519 keypair and keep the private half out of the tool's own storage — WebAuthn with the PRF extension is the preferred route (Chromium-only, which we already are, and PLAN.md decision 13 installed mkcert "WebAuthn-ready" in anticipation). A non-extractable WebCrypto key in IndexedDB is the fallback, at the cost of dying with the browser profile. An exported key file is the fallback's fallback and is the one shape that genuinely puts key material in the tool. See PLAN.md decision 37. |
| T9 | Owner key provisioning in the enable ceremony | ✅ **Landed 2026-09-07**, and driven through the UI against the bench board. **Superseded plan:** One more step in `sfd-enable`: after the identity is generated and verified, write the owner public key, verify it by read-back the same way, and only then offer the seal. Identity, ownership and seal in one sitting is not a convenience — it is what closes the claiming window in F12. |
| T10 | Outbound decryption on the read paths | ✅ **Landed 2026-09-07.** `src/protocol/sfx.ts`, with the Logs view as its first surface — downloading recordings is still Phase 4, but an operator who copies one off the card can turn it back into a flight log today. Tested against a fixture **produced by the firmware's own monocypher** at the firmware's offsets, and verified beyond that by opening a real 32,640-byte bench log byte-identically to `decrypt_sfx.py`. Needed a crypto dependency (decision 40): Chromium has X25519 but neither ChaCha20 nor BLAKE2b. Custody survives it — both agreements happen in WebCrypto and only their results reach the library. **Superseded plan:** `.sfx` open for `@PARAM/param.sfx` and for downloaded logs. This is where decision 10 actually changes, and it is worth being blunt in review: the moment this lands, the tool performs cryptography. It should be one module, it should take the agreement from T8's custody layer rather than a raw key, and nothing else in `src/` should import a cipher. |

Encrypted applet install routes through the existing seam — the tool moves an
opaque blob and never inspects it. **Landed 2026-09-07** (`kind: 'lua-applet'`,
which is what the code actually calls it): `src/protocol/lxa.ts` reads the
envelope and nothing else, and the Field tools page installs one.

The tool checks **one** thing before uploading, and it is the address rather
than the contents. The `.lxa` v2 header carries the target drone's UID in the
clear, put there so the firmware can refuse somebody else's applet without
spending a decryption on it; reading the same field in the tool refuses in the
same breath the operator chose the file. It is not the enforcement — the drone
refuses regardless — it is the difference between finding out now and finding
out from a log line after a scripting restart.

The same change made an older claim true. `field-tools.ts` said asset uploads
route through the seam and they did not: `lua-engine.ts` went straight to FTP,
against the rule below, with a comment asserting the opposite. Applets and
modules now go through `defaultUploader` as encrypted applets do.

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

Designed (2026-09-07), not built. A log is written to the card inside the
`.sfx` envelope, encrypted to the owner keypair — see "Outbound
confidentiality" for the construction, the format and the measured cost. Two
things make it unusually cheap: `crypto_xchacha20_ctr()` is seekable, so the
existing io-thread write path needs no reframing and the file does not change
length; and log listing and download read the filesystem mtime and raw byte
offsets rather than the file's contents, so neither MAVLink path changes at
all.

This is the **highest-value** of the outbound artefacts, because the SD card is
the one place drone data sits outside F6's seal: a stolen card gives up every
flight path in cleartext today, with no link access needed.

The Phase 4 download path **must not** assume cleartext-only — design the
pipeline to allow a `decrypt(bytes) → bytes` step in the middle, even if the
first slice ships without one. Decryption belongs off-drone, in
`../analysis-private/` or SFD tooling; the tool's job is to hand over the
owner key's agreement, not to become a log parser.

## What contributors must NOT do

- **Don't put SFD key material in this tool.** No master secrets, no signing
  keys, no drone private keys. The one key the tool may broker is the
  **operator's own**, for outbound decryption, and even that must live outside
  the tool's storage where the platform allows (PLAN.md decision 37). If you
  find yourself adding a second exception, the design has drifted.
- **Don't reuse the drone identity keypair for outbound artefacts.** It runs
  the wrong way: everyone holding a `sfd-identity/1` file has the public half,
  so "encrypted to the drone" is not a restriction on who can read what the
  drone sends. Outbound goes to the owner key.
- **Don't encrypt a settings backup to the drone's identity.** The exit
  ceremony mass-erases that identity, so the backup would become unreadable
  precisely when the restore needs it. The owner key is the only one that
  outlives the airframe.
- **Don't call an encrypted log tamper-evident.** Its body carries no MAC, by
  a deliberate trade against power-loss truncation. Confidentiality only.
- **Don't conclude a write-once operation failed without reading back.** Both
  of them have completed the write and answered nothing. "It failed" about a
  drone that is now permanently keyed is the worst answer available.
- **Don't ship `Tools/bootloaders/<board>_bl.bin` as a plain build for an SFD
  board.** The one in the tree carries no key, identity or owner region, so the
  ROMFS update path and `_with_bl.hex` would both quietly un-secure a board.
- **Don't take a nonce from `rand()` on any path with a long-lived key.**
  `hal.util->get_true_random_vals()` exists. The existing `create_nonce()` is
  safe only because every `.lxa` has a unique ephemeral key.
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
- **Don't widen what the crypto library is used for.** `@noble/*` is here to
  read `.sfx` and nothing else (decision 40). The owner key itself stays a
  non-extractable WebCrypto key; if you find yourself passing raw private key
  bytes to a library, the custody property is gone and decision 37 with it.
- **Don't introduce a backend service** "to handle key exchange" without a
  PLAN.md decision. The design is deliberately serverless.
- ~~**Don't import a competing crypto library.**~~ **Superseded 2026-09-07**
  (decision 40). It held while the tool performed no cryptography. Reading a
  `.sfx` needs XChaCha20-Poly1305 and BLAKE2b and Chromium has neither, so
  `@noble/ciphers` and `@noble/hashes` are in — for that and nothing else. Use
  the Web Crypto API wherever it can do the job, which for the key agreement
  it can and must.
- **Don't re-enable `string.dump` or the `debug`/`os`/`package` Lua libraries.**
  They are already disabled in `linit.c` and `lstrlib.c`; that is what stops a
  customer's own script extracting bytecode from a Pro applet sharing the
  `lua_State`. Worth a regression test.
