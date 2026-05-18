# Architecture

> Read [PLAN.md](../PLAN.md) for mission and phase plan first.

## Layered view

```
┌─────────────────────────────────────────────────────────┐
│  UI (Vue 3 + Nuxt UI 4 + Tailwind)                       │
│  — Connect screen                                         │
│  — Bringup wizard host                                    │
│  — Recipe runner                                          │
│  — Param browser/editor                                   │
│  — Log download                                           │
└─────────────────────────────────────────────────────────┘
                       │
┌─────────────────────────────────────────────────────────┐
│  Workflow                                                 │
│  — Wizard state machine (per-phase: pre/action/verify)    │
│  — Recipe runner (ordered batches with verifies)          │
│  — Bringup progress persistence (IndexedDB)               │
└─────────────────────────────────────────────────────────┘
                       │
┌─────────────────────────────────────────────────────────┐
│  Domain stores (Pinia)                                    │
│  — Drone session (sysid, fc version, frame, link state)   │
│  — Params (cache, dirty set, write queue, source attr.)   │
│  — Wizard progress                                        │
│  — Logs (catalog, downloads)                              │
│  — Artifacts (security seam state)                        │
└─────────────────────────────────────────────────────────┘
                       │
┌─────────────────────────────────────────────────────────┐
│  Protocol                                                 │
│  — MAVLink (node-mavlink) — primary, params/logs/mission  │
│  — MSP — minimal, only for BLHeli passthrough entry       │
│  — BLHeli 4-way interface — ESC settings + firmware flash │
│  — DFU (STM32 class) — firmware flashing                  │
│  — Heartbeat / link health                                │
│  — Protocol mode switcher (single-port multi-protocol)    │
└─────────────────────────────────────────────────────────┘
                       │
┌─────────────────────────────────────────────────────────┐
│  Transport                                                │
│  — WebSerial (CDC-ACM: MAVLink, MSP, 4-way)               │
│  — WebUSB     (DFU class)                                 │
│  — (future: WebSocket bridge for SITL via UDP)            │
└─────────────────────────────────────────────────────────┘
```

**Dependency rule:** flow only downward. UI imports from workflow and stores; workflow imports from stores and protocol; stores import from protocol; protocol imports from transport. Never upward, never sideways across siblings of the same layer without going through stores.

## Module layout (proposed)

```
src/
├── App.vue
├── main.ts
├── router.ts
├── ui/                  # presentational Vue components (no business logic)
│   ├── components/        # generic reusable components
│   ├── visuals/           # 3D drone (Tres.js), motor map, spectrum plot, sticks, vibration sparkline
│   └── illustrations/     # hand-drawn SVGs for cal procedures, RC layout, throw posture, etc.
├── views/               # routed pages
│   ├── ConnectView.vue
│   ├── WizardView.vue
│   ├── ParamsView.vue
│   ├── RecipesView.vue
│   ├── LogsView.vue
│   ├── FirmwareView.vue   # DFU flash
│   └── EscToolsView.vue   # MSP entry + 4-way ESC settings/flash
├── stores/              # Pinia
│   ├── session.ts
│   ├── params.ts
│   ├── wizard.ts
│   ├── logs.ts
│   ├── escs.ts            # 4-way enumeration + per-ESC settings
│   └── artifacts.ts
├── workflow/
│   ├── wizard/          # phase definitions, state machine
│   └── recipes/         # SFD-flavoured recipes (data, not code where possible)
├── protocol/
│   ├── mavlink.ts         # node-mavlink session
│   ├── params.ts          # PARAM_REQUEST_LIST / PARAM_SET / PREFLIGHT_STORAGE
│   ├── logs.ts            # LOG_REQUEST_*
│   ├── files.ts           # MAVFTP / file-transfer (used only via security/uploader)
│   ├── health.ts          # heartbeat / link
│   ├── msp.ts             # minimal MSP — BLHeli passthrough entry/exit only
│   ├── fourway.ts         # BLHeli 4-way interface (read/write settings, ESC flash)
│   ├── dfu.ts             # STM32 DFU class
│   └── mode.ts            # protocol mode switcher (MAVLink ↔ MSP ↔ 4-way; guaranteed exit)
├── transport/
│   ├── webserial.ts       # CDC-ACM (production)
│   ├── webusb.ts          # DFU (production)
│   ├── websocket.ts       # E2E only — talks to test/sitl/bridge.ts; selected via URL param
│   └── types.ts           # Transport interface — the seam that enables SITL-based testing
└── security/
    └── uploader.ts        # SignedArtifactUploader interface (passthrough impl in v1)
```

The directory layout deliberately mirrors the layered view: each layer is a top-level directory.

## Data model

### Drone session

```ts
interface DroneSession {
  connected: boolean;
  sysid: number;             // from heartbeat
  compid: number;
  autopilot: 'ardupilot' | 'unknown';
  vehicle_type: 'copter' | 'plane' | 'rover' | string;
  firmware_version: string;  // e.g. "SFD 4.7.0-beta3"
  frame_class?: number;      // populated once params loaded
  frame_type?: number;
  link: {
    rssi?: number;
    drop_rate: number;
    last_heartbeat_at: number;
  };
}
```

### Params

```ts
interface Param {
  name: string;
  value: number;
  default?: number;
  source: 'fc' | 'user-staged' | 'recipe-staged';
  dirty: boolean;
  last_write_status?: 'pending' | 'acked' | 'failed';
  meta?: ParamMeta;          // range, units, group — from apm.pdef.xml at build time
}
```

Param store invariants:
- Keyed by name.
- A staged change is dirty until written and ACKed.
- Reading from FC overwrites `value` only when not dirty (don't clobber operator edits).
- Recipe and wizard staging both share the same dirty set; commit is a single batched write-and-save.

### Wizard progress

Stored in IndexedDB keyed by `sysid + frame_fingerprint`. Schema is the wizard state machine's snapshot — phase, step, gate decisions with timestamps.

## Security seam

**Rule:** every artifact uploaded to the FC goes through `src/security/uploader.ts`.

```ts
interface SignedArtifactUploader {
  requires_signature(kind: ArtifactKind): Promise<boolean>;
  upload(kind: ArtifactKind, bytes: Uint8Array, opts?: UploadOpts): Promise<UploadResult>;
}

type ArtifactKind = 'firmware' | 'lua_script' | 'mission' | 'param_blob';
```

v1 implementation: passthrough to `protocol/files.ts`. Future implementations layer in:
- Local-key signature
- FC-bound key derivation (existing smallfastdrone PR)
- Remote-key-exchange session

UI never calls `protocol/files.ts` directly. If you find yourself reaching past the uploader, stop and update [SECURITY.md](SECURITY.md).

## Transport abstraction (and how testing depends on it)

`src/transport/types.ts` defines a single `Transport` interface. Production code instantiates `WebSerialTransport` or `WebUSBTransport`. E2E tests instantiate `WebSocketTransport` (selected at app load via `?transport=websocket&host=...` URL param). Integration tests skip the browser entirely and use `TcpTransport` (Node-side, in `test/integration/transport/tcp.ts`) to speak MAVLink directly to SITL.

**Production code does not import test transports.** No conditional compilation, no test code in the production bundle. The seam is the URL-param-driven selection in `main.ts`.

This is the design that makes [docs/TESTING.md](TESTING.md) possible. Don't break it by inlining a transport pick inside a store or a view.

## Protocol mode switching

The same physical USB connection may carry multiple protocols over its lifetime. When entering BLHeli passthrough on the MAVLink USB port, the wire protocol changes from MAVLink → MSP → 4-way and must return cleanly to MAVLink afterwards.

Rules enforced by `protocol/mode.ts`:

- Mode transitions are explicit. There is no automatic protocol detection on bytes; the operator (or the workflow) requests a transition.
- Every transition has a guaranteed exit. If 4-way enters error, mode switcher forces a return to MAVLink (or, worst case, a port close + operator-prompted re-open).
- Stores are protocol-aware. The session store exposes `current_protocol` so UI can disable incompatible actions during a transition.
- WebUSB (DFU) is a separate transport; it owns the device. Switching between WebSerial and WebUSB requires close-then-reopen and a fresh user permission grant in some browsers.

## Open architectural questions

- **Wizard state machine.** XState (heavyweight) vs hand-rolled (simpler, no dep). Lean toward hand-rolled given small phase count; revisit at Phase 2 close if branching gets complex.
- **Param metadata source.** Build-time `apm.pdef.xml` import vs runtime fetch. Prefer build-time so the PWA has no runtime dependency on a smallfastdrone build directory.
- **Recipe representation.** Data (JSON/YAML in `src/workflow/recipes/`) vs code (TS module). Lean data-first; lift to code only when a recipe needs branching or computation.
- **node-mavlink dialect bundling.** Generated TS at build time vs runtime XML fetch. Prefer build-time generation.
- **MSP entry path.** ArduPilot can do BLHeli passthrough either over a serial port configured as `SERIAL*_PROTOCOL = MSP`, or over the MAVLink link itself via a MAVLink command that flips `AP_BLHeli` into passthrough mode on that port. v1 should support both; first implementation may be MAVLink-triggered passthrough on the connected port.
- **ESC firmware blob source.** Bundled at build time, fetched on demand, or operator-supplied? Affects build pipeline and the security seam (these blobs are also artifacts and should arguably go through the uploader).
