import type { ParamValue } from 'mavlink-mappings/dist/lib/common'
import type { ParamRecord } from '../protocol/params'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { buildParamRequestList, MSGID_PARAM_VALUE } from '../protocol/params'
import { useSessionStore } from './session'

// Parameter browser store — fetch + cache; read-only today, editing +
// commit land in follow-up slices.

const COMP_ID_AUTOPILOT = 1
const SILENCE_TIMEOUT_MS = 10_000

export const useParamsStore = defineStore('params', () => {
  const session = useSessionStore()

  const params = ref<Map<string, ParamRecord>>(new Map())
  const loading = ref(false)
  const progress = ref<{ received: number, total: number } | null>(null)
  const error = ref<string | null>(null)
  const loadedAt = ref<number | null>(null)

  const sortedList = computed<ParamRecord[]>(() =>
    [...params.value.values()].sort((a, b) => a.name.localeCompare(b.name)),
  )
  const count = computed(() => params.value.size)

  async function load() {
    if (loading.value)
      return
    if (!session.connected) {
      error.value = 'Connect to a drone first'
      return
    }
    if (session.sysid === null) {
      error.value = 'Waiting for heartbeat before fetching params'
      return
    }

    loading.value = true
    error.value = null
    progress.value = null

    try {
      params.value = await streamParams(session.sysid)
      loadedAt.value = Date.now()
    }
    catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    }
    finally {
      loading.value = false
    }
  }

  // Stream PARAM_VALUE messages into a Map until the FC's reported
  // param_count is satisfied (or silence for SILENCE_TIMEOUT_MS).
  async function streamParams(targetSystem: number): Promise<Map<string, ParamRecord>> {
    const out = new Map<string, ParamRecord>()
    const seen = new Set<number>()

    return new Promise<Map<string, ParamRecord>>((resolve, reject) => {
      let silenceTimer: ReturnType<typeof setTimeout> | null = null
      let unsubscribe: (() => void) | null = null
      const finish = (err?: Error) => {
        if (silenceTimer)
          clearTimeout(silenceTimer)
        unsubscribe?.()
        if (err)
          reject(err)
        else resolve(out)
      }
      const armSilence = () => {
        if (silenceTimer)
          clearTimeout(silenceTimer)
        silenceTimer = setTimeout(() => {
          finish(new Error(`Param fetch stalled — got ${seen.size} params, then ${SILENCE_TIMEOUT_MS / 1000}s of silence`))
        }, SILENCE_TIMEOUT_MS)
      }

      unsubscribe = session.subscribeMessages((msg) => {
        if (msg.msgid !== MSGID_PARAM_VALUE)
          return
        const pv = msg.data as ParamValue
        const name = pv.paramId.replace(/\0.*$/, '')
        if (!seen.has(pv.paramIndex)) {
          seen.add(pv.paramIndex)
          out.set(name, {
            name,
            value: pv.paramValue,
            type: pv.paramType,
            index: pv.paramIndex,
          })
          progress.value = { received: seen.size, total: pv.paramCount }
        }
        armSilence()
        if (pv.paramCount > 0 && seen.size >= pv.paramCount)
          finish()
      })

      armSilence()
      session
        .sendMessage(buildParamRequestList(targetSystem, COMP_ID_AUTOPILOT))
        .catch(finish)
    })
  }

  function clear() {
    params.value = new Map()
    progress.value = null
    error.value = null
    loadedAt.value = null
  }

  return {
    params,
    sortedList,
    count,
    loading,
    progress,
    error,
    loadedAt,
    load,
    clear,
  }
})
