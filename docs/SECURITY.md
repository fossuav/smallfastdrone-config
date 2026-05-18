# Security Design

> Read [PLAN.md](../PLAN.md) and [ARCHITECTURE.md](ARCHITECTURE.md) first.

## v1 stance

**The tool ships with the security seam, not the implementation.** Crypto exists elsewhere:

- An existing **smallfastdrone firmware PR** adds support for encrypted Lua scripts using the signed-firmware infrastructure on the FC side.
- A separate **Python tool** performs off-FC encryption of those Lua scripts.

v1 of `smallfastdrone-config` does not duplicate or replace either. v1 must:

- Define the abstraction (`SignedArtifactUploader`) so future implementations drop in cleanly.
- Never introduce upload paths that bypass the abstraction.
- Document the future flow so a contributor can pick up the integration without re-deriving the design.

## Threat model (target, not v1 reality)

- **Adversary:** an operator with physical access to the FC but not the legitimate operator's signing key.
- **Goals:**
  - Prevent installation of unauthorized firmware, Lua scripts, or modifications.
  - Prevent extraction of cleartext logs from a recovered FC.
  - Allow the legitimate operator to install signed artifacts using a key bound (locally, then remotely) to the FC.

## Components — current and future

| Component | Where it lives | Status |
|---|---|---|
| Encrypted Lua loader on FC | smallfastdrone firmware (existing PR) | Implemented elsewhere |
| Off-FC Lua encrypter | Operator's existing Python tool | Implemented elsewhere |
| Signed firmware infrastructure on FC | smallfastdrone bootloader | Implemented elsewhere |
| `SignedArtifactUploader` seam | This tool, `src/security/uploader.ts` | v1 — passthrough impl |
| Local key store integration | This tool | Post-v1 |
| Remote key exchange | This tool + future authorising service | Post-v1; design only |
| Encrypted log retrieval | smallfastdrone firmware + this tool | Post-v1 |

## The seam

`src/security/uploader.ts`:

```ts
interface SignedArtifactUploader {
  // Returns true if FC requires signed artifacts of the given kind.
  requires_signature(kind: ArtifactKind): Promise<boolean>;

  // Verify-then-upload. v1 impl: passthrough. v2+: real signature verification.
  upload(kind: ArtifactKind, bytes: Uint8Array, opts?: UploadOpts): Promise<UploadResult>;
}

type ArtifactKind = 'firmware' | 'lua_script' | 'mission' | 'param_blob' | 'esc_firmware';
```

**The rule:** every upload from the tool to the FC (or to an ESC via the FC) goes through this. UI never calls `protocol/files.ts`, `protocol/dfu.ts`, or `protocol/fourway.ts` upload primitives directly. Stores route uploads through the artifacts store, which delegates to the uploader.

**DFU firmware flashing is the primary v1 use case for this seam.** Phase 5 wires DFU into `upload(kind: 'firmware', ...)`. The v1 implementation is passthrough — no signature verification — but the call site is correct, so the signature-verification implementation drops in later without touching the DFU view or store.

**ESC firmware (BLHeli flash) is also routed through the seam.** ESC firmware blobs are third-party artifacts; treating them as `'esc_firmware'` lets future versions demand a signature or a checksum match against a known catalog before flashing.

## Local-keys phase (post-v1, pre-remote)

When local keys are wired in:

- Operator's signing key lives on disk or in a hardware token (PKCS#11 / FIDO).
- Tool prompts for unlock when an upload requires signature.
- Tool computes the signature; uploads the signed artifact to the FC.
- FC verifies against pre-installed public key (already in firmware via the existing PR).

For Lua scripts specifically, the tool may shell out to (or instruct the operator to run) the existing Python encrypter; integration mode TBD at the time the work is picked up.

## Remote key exchange (future)

Motivating scenario: operator wants to install a Lua script that exposes a feature only authorised operators may use. The script is encrypted against a key derived from a session-time exchange between this tool and a remote authoriser, which holds the master key paired with the firmware's installed public key.

Tool's role: orchestrate the exchange (challenge → remote signs → FC accepts). Tool **never holds** the long-term master key. Exchange happens at install time, not at flight time.

This is a v2+ feature. v1 only needs to ensure the upload abstraction can accept a "session-bound" upload variant without a refactor.

## Logs

Encrypted log retrieval (future) will:

- Pull encrypted .bin via MAVLink `LOG_REQUEST_DATA`.
- Decrypt with the operator's local key (or a key fetched via remote exchange).
- Hand the decrypted .bin to `../analysis-private/`.

The Phase 4 log download path **must not** assume cleartext-only; design the pipeline to allow a `decrypt(bytes) → bytes` step in the middle, even when v1 ships without it.

## What v1 contributors must NOT do

- Don't add direct firmware-upload paths in UI components or views. **DFU is no exception** — `protocol/dfu.ts` exposes the DFU primitive; `security/uploader.ts` is the only legitimate caller.
- Don't add direct ESC-firmware-flash paths. The 4-way `flash` primitive in `protocol/fourway.ts` is only callable via `security/uploader.ts` with `kind: 'esc_firmware'`.
- Don't bake assumptions about cleartext-only logs into the log pipeline.
- Don't introduce a backend service "to handle key exchange" without a PLAN.md decision.
- Don't import a competing crypto library. If v1 ends up needing any client-side crypto (it shouldn't), use the Web Crypto API.
- Don't re-implement the Python Lua encrypter in JS. Out of scope for v1; revisit when integrating.
