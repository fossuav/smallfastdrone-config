import type { MavLinkData } from 'mavlink-mappings'
import type { StatusText } from 'mavlink-mappings/dist/lib/common'
import type { Heartbeat, MavAutopilot, MavState, MavType } from 'mavlink-mappings/dist/lib/minimal'
import type { AutopilotVersion } from 'mavlink-mappings/dist/lib/standard'
import type { MessageHandler } from '../protocol/mavlink'
import type { Transport } from '../transport/types'
import { useToast } from '@nuxt/ui/composables/useToast'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  autopilotLabel,
  buildDoSendBanner,
  buildRequestMessage,
  decodeFirmwareVersion,
  MAV_SEVERITY_ERROR_MAX,
  MAV_SEVERITY_WARNING,
  MavLinkSession,
  MSGID_AUTOPILOT_VERSION,
  MSGID_HEARTBEAT,
  MSGID_STATUSTEXT,
  systemStatusLabel,
  vehicleTypeLabel,
} from '../protocol/mavlink'
import { resolveTransport } from '../transport/select'

// MAV_COMP_ID_AUTOPILOT1 — the FC's component id, which is what
// REQUEST_MESSAGE for AUTOPILOT_VERSION must target.
const COMP_ID_AUTOPILOT = 1

export interface StatusTextEntry {
  text: string
  severity: number
  receivedAt: number
}

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

  // Set true if any STATUSTEXT mentions "SFD" — the boot banner is the
  // primary place this comes through (e.g. "ArduCopter V4.7.0-beta4-SFD
  // (d0615774)"). Drives the operator-facing autopilot label.
  const isSfd = ref(false)

  // Ring buffer of recent STATUSTEXTs (last 50). Used by the (future) log
  // pane; toasts for the WARNING-or-worse subset happen as they arrive.
  const recentStatusTexts = ref<StatusTextEntry[]>([])
  const STATUSTEXT_HISTORY = 50

  const vehicleLabel = computed(() =>
    vehicleType.value === null ? null : vehicleTypeLabel(vehicleType.value),
  )
  const autopilotLabelText = computed(() => {
    if (autopilot.value === null)
      return null
    // Operator-facing override: detect SmallFastDrone via the boot
    // banner's "-SFD" suffix.
    if (isSfd.value)
      return 'SmallFastDrone'
    return autopilotLabel(autopilot.value)
  })
  const systemStatusText = computed(() =>
    systemStatus.value === null ? null : systemStatusLabel(systemStatus.value),
  )
  const hasHeartbeat = computed(() => lastHeartbeatAt.value !== null)

  const session = new MavLinkSession()
  let versionRequested = false
  // useToast is component-context-free in @nuxt/ui — it reads a shared
  // state list that <UApp> renders. Safe to call once at store init.
  const toast = useToast()

  function recordStatusText(text: string, severity: number) {
    const entry: StatusTextEntry = { text, severity, receivedAt: Date.now() }
    recentStatusTexts.value = [...recentStatusTexts.value, entry].slice(-STATUSTEXT_HISTORY)

    // Detect SFD from any banner text — usually arrives in the version
    // line ("ArduCopter V4.7.0-beta4-SFD (d0615774)") shortly after we
    // ask for it via DO_SEND_BANNER.
    if (!isSfd.value && /\bSFD\b/.test(text)) {
      isSfd.value = true
    }

    // Surface meaningful messages as operator toasts. NOTICE/INFO/DEBUG
    // are too chatty during boot (every EKF init line) to interrupt with.
    if (severity <= MAV_SEVERITY_ERROR_MAX) {
      toast.add({ title: text, color: 'error', icon: 'i-lucide-circle-alert' })
    }
    else if (severity === MAV_SEVERITY_WARNING) {
      toast.add({ title: text, color: 'warning', icon: 'i-lucide-triangle-alert' })
    }
  }

  session.on(async (msg) => {
    if (msg.msgid === MSGID_HEARTBEAT) {
      const hb = msg.data as Heartbeat
      sysid.value = msg.sysid
      vehicleType.value = hb.type
      autopilot.value = hb.autopilot
      systemStatus.value = hb.systemStatus
      lastHeartbeatAt.value = Date.now()

      // First heartbeat after connect: ask for AUTOPILOT_VERSION (for the
      // structured firmware fields) and DO_SEND_BANNER (for the
      // human-readable string that carries the SFD suffix).
      if (!versionRequested && connected.value) {
        versionRequested = true
        try {
          const ver = buildRequestMessage(msg.sysid, COMP_ID_AUTOPILOT, MSGID_AUTOPILOT_VERSION)
          await transport.value.send(session.serialize(ver))
          const banner = buildDoSendBanner(msg.sysid, COMP_ID_AUTOPILOT)
          await transport.value.send(session.serialize(banner))
        }
        catch (e) {
          // Non-fatal — heartbeat info still displayed; firmware/banner
          // just stays blank.
          lastError.value = `couldn't request firmware info: ${e instanceof Error ? e.message : String(e)}`
        }
      }
    }
    else if (msg.msgid === MSGID_AUTOPILOT_VERSION) {
      const v = msg.data as AutopilotVersion
      firmwareVersion.value = decodeFirmwareVersion(v.flightSwVersion, v.flightCustomVersion)
    }
    else if (msg.msgid === MSGID_STATUSTEXT) {
      const st = msg.data as StatusText
      // text is a fixed-length char[N], null-padded.
      const text = st.text.replace(/\0.*$/, '').trim()
      if (text)
        recordStatusText(text, st.severity)
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
    isSfd.value = false
    recentStatusTexts.value = []
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

  // Helpers for downstream stores (params, etc.) that need to send + receive
  // MAVLink. Encapsulated here so the MavLinkSession instance stays private.
  async function sendMessage(msg: MavLinkData): Promise<void> {
    await transport.value.send(session.serialize(msg))
  }
  function subscribeMessages(cb: MessageHandler): () => void {
    return session.on(cb)
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
    isSfd,
    recentStatusTexts,
    vehicleLabel,
    autopilotLabelText,
    systemStatusText,
    hasHeartbeat,
    connect,
    disconnect,
    sendMessage,
    subscribeMessages,
  }
})
