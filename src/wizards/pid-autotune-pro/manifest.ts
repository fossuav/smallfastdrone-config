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

// Locked stub for a Pro tuning wizard. Ships only a manifest — no
// DesktopView, since the Start affordance for locked wizards is a
// no-op. Exists in v1 to exercise the commercial gating seam from day
// one: the library card renders greyed-out with a Pro badge and the
// unlock blurb, so the operator-facing affordance is visible alongside
// real wizards before any paid wizards actually ship.

import type { WizardManifest } from '../../workflow/wizard-runtime'

export const manifest: WizardManifest = {
  id: 'pid-autotune-pro',
  title: 'Pro PID tune',
  description: 'Sophisticated step-response analysis with auto-iteration and per-axis seeding.',
  category: 'tune',
  hero: 'i-lucide-sparkles',
  outcome: 'A tuned drone — without a flight engineer in the loop.',
  // No real engines yet; declared as desktop so the manifest shape
  // validates. The locked flag short-circuits engine resolution.
  engines: [{ kind: 'desktop' }],
  owns_params: [],
  prerequisites: [],
  in_flight: true,
  requires_props_off: false,
  locked: true,
  unlock_blurb: 'Coming soon — a paid Pro wizard that walks the drone through axis-by-axis step responses, recommends gains, and re-tests until convergence.',
}
