<script setup lang="ts">
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

// The padlock that says this drone runs SmallFastDrone's secured firmware
// and startup software. Shown wherever the operator can see which drone
// they are talking to.
//
// It is deliberately quiet: absent entirely on an ordinary drone, rather
// than a crossed-out lock announcing that an unremarkable ArduPilot board
// is "not secure". Most drones are not SFD drones and there is nothing
// wrong with that, so only the presence of security is worth a badge.
// The one exception is a drone part way through an upgrade, which *is*
// worth flagging because there is a next step the operator can take.

import { computed } from 'vue'
import { useSessionStore } from '../../stores/session'
import { describePosture } from '../../workflow/drone-security'

const props = withDefaults(defineProps<{
  // `compact` is the header: icon only, with the words in its title.
  compact?: boolean
}>(), { compact: false })

const session = useSessionStore()
const copy = computed(() => describePosture(session.securityPosture))

// Part-way-upgraded is the only unsecured state worth showing, because it
// is the only one with something to do about it.
const partWay = computed(() => session.securityPosture === 'bootloader-outdated')
const show = computed(() => session.connected && (copy.value.locked || partWay.value))
const icon = computed(() => (copy.value.locked ? 'i-lucide-shield-check' : 'i-lucide-shield-alert'))
const tone = computed(() => (copy.value.locked ? 'text-primary' : 'text-warning'))
</script>

<template>
  <div
    v-if="show"
    class="inline-flex items-center gap-1.5"
    :title="copy.detail"
  >
    <UIcon :name="icon" :class="[tone, props.compact ? 'size-5' : 'size-4']" />
    <span v-if="!props.compact" class="text-xs font-medium" :class="[tone]">
      {{ copy.label }}
    </span>
    <span v-else class="sr-only">{{ copy.label }} — {{ copy.detail }}</span>
  </div>
</template>
