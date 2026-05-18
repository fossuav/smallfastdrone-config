import type { Heartbeat, MavAutopilot, MavState, MavType } from 'mavlink-mappings/dist/lib/minimal'
import type { AutopilotVersion } from 'mavlink-mappings/dist/lib/standard'
import type { Transport } from '../transport/types'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  autopilotLabel,
  buildRequestMessage,
  decodeFirmwareVersion,
  MavLinkSession,
  MSGID_AUTOPILOT_VERSION,
  MSGID_HEARTBEAT,
  systemStatusLabel,
  vehicleTypeLabel,
} from '../protocol/mavlink'
import { resolveTransport } from '../transport/select'

// MAV_COMP_ID_AUTOPILOT1 — the FC's component id, which is what
// REQUEST_MESSAGE for AUTOPILOT_VERSION must target.
const COMP_ID_AUTOPILOT = 1

// Drone session — connection state + parsed MAVLink heartbeat + firmware info.
export const useSessionStore = defineStore('session', () => {
  const transport = ref<Transport>(resolveTransport())
  const connected = ref(false)
  const connecting = ref(false)
  const bytesReceived = ref(0)
  const lastError = ref<string | null>(null)

  // Populated as heartbeats arrive.
  const sysid = ref<number | null>(null)
  const vehicleType = ref<MavType | null>(null)
  const autopilot = ref<MavAutopilot | null>(null)
  const systemStatus = ref<MavState | null>(null)
  const lastHeartbeatAt = ref<number | null>(null)

  // Populated by AUTOPILOT_VERSION response.
  const firmwareVersion = ref<string | null>(null)

  const vehicleLabel = computed(() =>
    vehicleType.value === null ? null : vehicleTypeLabel(vehicleType.value),
  )
  const autopilotLabelText = computed(() =>
    autopilot.value === null ? null : autopilotLabel(autopilot.value),
  )
  const systemStatusText = computed(() =>
    systemStatus.value === null ? null : systemStatusLabel(systemStatus.value),
  )
  const hasHeartbeat = computed(() => lastHeartbeatAt.value !== null)

  const session = new MavLinkSession()
  let versionRequested = false

  session.on(async (msg) => {
    if (msg.msgid === MSGID_HEARTBEAT) {
      const hb = msg.data as Heartbeat
      sysid.value = msg.sysid
      vehicleType.value = hb.type
      autopilot.value = hb.autopilot
      systemStatus.value = hb.systemStatus
      lastHeartbeatAt.value = Date.now()

      // First heartbeat after connect: ask for AUTOPILOT_VERSION so we
      // can show the firmware string and git hash, not just "ArduPilot".
      if (!versionRequested && connected.value) {
        versionRequested = true
        try {
          const cmd = buildRequestMessage(msg.sysid, COMP_ID_AUTOPILOT, MSGID_AUTOPILOT_VERSION)
          await transport.value.send(session.serialize(cmd))
        }
        catch (e) {
          // Non-fatal — heartbeat info still displayed; firmware just stays blank.
          lastError.value = `couldn't request firmware version: ${e instanceof Error ? e.message : String(e)}`
        }
      }
    }
    else if (msg.msgid === MSGID_AUTOPILOT_VERSION) {
      const v = msg.data as AutopilotVersion
      firmwareVersion.value = decodeFirmwareVersion(v.flightSwVersion, v.flightCustomVersion)
    }
  })

  let unsubscribeData: (() => void) | null = null
  let unsubscribeClose: (() => void) | null = null

  function resetParsed() {
    sysid.value = null
    vehicleType.value = null
    autopilot.value = null
    systemStatus.value = null
    lastHeartbeatAt.value = null
    firmwareVersion.value = null
    bytesReceived.value = 0
    versionRequested = false
    session.reset()
  }

  async function connect() {
    if (connected.value || connecting.value)
      return
    connecting.value = true
    lastError.value = null
    resetParsed()
    try {
      await transport.value.connect()
      unsubscribeData = transport.value.on('data', (bytes) => {
        bytesReceived.value += bytes.length
        session.feed(bytes)
      })
      unsubscribeClose = transport.value.on('close', () => {
        connected.value = false
      })
      connected.value = true
    }
    catch (e) {
      lastError.value = e instanceof Error ? e.message : String(e)
      connected.value = false
    }
    finally {
      connecting.value = false
    }
  }

  async function disconnect() {
    unsubscribeData?.()
    unsubscribeClose?.()
    unsubscribeData = null
    unsubscribeClose = null
    await transport.value.disconnect()
    connected.value = false
  }

  return {
    transport,
    connected,
    connecting,
    bytesReceived,
    lastError,
    sysid,
    vehicleType,
    autopilot,
    systemStatus,
    lastHeartbeatAt,
    firmwareVersion,
    vehicleLabel,
    autopilotLabelText,
    systemStatusText,
    hasHeartbeat,
    connect,
    disconnect,
  }
})
