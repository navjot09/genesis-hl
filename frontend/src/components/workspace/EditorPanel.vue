<script setup lang="ts">
import { computed, inject, onUnmounted, reactive, ref, watch } from 'vue'
import {
  collection,
  doc,
  onSnapshot,
  serverTimestamp,
  updateDoc,
  type Unsubscribe,
} from 'firebase/firestore'
import type { editor } from 'monaco-editor'
import { VueMonacoEditor, DiffEditor as VueMonacoDiffEditor } from '@guolao/vue-monaco-editor'
import {
  CodeIcon,
  FileCodeIcon,
  FileDiffIcon,
  FileJsonIcon,
  FileTextIcon,
  Loader2Icon,
  SaveIcon,
  XIcon,
} from '@lucide/vue'
import { toast } from 'vue-sonner'
import { db } from '@/lib/firebase'
import { languageForPath } from '@/lib/monaco'
import { GenerationKey } from '@/composables/useGeneration'
import { useSnapshotDiff } from '@/composables/useSnapshotDiff'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

const props = defineProps<{ projectId: string }>()

const injected = inject(GenerationKey)
if (!injected) throw new Error('EditorPanel must be used inside a workspace that provides generation state')
const generation = injected

const isGenerating = computed(() => generation.generating.value)

// --- Committed files (idle mode) from Firestore ---------------------------
interface CommittedFile {
  docId: string
  content: string
}
const committed = reactive<Record<string, CommittedFile>>({})
const committedPaths = ref<string[]>([])
const committedLoading = ref(true)
// Local editable buffers (idle), keyed by path — compared against committed for dirty state.
const drafts = reactive<Record<string, string>>({})

let unsub: Unsubscribe | null = null

watch(
  () => props.projectId,
  (id) => {
    unsub?.()
    unsub = null
    for (const k of Object.keys(committed)) delete committed[k]
    for (const k of Object.keys(drafts)) delete drafts[k]
    committedPaths.value = []
    committedLoading.value = true

    unsub = onSnapshot(
      collection(db, 'projects', id, 'files'),
      (snap) => {
        const seen = new Set<string>()
        for (const d of snap.docs) {
          const data = d.data()
          const path = data.path as string
          if (!path) continue
          const content = (data.content as string) ?? ''
          seen.add(path)
          const prev = committed[path]
          committed[path] = { docId: d.id, content }
          // Keep the draft in sync while it is untouched (no unsaved edits).
          if (drafts[path] === undefined || (prev && drafts[path] === prev.content)) {
            drafts[path] = content
          }
        }
        for (const p of Object.keys(committed)) {
          if (!seen.has(p)) {
            delete committed[p]
            delete drafts[p]
          }
        }
        committedPaths.value = Object.keys(committed).sort()
        committedLoading.value = false
      },
      () => {
        committedLoading.value = false
      },
    )
  },
  { immediate: true },
)

onUnmounted(() => unsub?.())

// --- Tabs / active file (unified across idle + generating) -----------------
// One source of truth for tabs + active file. Generation ADDS to these and
// follows along — it never tears down what the user had open.
const openTabs = ref<string[]>([])
const activeTab = ref<string | null>(null)

// The tree merges committed files with any streaming in, so nothing vanishes.
const treePaths = computed(() => {
  if (!isGenerating.value) return committedPaths.value
  const merged = [...committedPaths.value]
  for (const p of generation.filePaths.value) if (!merged.includes(p)) merged.push(p)
  return merged
})
const tabPaths = computed(() => openTabs.value)
const activePath = computed(() => activeTab.value)

function openFile(path: string): void {
  if (!openTabs.value.includes(path)) openTabs.value = [...openTabs.value, path]
  activeTab.value = path
}

function closeTab(path: string): void {
  const idx = openTabs.value.indexOf(path)
  if (idx === -1) return
  openTabs.value = openTabs.value.filter((p) => p !== path)
  if (activeTab.value === path) {
    activeTab.value = openTabs.value[Math.max(0, idx - 1)] ?? null
  }
}

// While generating, add each streamed file as a tab and follow the active one —
// keeping every tab the user already had open.
watch(
  () => generation.activePath.value,
  (p) => {
    if (!p || !isGenerating.value) return
    if (!openTabs.value.includes(p)) openTabs.value = [...openTabs.value, p]
    activeTab.value = p
  },
)

// Auto-open a sensible first file when nothing is open yet.
watch(
  committedPaths,
  (paths) => {
    if (openTabs.value.length === 0 && paths.length > 0) {
      openFile(paths.find((p) => p.endsWith('index.html')) ?? paths[0])
    }
  },
  { immediate: true },
)

// After the committed files update (post-generation / post-delete), drop tabs
// whose file no longer exists and keep the active tab valid. Guarded so the
// (possibly stale) committed list isn't pruned mid-stream.
watch(committedPaths, (paths) => {
  if (isGenerating.value || paths.length === 0) return
  const kept = openTabs.value.filter((p) => paths.includes(p))
  if (kept.length !== openTabs.value.length) openTabs.value = kept
  if (activeTab.value && !paths.includes(activeTab.value)) {
    activeTab.value = kept[kept.length - 1] ?? null
  }
})

// When generation ends, land on the file it was last writing.
watch(
  () => generation.generating.value,
  (now, was) => {
    if (was && !now && generation.activePath.value) activeTab.value = generation.activePath.value
  },
)

// --- Editor binding --------------------------------------------------------
const editorValue = computed<string>({
  get() {
    const p = activePath.value
    if (!p) return ''
    if (isGenerating.value) {
      const gf = generation.files[p]
      // An EDIT streams raw SEARCH/REPLACE hunks, not file content — keep showing
      // the current saved file; the patched result loads on commit.
      if (gf && gf.op === 'edit') return committed[p]?.content ?? ''
      // A file being (re)written shows its live stream; an untouched committed
      // file shows its saved content (read-only).
      return gf?.content ?? committed[p]?.content ?? ''
    }
    return drafts[p] ?? committed[p]?.content ?? ''
  },
  set(val: string) {
    const p = activePath.value
    if (!p || isGenerating.value) return
    drafts[p] = val
  },
})

const activeLanguage = computed(() =>
  activePath.value ? languageForPath(activePath.value) : 'plaintext',
)

const editorOptions = computed<editor.IStandaloneEditorConstructionOptions>(() => ({
  readOnly: isGenerating.value,
  fontSize: 13,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  automaticLayout: true,
  tabSize: 2,
  wordWrap: 'on',
  smoothScrolling: true,
  padding: { top: 12, bottom: 12 },
  fixedOverflowWidgets: true,
  scrollbar: { alwaysConsumeMouseWheel: false },
}))

let editorInstance: editor.IStandaloneCodeEditor | null = null
function onEditorMount(ed: editor.IStandaloneCodeEditor): void {
  editorInstance = ed
  ed.updateOptions({ readOnly: isGenerating.value })
}
watch(isGenerating, (g) => editorInstance?.updateOptions({ readOnly: g }))

// --- Dirty state + save ----------------------------------------------------
function isDirty(path: string): boolean {
  if (isGenerating.value) return false
  const c = committed[path]
  return !!c && drafts[path] !== undefined && drafts[path] !== c.content
}
const activeDirty = computed(() => (activePath.value ? isDirty(activePath.value) : false))

const savingPath = ref<string | null>(null)

async function save(path: string | null): Promise<void> {
  if (!path) return
  const c = committed[path]
  if (!c || savingPath.value) return
  savingPath.value = path
  try {
    await updateDoc(doc(db, 'projects', props.projectId, 'files', c.docId), {
      content: drafts[path],
      updatedAt: serverTimestamp(),
    })
    committed[path].content = drafts[path]
    toast.success('File saved', { description: path })
  } catch (err) {
    toast.error('Could not save file', {
      description: err instanceof Error ? err.message : undefined,
    })
  } finally {
    savingPath.value = null
  }
}

// --- Diff view (what the latest generation changed) ------------------------
const diff = useSnapshotDiff(props.projectId)
type ViewMode = 'code' | 'diff'
const viewMode = ref<ViewMode>('code')

// Diff is only meaningful when idle; force back to code while generating.
watch(isGenerating, (g) => {
  if (g) viewMode.value = 'code'
})

function setView(mode: ViewMode): void {
  viewMode.value = mode
  // Entering diff: if the current file didn't change, jump to one that did.
  if (mode === 'diff') {
    const cur = activePath.value
    if (!cur || !diff.didChange(cur)) {
      const firstChanged = committedPaths.value.find((p) => diff.didChange(p))
      if (firstChanged) openFile(firstChanged)
    }
  }
}

const diffOriginal = computed(() => (activePath.value ? diff.baseFor(activePath.value) : ''))
const diffModified = computed(() => {
  const p = activePath.value
  if (!p) return ''
  return drafts[p] ?? committed[p]?.content ?? ''
})
const activeChanged = computed(() => (activePath.value ? diff.didChange(activePath.value) : false))
const canDiff = computed(() => diff.hasParent.value && diff.changedPaths.value.size > 0)
const diffOptions: editor.IStandaloneDiffEditorConstructionOptions = {
  readOnly: true,
  renderSideBySide: false,
  fontSize: 13,
  minimap: { enabled: false },
  automaticLayout: true,
  scrollBeyondLastLine: false,
  padding: { top: 12, bottom: 12 },
}

// --- Display helpers -------------------------------------------------------
function basename(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1)
}
function dirname(p: string): string {
  const i = p.lastIndexOf('/')
  return i === -1 ? '' : p.slice(0, i + 1)
}
function iconFor(path: string) {
  const lang = languageForPath(path)
  if (lang === 'json') return FileJsonIcon
  if (lang === 'html' || lang === 'css' || lang === 'javascript' || lang === 'typescript')
    return FileCodeIcon
  return FileTextIcon
}
function isStreaming(path: string): boolean {
  return isGenerating.value && !!generation.files[path]?.streaming
}

const hasFiles = computed(() => treePaths.value.length > 0)
</script>

<template>
  <section class="flex h-full min-h-0 flex-col">
    <div class="flex items-center justify-between border-b px-4 py-3">
      <div class="flex items-center gap-2">
        <CodeIcon class="size-4 text-muted-foreground" />
        <h2 class="text-sm font-semibold">Editor</h2>
      </div>
      <div class="flex items-center gap-2">
        <!-- Code / Diff toggle (idle, when the last generation changed something) -->
        <div
          v-if="!isGenerating && canDiff"
          class="flex items-center rounded-md border bg-muted/40 p-0.5 text-xs"
        >
          <button
            type="button"
            :class="cn('rounded px-2 py-0.5 transition-colors', viewMode === 'code' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground')"
            @click="setView('code')"
          >
            Code
          </button>
          <button
            type="button"
            :class="cn('flex items-center gap-1 rounded px-2 py-0.5 transition-colors', viewMode === 'diff' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground')"
            @click="setView('diff')"
          >
            <FileDiffIcon class="size-3" />
            Diff
          </button>
        </div>
        <Badge v-if="isGenerating" variant="secondary" class="gap-1">
          <Loader2Icon class="size-3 animate-spin" />
          Generating
        </Badge>
        <span v-else-if="hasFiles" class="text-xs text-muted-foreground">
          {{ treePaths.length }} file{{ treePaths.length === 1 ? '' : 's' }}
        </span>
      </div>
    </div>

    <div class="grid min-h-0 flex-1 grid-cols-[minmax(150px,220px)_1fr]">
      <!-- File tree -->
      <div class="min-h-0 overflow-y-auto border-r bg-muted/20">
        <div v-if="committedLoading && !isGenerating" class="space-y-2 p-3">
          <Skeleton v-for="n in 5" :key="n" class="h-5 w-full" />
        </div>
        <p
          v-else-if="!hasFiles"
          class="px-3 py-4 text-xs text-muted-foreground"
        >
          No files yet. Describe your app in the chat to generate them.
        </p>
        <ul v-else class="p-1.5">
          <li v-for="path in treePaths" :key="path">
            <button
              type="button"
              :class="
                cn(
                  'flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs transition-colors',
                  activePath === path
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                )
              "
              @click="openFile(path)"
            >
              <component :is="iconFor(path)" class="size-3.5 shrink-0" />
              <span class="min-w-0 flex-1 truncate">
                <span v-if="dirname(path)" class="text-muted-foreground/70">{{ dirname(path) }}</span>{{ basename(path) }}
              </span>
              <Loader2Icon v-if="isStreaming(path)" class="size-3 shrink-0 animate-spin text-primary" />
              <span
                v-else-if="isDirty(path)"
                class="size-1.5 shrink-0 rounded-full bg-amber-500"
                title="Unsaved changes"
              />
              <span
                v-else-if="viewMode === 'diff' && diff.didChange(path)"
                class="size-1.5 shrink-0 rounded-full bg-emerald-500"
                title="Changed in the latest generation"
              />
            </button>
          </li>
        </ul>
      </div>

      <!-- Editor pane -->
      <div class="flex min-h-0 min-w-0 flex-col">
        <!-- Tab bar -->
        <div
          v-if="tabPaths.length"
          class="flex shrink-0 items-center gap-1 overflow-x-auto border-b bg-muted/30 px-1.5 py-1"
        >
          <div
            v-for="path in tabPaths"
            :key="path"
            :class="
              cn(
                'group flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors',
                activePath === path
                  ? 'bg-background text-foreground shadow-sm ring-1 ring-border'
                  : 'text-muted-foreground hover:bg-background/60',
              )
            "
          >
            <button type="button" class="flex items-center gap-1.5" @click="openFile(path)">
              <component :is="iconFor(path)" class="size-3.5" />
              <span>{{ basename(path) }}</span>
              <span
                v-if="isDirty(path)"
                class="size-1.5 rounded-full bg-amber-500"
                title="Unsaved changes"
              />
            </button>
            <button
              v-if="!isGenerating"
              type="button"
              class="rounded p-0.5 opacity-0 hover:bg-muted group-hover:opacity-100"
              title="Close tab"
              @click.stop="closeTab(path)"
            >
              <XIcon class="size-3" />
            </button>
          </div>

          <div class="ml-auto flex shrink-0 items-center gap-2 pr-1">
            <span
              v-if="viewMode === 'diff' && activePath"
              class="text-xs"
              :class="activeChanged ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'"
            >
              {{ activeChanged ? 'Changed this generation' : 'No change this generation' }}
            </span>
            <Button
              v-if="!isGenerating && activePath && viewMode === 'code'"
              size="xs"
              variant="outline"
              class="gap-1"
              :disabled="!activeDirty || savingPath === activePath"
              @click="save(activePath)"
            >
              <Loader2Icon v-if="savingPath === activePath" class="size-3 animate-spin" />
              <SaveIcon v-else class="size-3" />
              {{ activeDirty ? 'Save' : 'Saved' }}
            </Button>
          </div>
        </div>

        <!-- Monaco (code) / Diff -->
        <div class="relative min-h-0 min-w-0 flex-1">
          <VueMonacoDiffEditor
            v-if="activePath && viewMode === 'diff'"
            :original="diffOriginal"
            :modified="diffModified"
            :language="activeLanguage"
            theme="vs-dark"
            :options="diffOptions"
            width="100%"
            height="100%"
          />
          <VueMonacoEditor
            v-else-if="activePath"
            v-model:value="editorValue"
            :path="activePath"
            :language="activeLanguage"
            theme="vs-dark"
            :options="editorOptions"
            width="100%"
            height="100%"
            @mount="onEditorMount"
          />
          <div
            v-else
            class="flex h-full flex-col items-center justify-center gap-2 p-6 text-center"
          >
            <div
              class="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground"
            >
              <CodeIcon class="size-5" />
            </div>
            <p class="text-sm font-medium">No file open</p>
            <p class="max-w-[32ch] text-xs text-muted-foreground">
              {{
                hasFiles
                  ? 'Select a file from the list to view or edit it.'
                  : 'Generated source will appear here once you build something.'
              }}
            </p>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
