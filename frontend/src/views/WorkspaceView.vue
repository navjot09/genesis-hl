<script setup lang="ts">
import { onUnmounted, provide, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { doc, onSnapshot, type Timestamp, type Unsubscribe } from 'firebase/firestore'
import {
  ArrowLeftIcon,
  CameraIcon,
  CodeIcon,
  MessageSquareIcon,
  MonitorPlayIcon,
  SparklesIcon,
} from '@lucide/vue'
import { toast } from 'vue-sonner'
import { db } from '@/lib/firebase'
import { cn } from '@/lib/utils'
import { useAuthStore } from '@/stores/auth'
import { useGeneration, GenerationKey } from '@/composables/useGeneration'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable'
import ChatPanel from '@/components/workspace/ChatPanel.vue'
import EditorPanel from '@/components/workspace/EditorPanel.vue'
import PreviewPanel from '@/components/workspace/PreviewPanel.vue'
import SnapshotsSheet from '@/components/workspace/SnapshotsSheet.vue'

const snapshotsOpen = ref(false)

// --- Collapsible panels ----------------------------------------------------
type PanelHandle = { collapse: () => void; expand: () => void }
type PanelName = 'chat' | 'editor' | 'preview'
const chatPanel = ref<PanelHandle | null>(null)
const editorPanel = ref<PanelHandle | null>(null)
const previewPanel = ref<PanelHandle | null>(null)
const collapsed = reactive<Record<PanelName, boolean>>({
  chat: false,
  editor: false,
  preview: false,
})
const panelList = [
  { name: 'chat' as PanelName, label: 'Chat', icon: MessageSquareIcon, handle: chatPanel },
  { name: 'editor' as PanelName, label: 'Code', icon: CodeIcon, handle: editorPanel },
  { name: 'preview' as PanelName, label: 'Preview', icon: MonitorPlayIcon, handle: previewPanel },
]

function togglePanel(name: PanelName): void {
  const panel = panelList.find((p) => p.name === name)?.handle.value
  if (!panel) return
  if (collapsed[name]) panel.expand()
  else panel.collapse()
}

const route = useRoute()
const router = useRouter()
const authStore = useAuthStore()

const projectId = route.params.id as string

// ONE generation instance for the whole workspace, shared with ChatPanel
// (triggers generate) and EditorPanel (renders the streamed files) via inject.
const generation = useGeneration(projectId)
provide(GenerationKey, generation)

interface ProjectDoc {
  name: string
  description: string
  ownerUid: string
  deletedAt: Timestamp | null
}

const project = ref<ProjectDoc | null>(null)
const loading = ref(true)

let unsub: Unsubscribe | null = null

// Guard: the doc must exist, be owned by the current user, and not be deleted.
unsub = onSnapshot(
  doc(db, 'projects', projectId),
  (snap) => {
    loading.value = false
    if (!snap.exists()) {
      redirectHome('This project no longer exists.')
      return
    }
    const data = snap.data() as ProjectDoc
    if (data.ownerUid !== authStore.user?.uid || data.deletedAt != null) {
      redirectHome('You do not have access to this project.')
      return
    }
    project.value = data
  },
  () => {
    loading.value = false
    redirectHome('Could not load this project.')
  },
)

function redirectHome(message: string): void {
  toast.error(message)
  void router.replace({ name: 'dashboard' })
}

onUnmounted(() => unsub?.())

// If auth is lost while here, bail out.
watch(
  () => authStore.user,
  (user) => {
    if (!user) void router.replace({ name: 'login' })
  },
)

function goBack(): void {
  void router.push({ name: 'dashboard' })
}
</script>

<template>
  <div class="flex h-svh flex-col bg-background">
    <header class="flex shrink-0 items-center justify-between gap-4 border-b px-3 py-2">
      <div class="flex min-w-0 items-center gap-2">
        <Button variant="ghost" size="sm" class="gap-1.5" @click="goBack">
          <ArrowLeftIcon class="size-4" />
          Back
        </Button>
        <Separator orientation="vertical" class="h-5" />
        <div
          class="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground"
        >
          <SparklesIcon class="size-3.5" />
        </div>
        <Skeleton v-if="loading" class="h-5 w-40" />
        <div v-else class="flex min-w-0 flex-col leading-tight">
          <span class="truncate text-sm font-medium">{{ project?.name }}</span>
          <span
            v-if="project?.description"
            class="truncate text-xs text-muted-foreground"
          >
            {{ project.description }}
          </span>
        </div>
      </div>

      <div class="flex items-center gap-2">
        <!-- Collapse / expand each panel -->
        <div class="flex items-center gap-0.5 rounded-md border bg-muted/40 p-0.5">
          <button
            v-for="p in panelList"
            :key="p.name"
            type="button"
            :class="
              cn(
                'flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors',
                collapsed[p.name]
                  ? 'text-muted-foreground hover:text-foreground'
                  : 'bg-background text-foreground shadow-sm',
              )
            "
            :title="(collapsed[p.name] ? 'Show ' : 'Hide ') + p.label"
            @click="togglePanel(p.name)"
          >
            <component :is="p.icon" class="size-3.5" />
            <span class="hidden md:inline">{{ p.label }}</span>
          </button>
        </div>
        <Button variant="outline" size="sm" class="gap-1.5" @click="snapshotsOpen = true">
          <CameraIcon class="size-4" />
          Snapshots
        </Button>
      </div>
    </header>

    <SnapshotsSheet :project-id="projectId" v-model:open="snapshotsOpen" />

    <ResizablePanelGroup direction="horizontal" class="min-h-0 flex-1">
      <ResizablePanel
        ref="chatPanel"
        :default-size="28"
        :min-size="16"
        collapsible
        :collapsed-size="0"
        @collapse="collapsed.chat = true"
        @expand="collapsed.chat = false"
      >
        <ChatPanel :project-id="projectId" />
      </ResizablePanel>
      <ResizableHandle with-handle />
      <ResizablePanel
        ref="editorPanel"
        :default-size="42"
        :min-size="22"
        collapsible
        :collapsed-size="0"
        @collapse="collapsed.editor = true"
        @expand="collapsed.editor = false"
      >
        <EditorPanel :project-id="projectId" />
      </ResizablePanel>
      <ResizableHandle with-handle />
      <ResizablePanel
        ref="previewPanel"
        :default-size="30"
        :min-size="18"
        collapsible
        :collapsed-size="0"
        @collapse="collapsed.preview = true"
        @expand="collapsed.preview = false"
      >
        <PreviewPanel :project-id="projectId" />
      </ResizablePanel>
    </ResizablePanelGroup>
  </div>
</template>
