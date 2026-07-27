<script setup lang="ts">
import { computed, inject, onMounted, onUnmounted, ref, watch } from 'vue'
import {
  Loader2Icon,
  MonitorIcon,
  MonitorPlayIcon,
  RefreshCwIcon,
} from '@lucide/vue'
import { functionsBaseUrl } from '@/lib/firebase'
import { useProjectStore } from '@/stores/project'
import { authedJson } from '@/lib/api'
import { buildPreviewHtml, type GenesisEnv } from '@/lib/preview'
import { GenerationKey } from '@/composables/useGeneration'
import { useHlConnection } from '@/composables/useHlConnection'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'

defineProps<{ projectId: string }>()

const injected = inject(GenerationKey)
if (!injected) throw new Error('PreviewPanel must be used inside a workspace that provides generation state')
const generation = injected
const { connection } = useHlConnection()

// --- Committed files (the preview always renders the SAVED app) -------------
// Read from the shared project store — no second Firestore subscription.
const store = useProjectStore()
const files = computed<Record<string, string>>(() => {
  const out: Record<string, string> = {}
  for (const [path, f] of Object.entries(store.files)) out[path] = f.content
  return out
})
const filesLoaded = computed(() => !store.filesLoading)

// --- Preview build ---------------------------------------------------------
const srcdoc = ref('')
const building = ref(false)
const buildKey = ref(0)
const noEntry = ref(false)

const previewToken = ref<string | null>(null)
const tokenExpiry = ref(0)

const fileCount = computed(() => Object.keys(files.value).length)
const hasFiles = computed(() => fileCount.value > 0)
// Signature that changes whenever committed content changes (drives auto-rebuild).
const filesSignature = computed(() =>
  Object.entries(files.value)
    .map(([p, c]) => `${p}:${c.length}`)
    .sort()
    .join('|'),
)

async function ensureToken(): Promise<string | null> {
  if (!connection.value.connected) return null
  if (previewToken.value && Date.now() < tokenExpiry.value - 30_000) return previewToken.value
  try {
    const { token, expiresAt } = await authedJson<{ token: string; expiresAt: number }>(
      '/mintPreviewToken',
      { method: 'POST' },
    )
    previewToken.value = token
    tokenExpiry.value = expiresAt
    return token
  } catch {
    return null
  }
}

async function rebuild(): Promise<void> {
  if (!hasFiles.value || generation.generating.value) return
  building.value = true
  noEntry.value = false
  try {
    // TOKEN BROKER: the iframe gets NO credential. `token` is a placeholder —
    // the bridge relays proxy calls here via postMessage and THIS component
    // attaches the real capability token (see onBridgeMessage below).
    const env: GenesisEnv | null = connection.value.connected
      ? { proxyUrl: `${functionsBaseUrl}/hlProxy`, token: 'brokered' }
      : null
    const html = buildPreviewHtml({ ...files.value }, env)
    if (html === null) {
      noEntry.value = true
      srcdoc.value = ''
      return
    }
    srcdoc.value = html
    buildKey.value++
    lastPing.value = Date.now()
    frozen.value = false
  } finally {
    building.value = false
  }
}

// --- Token broker + watchdog (parent side) ---------------------------------
const iframeEl = ref<HTMLIFrameElement | null>(null)
const lastPing = ref(Date.now())
const frozen = ref(false)
let frozenTimer: ReturnType<typeof setInterval> | null = null

interface BridgeFetchMsg {
  __genesis: true
  kind: 'hl-fetch'
  id: number
  path: unknown
  method: unknown
  body: unknown
}

function onBridgeMessage(ev: MessageEvent): void {
  // Only OUR iframe may talk to the broker.
  if (!iframeEl.value || ev.source !== iframeEl.value.contentWindow) return
  const d = ev.data as { __genesis?: boolean; kind?: string }
  if (d?.__genesis !== true) return
  if (d.kind === 'ping') {
    lastPing.value = Date.now()
    frozen.value = false
    return
  }
  if (d.kind === 'hl-fetch') void handleBridgeFetch(ev.data as BridgeFetchMsg)
}

async function handleBridgeFetch(msg: BridgeFetchMsg): Promise<void> {
  const reply = (payload: { ok: boolean; status: number; body: unknown }): void => {
    // Opaque-origin iframes can only be addressed with targetOrigin '*'; the
    // source check above guarantees the recipient is our own preview frame.
    iframeEl.value?.contentWindow?.postMessage(
      { __genesis: true, kind: 'hl-response', id: msg.id, ...payload },
      '*',
    )
  }
  const path = typeof msg.path === 'string' ? msg.path : ''
  const method = typeof msg.method === 'string' ? msg.method.toUpperCase() : 'GET'
  if (!path.startsWith('/') || path.includes('://') || path.length > 500) {
    reply({ ok: false, status: 400, body: { error: 'Invalid path' } })
    return
  }
  try {
    const token = await ensureToken()
    if (!token) {
      reply({ ok: false, status: 401, body: { error: 'HighLevel is not connected' } })
      return
    }
    const body = typeof msg.body === 'string' ? msg.body : undefined
    const res = await fetch(`${functionsBaseUrl}/hlProxy${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body,
    })
    reply({ ok: res.ok, status: res.status, body: await res.json().catch(() => null) })
  } catch {
    reply({ ok: false, status: 502, body: { error: 'Proxy call failed' } })
  }
}

onMounted(() => {
  window.addEventListener('message', onBridgeMessage)
  // Watchdog: pings stop => the generated app froze (infinite loop etc).
  frozenTimer = setInterval(() => {
    if (srcdoc.value && !generation.generating.value && Date.now() - lastPing.value > 10_000) {
      frozen.value = true
    }
  }, 5_000)
})
onUnmounted(() => {
  window.removeEventListener('message', onBridgeMessage)
  if (frozenTimer) clearInterval(frozenTimer)
})

function forceRefresh(): void {
  previewToken.value = null // re-mint a fresh capability token
  void rebuild()
}

// Rebuild whenever the saved files change (post-generation or after a manual
// Save), but only while idle. Generation completion flips `generating` false,
// then the files subscription delivers the new content → signature changes.
watch(filesSignature, () => rebuild())
watch(
  () => generation.generating.value,
  (now, was) => {
    if (was && !now) rebuild()
  },
)
watch(filesLoaded, (loaded) => {
  if (loaded) rebuild()
}, { immediate: true })
</script>

<template>
  <section class="flex h-full min-h-0 flex-col">
    <div class="flex items-center justify-between gap-2 border-b px-4 py-3">
      <div class="flex items-center gap-2">
        <MonitorPlayIcon class="size-4 text-muted-foreground" />
        <h2 class="text-sm font-semibold">Preview</h2>
      </div>
      <div class="flex items-center gap-2">
        <Badge
          v-if="hasFiles"
          :variant="connection.connected ? 'default' : 'secondary'"
          class="gap-1"
        >
          <span
            class="size-1.5 rounded-full"
            :class="connection.connected ? 'bg-green-400' : 'bg-muted-foreground'"
          />
          {{ connection.connected ? 'Live HighLevel data' : 'Demo data' }}
        </Badge>
        <Button
          v-if="hasFiles"
          size="xs"
          variant="outline"
          class="gap-1"
          :disabled="building || generation.generating.value"
          @click="forceRefresh"
        >
          <Loader2Icon v-if="building" class="size-3 animate-spin" />
          <RefreshCwIcon v-else class="size-3" />
          Refresh
        </Button>
      </div>
    </div>

    <div class="relative min-h-0 flex-1 bg-white dark:bg-zinc-900">
      <!-- Live app: stays mounted during regeneration so the running app never
           blanks out; it re-renders once the new files are committed. -->
      <iframe
        v-if="srcdoc"
        ref="iframeEl"
        :key="buildKey"
        :srcdoc="srcdoc"
        sandbox="allow-scripts allow-forms allow-modals"
        allow="accelerometer 'none'; camera 'none'; geolocation 'none'; gyroscope 'none'; microphone 'none'; midi 'none'; payment 'none'; usb 'none'"
        referrerpolicy="no-referrer"
        class="h-full w-full border-0 bg-white"
        title="Live preview of the generated app"
      />

      <!-- Watchdog: the generated app stopped responding (likely an infinite loop) -->
      <div
        v-if="frozen && !generation.generating.value"
        class="pointer-events-none absolute inset-x-0 top-0 flex justify-center p-3"
      >
        <div
          class="pointer-events-auto flex items-center gap-2 rounded-full border bg-background/90 px-3 py-1 text-xs shadow-sm backdrop-blur"
        >
          <span class="size-1.5 rounded-full bg-red-500" />
          App unresponsive
          <button type="button" class="font-medium underline underline-offset-2" @click="forceRefresh">
            Reload
          </button>
        </div>
      </div>

      <!-- Non-blocking "updating" pill over the previous preview -->
      <div
        v-if="generation.generating.value && srcdoc"
        class="pointer-events-none absolute inset-x-0 top-0 flex justify-center p-3"
      >
        <div
          class="flex items-center gap-2 rounded-full border bg-background/90 px-3 py-1 text-xs shadow-sm backdrop-blur"
        >
          <Loader2Icon class="size-3 animate-spin text-primary" />
          Updating when generation finishes…
        </div>
      </div>

      <!-- First-ever generation (no previous build to keep showing) -->
      <div
        v-else-if="generation.generating.value && !srcdoc"
        class="flex h-full flex-col items-center justify-center gap-3 text-center"
      >
        <Loader2Icon class="size-6 animate-spin text-primary" />
        <p class="text-sm font-medium">Generating…</p>
        <p class="max-w-[36ch] text-xs text-muted-foreground">
          The live preview appears when generation finishes.
        </p>
      </div>

      <!-- Empty / no entry -->
      <div
        v-else-if="!srcdoc"
        class="flex h-full flex-col items-center justify-center gap-3 p-6 text-center"
      >
        <div class="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <MonitorIcon class="size-6" />
        </div>
        <p class="text-sm font-medium">
          {{ noEntry ? 'No index.html to preview' : 'No preview yet' }}
        </p>
        <p class="max-w-[36ch] text-xs text-muted-foreground">
          {{
            noEntry
              ? 'This project has files but no index.html entry point.'
              : 'Describe an app in the chat. Once it generates, the running app appears here with your real HighLevel data.'
          }}
        </p>
      </div>
    </div>
  </section>
</template>
