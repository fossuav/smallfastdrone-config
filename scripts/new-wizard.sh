#!/usr/bin/env bash
# Scaffold a new wizard folder so the boilerplate (GPL header, manifest
# shape, DesktopView conventions — returnTo, markComplete, the mandatory
# visual) doesn't get retyped or drift. Wizards are auto-discovered via
# Vite glob (src/workflow/wizard-runtime.ts), so dropping the folder is
# all the wiring there is — no registry edit.
#
# Usage:
#   scripts/new-wizard.sh <id> [Human Title words...]
#   bun run new:wizard throw-mode-setup Throw mode setup
#
# Options:
#   --category <bringup|tune|recipe|diagnostic|safety>   (default: tune)
#   --hero <i-lucide-name>                                (default: i-lucide-wand-sparkles)
#   --lua                  also scaffold applet.lua + a Lua engine in the manifest
#
# The result typechecks + lints clean and shows up in the library, but is
# a *stub*: every TODO marks a decision you must make (the visual, the
# operator copy, the params it owns, the actual work). It demonstrates the
# shape; it does nothing useful until you fill it in.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

ID=""
TITLE=""
CATEGORY="tune"
HERO="i-lucide-wand-sparkles"
LUA=0

while [ $# -gt 0 ]; do
  case "$1" in
    --lua) LUA=1; shift ;;
    --category) CATEGORY="${2:?--category needs a value}"; shift 2 ;;
    --hero) HERO="${2:?--hero needs a value}"; shift 2 ;;
    -h | --help) sed -n '2,20p' "$0"; exit 0 ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *) if [ -z "$ID" ]; then ID="$1"; else TITLE="$TITLE $1"; fi; shift ;;
  esac
done

[ -n "$ID" ] || { echo "usage: $0 <id> [Human Title...]" >&2; exit 2; }

# Wizard ids are kebab-case — they become the folder name, the route
# segment, and the markComplete key. Keep them machine-clean.
if ! printf '%s' "$ID" | grep -qE '^[a-z][a-z0-9-]*$'; then
  echo "id must be kebab-case (lowercase, digits, hyphens): got '$ID'" >&2
  exit 2
fi

case "$CATEGORY" in
  bringup | tune | recipe | diagnostic | safety) ;;
  *) echo "category must be one of: bringup tune recipe diagnostic safety" >&2; exit 2 ;;
esac

DIR="$REPO_ROOT/src/wizards/$ID"
[ -e "$DIR" ] && { echo "wizard already exists: src/wizards/$ID" >&2; exit 2; }

# Title defaults to the id with hyphens as spaces, first letter upper.
if [ -z "$TITLE" ]; then
  TITLE="$(printf '%s' "$ID" | tr '-' ' ')"
  TITLE="$(printf '%s' "${TITLE:0:1}" | tr '[:lower:]' '[:upper:]')${TITLE:1}"
else
  TITLE="${TITLE# }"
fi

DESC="TODO: one-line operator-facing summary (no parameter names, no acronyms)."
OUTCOME="TODO: what the operator has achieved when this finishes."

# Escape a string for the replacement side of sed s///.
esc() { printf '%s' "$1" | sed -e 's/[\/&\]/\\&/g'; }

subst() {
  sed \
    -e "s/__ID__/$(esc "$ID")/g" \
    -e "s/__TITLE__/$(esc "$TITLE")/g" \
    -e "s/__CATEGORY__/$(esc "$CATEGORY")/g" \
    -e "s/__HERO__/$(esc "$HERO")/g" \
    -e "s/__DESC__/$(esc "$DESC")/g" \
    -e "s/__OUTCOME__/$(esc "$OUTCOME")/g"
}

GPL='/*
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
 */'

mkdir -p "$DIR"

# ---- manifest.ts -----------------------------------------------------
if [ "$LUA" -eq 1 ]; then
  ENGINES="engines: [{ kind: 'lua', applet: 'applet.lua', requires: { scripting: true } }],"
else
  ENGINES="engines: [{ kind: 'desktop' }],"
fi

{
  printf '%s\n\n' "$GPL"
  subst <<'TPL'
// Manifest for the __TITLE__ wizard. TODO: describe what it owns + does.
// See docs/WIZARDS.md (manifest contract) + src/wizards/CLAUDE.md.

import type { WizardManifest } from '../../workflow/wizard-runtime'

export const manifest: WizardManifest = {
  id: '__ID__',
  title: '__TITLE__',
  description: '__DESC__',
  category: '__CATEGORY__',
  hero: '__HERO__',
  outcome: '__OUTCOME__',
__ENGINES__
  // Param names this wizard reads/writes (the operator never sees these).
  owns_params: [],
  prerequisites: [
    { kind: 'connected', message: 'Your drone needs to be connected.' },
    { kind: 'heartbeat', message: 'Waiting to hear from your drone — give it a moment after plugging in.' },
  ],
  in_flight: false,
  requires_props_off: false,
}
TPL
} | sed "s|__ENGINES__|  $ENGINES|" > "$DIR/manifest.ts"

# ---- DesktopView.vue -------------------------------------------------
{
  printf '<script setup lang="ts">\n'
  printf '%s\n\n' "$GPL"
  subst <<'TPL'
// __TITLE__ wizard — TODO: one-line purpose. Operator-facing view that
// orchestrates the wizard. Bringup-launched wizards honour ?returnTo=.
// See docs/WIZARDS.md + src/wizards/CLAUDE.md.

import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useSessionStore } from '../../stores/session'
import { useWizardProgressStore } from '../../stores/wizardProgress'

// Most wizards also drive params — uncomment when you wire the real work:
//   import { onMounted } from 'vue'
//   import { useParamsStore } from '../../stores/params'
//   const params = useParamsStore()
//   onMounted(() => { if (!params.loadedAt) params.load() })
//   const current = computed(() => params.params.get('ATC_RAT_PIT_P')?.value)
//   params.setEdit('ATC_RAT_PIT_P', 0.135); await params.apply()
// Lua-engine wizards drive the applet instead:
//   import { useLuaEngine } from '../../workflow/lua-engine'

const session = useSessionStore()
const wizardProgress = useWizardProgressStore()
const router = useRouter()
const route = useRoute()

// Back path: library by default; bringup passes ?returnTo=/wizard/bringup.
const returnTo = computed(() => String(route.query.returnTo ?? '/wizard'))

// Operator finished the wizard — record completion against this FC, then
// return to wherever the wizard was launched from.
function finish() {
  wizardProgress.markComplete(session.fcUid, '__ID__', '__OUTCOME__')
  router.push(returnTo.value)
}

// Operator backed out without finishing — no completion recorded.
function cancel() {
  router.push(returnTo.value)
}
</script>

<template>
  <div class="space-y-4">
    <!--
      TODO: every wizard step needs a real visual — an SVG illustration,
      a Tres.js 3D scene, an animation, or live data. The hero icon below
      is only a placeholder; a bare icon is not an acceptable final visual.
      See docs/UX.md "Visuals are utility".
    -->
    <div class="border-default flex flex-col items-center gap-3 rounded-md border bg-elevated/50 p-6">
      <UIcon name="__HERO__" class="text-primary size-12" />
      <p class="text-muted text-center text-sm">
        TODO: replace this card with the visual that makes this wizard's
        decision obvious.
      </p>
    </div>

    <p class="text-muted">
      TODO: operator-first copy — say what this wizard does in plain
      language. No parameter names, no MAVLink terms, no acronyms.
    </p>

    <div class="flex justify-end gap-2 pt-2">
      <UButton color="neutral" variant="ghost" @click="cancel">
        Cancel
      </UButton>
      <UButton color="primary" @click="finish">
        Done
      </UButton>
    </div>
  </div>
</template>
TPL
} > "$DIR/DesktopView.vue"

# ---- applet.lua (only with --lua) ------------------------------------
if [ "$LUA" -eq 1 ]; then
  subst <<'TPL' > "$DIR/applet.lua"
-- __TITLE__ — FC-side applet for the __ID__ wizard.
-- Conventions: docs/lua/CLAUDE.md + src/wizards/CLAUDE.md (read first).
-- Verify it loads cleanly on SITL:
--   bun run lua:check src/wizards/__ID__/applet.lua

-- Self-arm on a WIZ_<thing>_ACTIVE parameter the DesktopView toggles via
-- useLuaEngine().setParam. While dormant the applet sleeps on a long
-- interval and touches nothing.
local PARAM_TABLE_KEY = 0      -- TODO: pick an unused key (0-200), unique per applet
local PARAM_TABLE_PREFIX = 'WIZ_'  -- TODO: make the prefix unique per applet
assert(param:add_table(PARAM_TABLE_KEY, PARAM_TABLE_PREFIX, 1), 'could not add param table')
assert(param:add_param(PARAM_TABLE_KEY, 1, 'ACTIVE', 0), 'could not add ACTIVE param')
local active = Parameter('WIZ_ACTIVE')

local RUN_MS = 200
local IDLE_MS = 1000

local function update()
  if active:get() == 0 then
    return update, IDLE_MS  -- dormant until the desktop arms us
  end
  -- TODO: do the wizard's work. Report progress/results to the desktop as
  -- NAMED_VALUE_FLOAT (names are max 10 chars), e.g.:
  --   gcs:send_named_float('PROG', 0.5)
  -- Tolerate being killed mid-run; leave owned params at a sane value.
  return update, RUN_MS
end

gcs:send_text(6, '__TITLE__ applet loaded')
return update, IDLE_MS
TPL
fi

echo "created src/wizards/$ID/"
echo "  manifest.ts"
echo "  DesktopView.vue"
[ "$LUA" -eq 1 ] && echo "  applet.lua"
cat <<EONOTE

Next:
  1. Fill in the TODOs — description, outcome, the real visual, the work.
  2. owns_params: list every param the wizard reads/writes.
  3. Run it:  bun dev  → Bringup/Recipes library → "$TITLE"
  4. Add tests (see docs/TESTING.md): unit for any pure logic,
     E2E (test/e2e/) to drive it against SITL.$([ "$LUA" -eq 1 ] && printf '\n  5. Check the applet loads:  bun run lua:check src/wizards/%s/applet.lua' "$ID")
EONOTE
