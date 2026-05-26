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

// Wizard runtime — the engine that backs the wizard library + every
// individual wizard. Owns:
//
//   - The WizardManifest type all wizards declare.
//   - The build-time registry that scans src/wizards/*/manifest.ts via
//     Vite glob and pairs each manifest with its lazy-loadable
//     DesktopView component.
//   - Capability detection — a snapshot of what the connected FC + the
//     current session support, used to filter the library and to pick
//     an engine when (later) multiple engines are declared.
//   - Pre-requisite checks — plain-language reasons a wizard refuses
//     to start, returned to the runner view for display.
//
// Slice A implements only the desktop engine. The shape of the manifest
// is the full WIZARDS.md contract so future Lua / log engines slot in
// without rework, but those engine kinds aren't decoded here yet.

import type { Component } from 'vue'

// Top-level category — used by the library to group / filter cards.
export type WizardCategory = 'bringup' | 'tune' | 'recipe' | 'diagnostic' | 'safety'

// Engine descriptor — the wizard's back-end implementation. `lua`
// shipped in Phase 2 slice C alongside the first Lua-engine wizard;
// `log` lands when Phase 4's narrow .bin parser does. The runtime
// doesn't yet pick engines by capability (every shipped wizard
// declares exactly one) — it's the wizard's DesktopView that
// orchestrates the engine's specifics. The shape is still a
// discriminated union so future engine-selection logic slots in
// without churn.
export type EngineDescriptor
  = | { kind: 'desktop' }
    | { kind: 'lua', applet: string, requires?: { scripting?: true, minHeapKb?: number } }

// Plain-language prerequisite the operator must satisfy before the
// wizard can start. The kind drives the programmatic check; the message
// is shown verbatim in the UI if the check fails.
export type Prereq
  = | { kind: 'connected', message: string }
    | { kind: 'heartbeat', message: string }
    | { kind: 'params_loaded', message: string }

// The full manifest. Every wizard ships one at src/wizards/<id>/manifest.ts
// as a named `manifest` export. Contract is documented in docs/WIZARDS.md.
export interface WizardManifest {
  id: string
  title: string
  description: string
  category: WizardCategory
  // Lucide icon name (`i-lucide-…`) for v1; later slices may swap this
  // for an illustration path or a 3D scene id.
  hero: string
  // One-line operator-facing statement of what the wizard achieves.
  outcome: string
  // Engines the wizard supports, in priority order.
  engines: EngineDescriptor[]
  // Param names this wizard reads and/or writes. Declared so the
  // future runtime can lock them from concurrent edits and snapshot
  // before/after; not yet enforced in slice A.
  owns_params: string[]
  prerequisites: Prereq[]
  // Lifecycle flags — see docs/WIZARDS.md "Manifest".
  in_flight: boolean
  requires_props_off: boolean
  // The wizard can also run in the field via the radio's CRSF menu (a Lua
  // applet the operator installs from the desktop, then uses without a
  // laptop). Drives a "field-capable" badge in the library; the install
  // lifecycle lives in the wizard's DesktopView.
  field_capable?: boolean
  // Commercial gating seam. `locked: true` greys the card and replaces
  // Start with a "Coming soon" affordance; no real entitlement check
  // in v1.
  locked?: boolean
  unlock_blurb?: string
  // Render this wizard in the runner's wider canvas (max-w-5xl vs the
  // default max-w-3xl). For wizards whose surface is a dashboard rather
  // than a single-column flow — e.g. the bringup ribbon's tabs + config
  // panel + inline child wizard want the extra horizontal real estate.
  wide_layout?: boolean
}

// A manifest paired with a lazy loader for its DesktopView component.
// The loader keeps the view's bundle out of the entry chunk; views are
// fetched on demand when the operator opens a wizard.
export interface RegisteredWizard {
  manifest: WizardManifest
  loadDesktopView: () => Promise<Component>
}

// Vite glob imports — manifests are eager (so the library can render
// every card on first paint), views are lazy (only loaded when the
// operator picks a wizard).
const manifestModules = import.meta.glob<{ manifest: WizardManifest }>(
  '../wizards/*/manifest.ts',
  { eager: true },
)
const viewModules = import.meta.glob<{ default: Component }>(
  '../wizards/*/DesktopView.vue',
)

// Build the registry from the glob results, pairing each manifest with
// the matching DesktopView in the same folder. Locked stub wizards may
// omit the view file; their loader rejects if invoked but the library
// never invokes it because the Start button is a no-op for locked rows.
function buildRegistry(): RegisteredWizard[] {
  const out: RegisteredWizard[] = []
  for (const [manifestPath, mod] of Object.entries(manifestModules)) {
    const dir = manifestPath.replace(/\/manifest\.ts$/, '')
    const viewPath = `${dir}/DesktopView.vue`
    const loader = viewModules[viewPath]
    out.push({
      manifest: mod.manifest,
      loadDesktopView: loader
        ? async () => (await loader()).default
        : async () => {
          throw new Error(`Wizard "${mod.manifest.id}" has no DesktopView.vue`)
        },
    })
  }
  // Stable order by id — keeps the library predictable for E2E selectors.
  out.sort((a, b) => a.manifest.id.localeCompare(b.manifest.id))
  return out
}

// Cached registry — manifests are statically imported, so a single
// build pass is fine for the lifetime of the page.
let cached: RegisteredWizard[] | null = null

// Return every wizard the build bundled. The library view iterates this.
export function getWizards(): RegisteredWizard[] {
  cached ??= buildRegistry()
  return cached
}

// Look up a single wizard by id. Returns undefined for unknown ids so
// the runner view can render a 404-style "no such wizard" card instead
// of throwing.
export function getWizard(id: string): RegisteredWizard | undefined {
  return getWizards().find(w => w.manifest.id === id)
}

// Snapshot of what the connected FC + session currently support.
// Wizards consult this to decide whether their prereqs are satisfied
// and (later) which engine kind to instantiate.
export interface CapabilitySnapshot {
  connected: boolean
  heartbeat: boolean
  params_loaded: boolean
}

// Result of running a manifest's prereqs against a capability snapshot.
// `missing` carries the operator-facing reason strings for the prereqs
// that failed, in declaration order.
export interface PrereqResult {
  ok: boolean
  missing: string[]
}

// Check every prereq in `prereqs` against the snapshot. Returns ok=true
// only when all prereqs pass; otherwise returns the operator-facing
// reason strings for the failing ones.
export function checkPrereqs(prereqs: Prereq[], caps: CapabilitySnapshot): PrereqResult {
  const missing: string[] = []
  for (const p of prereqs) {
    if (p.kind === 'connected' && !caps.connected)
      missing.push(p.message)
    else if (p.kind === 'heartbeat' && !caps.heartbeat)
      missing.push(p.message)
    else if (p.kind === 'params_loaded' && !caps.params_loaded)
      missing.push(p.message)
  }
  return { ok: missing.length === 0, missing }
}

// Operator-facing label per category — drives the badge on each card.
export function categoryLabel(c: WizardCategory): string {
  switch (c) {
    case 'bringup': return 'Bringup'
    case 'tune': return 'Tuning'
    case 'recipe': return 'Recipe'
    case 'diagnostic': return 'Check'
    case 'safety': return 'Safety'
  }
}
