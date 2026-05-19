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

  // Pending edits keyed by param name. An entry exists only while the
  // operator's value differs from the FC's value. The store doesn't push
  // these anywhere — Apply / commit lands in the next slice.
  const edits = ref<Map<string, number>>(new Map())

  const sortedList = computed<ParamRecord[]>(() =>
    [...params.value.values()].sort((a, b) => a.name.localeCompare(b.name)),
  )
  const count = computed(() => params.value.size)

  const dirtyCount = computed(() => edits.value.size)
  const dirtyList = computed<ParamRecord[]>(() =>
    [...edits.value.keys()]
      .map(name => params.value.get(name))
      .filter((p): p is ParamRecord => p !== undefined)
      .sort((a, b) => a.name.localeCompare(b.name)),
  )

  function isDirty(name: string): boolean {
    return edits.value.has(name)
  }
  function editedValue(name: string): number | undefined {
    return edits.value.get(name)
  }
  function effectiveValue(name: string): number | undefined {
    const e = edits.value.get(name)
    if (e !== undefined)
      return e
    return params.value.get(name)?.value
  }
  function setEdit(name: string, newValue: number) {
    const fc = params.value.get(name)
    if (!fc)
      return
    if (Object.is(newValue, fc.value)) {
      edits.value.delete(name)
    }
    else {
      edits.value.set(name, newValue)
    }
  }
  function revertParam(name: string) {
    edits.value.delete(name)
  }
  function discardAll() {
    edits.value.clear()
  }

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
    // A reload represents "I want the current state on the FC", so pending
    // edits are dropped. Surfacing conflicts with in-flight edits is a
    // later slice.
    edits.value.clear()

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
    edits.value = new Map()
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
    edits,
    dirtyCount,
    dirtyList,
    isDirty,
    editedValue,
    effectiveValue,
    setEdit,
    revertParam,
    discardAll,
    load,
    clear,
  }
})
