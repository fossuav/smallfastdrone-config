# Coding Standards

> Adopted standards are authoritative. Deviations require a PLAN.md decision.
>
> If you're an AI tool generating code here, follow this doc literally. Generic patterns that look idiomatic-in-general but conflict with these standards are not acceptable — that's the "AI slop" we're explicitly trying to avoid.

## Adopted standards

### Vue components — Vue.js official Style Guide

We adopt the **Vue.js official Style Guide** at <https://vuejs.org/style-guide/> in full at:

- **Priority A — Essential** (rules that prevent bugs)
- **Priority B — Strongly Recommended** (rules for readability and team consistency)

Priority C and D are case-by-case; defer to `@antfu/eslint-config` defaults.

Key Vue rules (not exhaustive — read the source):

- **Multi-word component names** always (`WizardPhase.vue`, not `Phase.vue`).
- **Detailed prop definitions** — use the TS generic form: `defineProps<{ foo: string; bar?: number }>()`.
- **Keyed `v-for`** — every `v-for` has a `:key`.
- **Never `v-if` on the same element as `v-for`** — split into two elements or use a computed.
- **PascalCase component filenames** (`WizardPhase.vue`).
- **`<script setup>` first** in single-file components, then `<template>`, then `<style>`.
- **Self-close components** that have no slot content (`<DroneModel />`).
- **One attribute per line** when an element has multiple attributes.
- **Composition API only** — Options API is not used in this codebase.

### Enforcement — `@antfu/eslint-config`

We use **Anthony Fu's ESLint flat config** for lint + format enforcement.

- De facto standard in the modern Vue / Vite / Nuxt ecosystem.
- Includes `eslint-plugin-vue` pre-configured for the Vue Style Guide.
- Includes TypeScript rules reflecting current community best practices.
- Built-in formatter via `@stylistic` — **no Prettier needed**.
- Flat config in `eslint.config.ts`.

**This replaces the earlier Biome decision** (PLAN.md row 12). Biome's Vue SFC support is not first-class in 2026, and the Vue ecosystem's tooling centre of gravity is ESLint + antfu's config.

Anticipated `eslint.config.ts`:

```ts
import antfu from '@antfu/eslint-config'

export default antfu({
  vue: true,
  typescript: true,
  stylistic: {
    indent: 2,
    quotes: 'single',
    semi: false,
  },
})
```

### Editor — `.editorconfig`

A `.editorconfig` file in repo root for cross-editor consistency. Standard format from <https://editorconfig.org/>. Covers indent, charset, EOL, trim trailing whitespace, final newline.

### TypeScript

No single canonical TS style guide is universally adopted; we use `@antfu/eslint-config`'s TS rules, which encode current community best practices. The TS-specific principles we follow on top:

- **`strict: true`** in `tsconfig.json`. Also `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`.
- **No `any`.** Use `unknown` and narrow with type guards.
- **`interface` for object shapes**, `type` for unions / intersections / mapped types.
- **Vue 3 generic forms:** `defineProps<{ ... }>()`, `defineEmits<{ ... }>()`.
- **Pinia Setup Stores:** `defineStore('name', () => { ... })`.

### Vue ecosystem specifics

- **Composables** live in `src/composables/` and start with `use` (`useDroneSession`, `useParamWrite`).
- **Auto-imports off** — explicit imports only. AI tools tend to assume auto-import is on and produce code that looks magic; we don't do that.
- **Component registration is per-file via direct import** — no global registration.
- **Style scoping via Tailwind utilities first.** `<style scoped>` blocks only when Tailwind genuinely can't express it.

## What "AI slop" looks like — explicitly avoid

These patterns are common in AI-generated Vue/TS code and conflict with the standards above:

- **Options API.** We use Composition API exclusively.
- **Lower-case or single-word component names** (`drone.vue`, `phase.vue`).
- **Untyped `defineProps`** (`defineProps(['foo'])` instead of `defineProps<{ foo: string }>()`).
- **Explicit `name: 'Foo'` registration** in `<script setup>` files — Vue derives the name from the filename, don't add it manually.
- **`any` types as a shortcut**, or `as any` casts to silence errors.
- **Mixing styling approaches** — don't combine Tailwind utilities, `<style scoped>`, and inline `style` attributes for the same concern.
- **Comments that re-state the code** (`// set value to 5`). Comments explain *why*, not *what*. See the dedicated "Comments and file headers" section below for what's required vs forbidden.
- **Excessive defensive coding** — try/catch around code that can't throw, validation of internal call sites, null-checks for values that can't be null.
- **Premature abstraction** — a `BaseComponent` with one consumer, a generic "service" wrapper around a single API call.
- **Auto-import assumptions** — referencing `ref`, `computed`, `defineStore`, etc. without imports. We use explicit imports.
- **JSDoc on everything.** TS types carry the contract. JSDoc only where there's genuine prose context that types can't express.
- **`v-html`** unless content has been explicitly sanitised and the use case is documented.
- **`watch` chains where a `computed` would do.** Reactive derivation, not imperative reaction.
- **Returning huge objects from Pinia stores** when the consumer needs two fields.

## Comments and file headers

Adopted from the ArduPilot AI playbook at `../aap/cpp/AI_PAIR_PROGRAMMING_PLAYBOOK_CPP.md`. This tool ships alongside SmallFastDrone (GPLv3) and follows the same documentation discipline as the firmware it configures. C++-specific rules from the aap playbook (unit-suffixed names, manual memory init, multiplication-over-division) don't apply here; the documentation discipline does.

### File headers

**Every hand-written `.ts` and `.vue` file in `src/` and `test/` starts with two things:**

1. A GPLv3 license header (block comment).
2. A one-paragraph file purpose statement immediately after.

TypeScript file template:

```ts
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

// <File purpose: what this file is, why it exists, what shape its exports
// take. Cross-reference adjacent files when the boundary isn't obvious. A
// new reader picks up cold from this.>

import { /* … */ } from './…'
```

Vue SFC template — the block goes at the top of `<script setup>`, since SFCs don't have a stable "top of file" before the first block:

```vue
<script setup lang="ts">
/*
 * This program is free software: you can redistribute it and/or modify
 * ...
 * along with this program. If not, see <http://www.gnu.org/licenses/>.
 */

// <File purpose: what this component is, what it renders, when it's used.>

import { /* … */ } from './…'
</script>
```

**Exempt:** generated files (`vite-env.d.ts`, `components.d.ts`), `eslint.config.ts` and config files whose contents are purely tool-config. Test fixtures keep the header but the purpose paragraph can be a single sentence.

### Function comments

**Every exported function and every non-trivial internal function has a lead-in `//` comment explaining its purpose.** For non-trivial inputs/outputs, the comment also describes the parameters and what's returned. Plain `//` comments are preferred over JSDoc — TS types carry the contract; the comment carries the intent.

```ts
// Decode the AUTOPILOT_VERSION flight_sw_version field into the operator-
// facing version string. ArduPilot packs major/minor/patch/FW_TYPE into
// one uint32; the FW_TYPE byte (dev/alpha/beta/rc/official) drives the
// suffix shown to operators ("4.7.0-beta", "4.6.3"). gitHash is the
// short hash from flight_custom_version and is appended in parens.
export function decodeFirmwareVersion(sw: number, gitHash: Uint8Array): string {
  // ...
}
```

Trivial getters and one-liners with operator-obvious purpose don't need a comment — the bar is "would a new reader stall here without one." Prefer a single descriptive line over a multi-paragraph docstring.

### "Why, not what"

Comments explain motivation, intent, or constraint. They never re-state what well-named identifiers already describe.

- **Right:** `// SITL doesn't stream SYS_STATUS to fresh clients; ask for it explicitly.`
- **Wrong:** `// Send the REQUEST_DATA_STREAM message.`

For non-obvious calculations, state-machine transitions, or workarounds, a comment that names the constraint is mandatory — even if the code is short.

### Non-conversational style — forbidden content

Comments are written for someone meeting the code for the first time. They never reference:

- The conversation, review, or development process that produced the code (`// As discussed`, `// Fixing the bug from PR review`).
- The author or specific commit (`// Andy added this`, `// See commit abc123`).
- Debugging history (`// Was 500ms, increased after intermittent failure`).
- TODOs without an owner and a tracked issue.

If a value's history matters, the commit message is the place. The codebase is read forwards by future contributors, not as a transcript of how it got here.

## How to apply

- `bun run lint` before commits. CI fails on lint errors.
- `bun run lint:fix` for auto-fixable issues.
- Editors with the ESLint extension pick up the flat config automatically.
- When in doubt about a Vue idiom, the **Vue Style Guide is the tiebreaker**.
- When in doubt about a TS idiom, run the linter — if it doesn't complain, it's fine.

## References

- Vue.js Style Guide — <https://vuejs.org/style-guide/>
- `@antfu/eslint-config` — <https://github.com/antfu/eslint-config>
- EditorConfig — <https://editorconfig.org/>
- TypeScript Handbook — <https://www.typescriptlang.org/docs/handbook/intro.html>
- Pinia Setup Stores — <https://pinia.vuejs.org/core-concepts/#setup-stores>
