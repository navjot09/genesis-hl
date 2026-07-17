<script setup lang="ts">
import { computed, inject, onUnmounted, reactive, ref, watch } from 'vue'
import { collection, onSnapshot, type Unsubscribe } from 'firebase/firestore'
import {
  Loader2Icon,
  MonitorIcon,
  MonitorPlayIcon,
  RefreshCwIcon,
} from '@lucide/vue'
import { db, functionsBaseUrl } from '@/lib/firebase'
import { authedJson } from '@/lib/api'
import { buildPreviewHtml, type GenesisEnv } from '@/lib/preview'
import { GenerationKey } from '@/composables/useGeneration'
import { useHlConnection } from '@/composables/useHlConnection'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'

const props = defineProps<{ projectId: string }>()

const injected = inject(GenerationKey)
if (!injected) throw new Error('PreviewPanel must be used inside a workspace that provides generation state')
const generation = injected
const { connection } = useHlConnection()

// --- Committed files (the preview always renders the SAVED app) -------------
const files = reactive<Record<string, string>>({})
const filesLoaded = ref(false)
let unsub: Unsubscribe | null = null

watch(
  () => props.projectId,
  (id) => {
    unsub?.()
    for (const k of Object.keys(files)) delete files[k]
    filesLoaded.value = false
    unsub = onSnapshot(
      collection(db, 'projects', id, 'files'),
      (snap) => {
        const seen = new Set<string>()
        for (const d of snap.docs) {
          const data = d.data() as { path?: string; content?: string }
          if (!data.path) continue
          files[data.path] = data.content ?? ''
          seen.add(data.path)
        }
        for (const p of Object.keys(files)) if (!seen.has(p)) delete files[p]
        filesLoaded.value = true
      },
      () => {
        filesLoaded.value = true
      },
    )
  },
  { immediate: true },
)
onUnmounted(() => unsub?.())

// --- Preview build ---------------------------------------------------------
const srcdoc = ref('')
const building = ref(false)
const buildKey = ref(0)
const noEntry = ref(false)

const previewToken = ref<string | null>(null)
const tokenExpiry = ref(0)

const fileCount = computed(() => Object.keys(files).length)
const hasFiles = computed(() => fileCount.value > 0)
// Signature that changes whenever committed content changes (drives auto-rebuild).
const filesSignature = computed(() =>
  Object.entries(files)
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
    const token = await ensureToken()
    const env: GenesisEnv | null = token
      ? { proxyUrl: `${functionsBaseUrl}/hlProxy`, token }
      : null
    const html = buildPreviewHtml({ ...files }, env)
    if (html === null) {
      noEntry.value = true
      srcdoc.value = ''
      return
    }
    srcdoc.value = html
    buildKey.value++
  } finally {
    building.value = false
  }
}

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
        :key="buildKey"
        :srcdoc="srcdoc"
        sandbox="allow-scripts allow-forms allow-popups allow-modals"
        class="h-full w-full border-0 bg-white"
        title="Live preview of the generated app"
      />

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
