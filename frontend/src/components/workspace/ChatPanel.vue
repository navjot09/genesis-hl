<script setup lang="ts">
import { computed, inject, nextTick, onUnmounted, ref, watch } from 'vue'
import {
  collection,
  onSnapshot,
  orderBy,
  query,
  type Timestamp,
  type Unsubscribe,
} from 'firebase/firestore'
import { BotIcon, MessageSquareIcon, SendIcon, SquareIcon, UserIcon } from '@lucide/vue'
import { db } from '@/lib/firebase'
import { GenerationKey } from '@/composables/useGeneration'
import { renderMarkdown } from '@/lib/markdown'
import type { FileChange } from '@/lib/diffTypes'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import DiffCard from '@/components/workspace/DiffCard.vue'

const props = defineProps<{ projectId: string }>()

const injected = inject(GenerationKey)
if (!injected) throw new Error('ChatPanel must be used inside a workspace that provides generation state')
const generation = injected

interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  changes: FileChange[]
  createdAt: Timestamp | null
}

const messages = ref<ChatMessage[]>([])
const loading = ref(true)
// Optimistic echo of the just-sent prompt, cleared once the backend-written
// copy arrives via the subscription (deduped by content) or on completion.
const pendingUser = ref<string | null>(null)

let unsub: Unsubscribe | null = null

watch(
  () => props.projectId,
  (id) => {
    unsub?.()
    unsub = null
    messages.value = []
    loading.value = true
    const q = query(
      collection(db, 'projects', id, 'messages'),
      orderBy('createdAt', 'asc'),
    )
    unsub = onSnapshot(
      q,
      (snap) => {
        messages.value = snap.docs.map((d) => {
          const data = d.data()
          return {
            id: d.id,
            role: data.role === 'assistant' ? 'assistant' : 'user',
            content: (data.content as string) ?? '',
            changes: Array.isArray(data.changes) ? (data.changes as FileChange[]) : [],
            createdAt: (data.createdAt as Timestamp | null) ?? null,
          }
        })
        loading.value = false
      },
      () => {
        loading.value = false
      },
    )
  },
  { immediate: true },
)

onUnmounted(() => unsub?.())

// Show the optimistic bubble only until the real user message lands.
const showOptimistic = computed(
  () =>
    pendingUser.value !== null &&
    !messages.value.some((m) => m.role === 'user' && m.content === pendingUser.value),
)

// Clear the optimistic echo once a generation finishes.
watch(
  () => generation.generating.value,
  (isGenerating, was) => {
    if (was && !isGenerating) pendingUser.value = null
  },
)

// --- Input -----------------------------------------------------------------
const draft = ref('')

async function send(): Promise<void> {
  const text = draft.value.trim()
  if (!text || generation.generating.value) return
  draft.value = ''
  pendingUser.value = text
  await generation.generate(text)
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    void send()
  }
}

function stop(): void {
  generation.cancel()
}

// --- Auto-scroll -----------------------------------------------------------
const scrollBody = ref<HTMLElement | null>(null)

function scrollToBottom(): void {
  const el = scrollBody.value
  if (el) el.scrollTop = el.scrollHeight
}

watch(
  [() => messages.value.length, () => generation.streamingAssistant.value, showOptimistic],
  () => {
    void nextTick(scrollToBottom)
  },
)

const hasContent = computed(
  () => messages.value.length > 0 || showOptimistic.value || generation.generating.value,
)
</script>

<template>
  <section class="flex h-full min-h-0 flex-col">
    <div class="flex items-center gap-2 border-b px-4 py-3">
      <MessageSquareIcon class="size-4 text-muted-foreground" />
      <h2 class="text-sm font-semibold">Chat</h2>
    </div>

    <div ref="scrollBody" class="min-h-0 flex-1 overflow-y-auto">
      <!-- Empty / intro state -->
      <div
        v-if="!hasContent && !loading"
        class="flex h-full flex-col items-center justify-center gap-2 px-6 py-16 text-center"
      >
        <div
          class="mb-1 flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground"
        >
          <BotIcon class="size-5" />
        </div>
        <p class="text-sm font-medium">Describe what to build</p>
        <p class="max-w-[26ch] text-xs text-muted-foreground">
          Tell Genesis what you want and it will generate the app on the right.
        </p>
      </div>

      <div v-else class="flex flex-col gap-4 p-4">
        <template v-for="msg in messages" :key="msg.id">
          <div
            class="flex gap-2.5"
            :class="msg.role === 'user' ? 'flex-row-reverse' : 'flex-row'"
          >
            <div
              class="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full"
              :class="
                msg.role === 'user'
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground'
              "
            >
              <UserIcon v-if="msg.role === 'user'" class="size-3.5" />
              <BotIcon v-else class="size-3.5" />
            </div>
            <div
              class="flex min-w-0 max-w-[85%] flex-col gap-2"
              :class="msg.role === 'user' ? 'items-end' : 'items-start'"
            >
              <div
                v-if="msg.content"
                class="rounded-2xl px-3 py-2 text-sm break-words"
                :class="
                  msg.role === 'user'
                    ? 'rounded-tr-sm bg-primary whitespace-pre-wrap text-primary-foreground'
                    : 'rounded-tl-sm bg-muted text-foreground'
                "
              >
                <!-- eslint-disable-next-line vue/no-v-html -->
                <div v-if="msg.role === 'assistant'" class="chat-md" v-html="renderMarkdown(msg.content)" />
                <template v-else>{{ msg.content }}</template>
              </div>
              <!-- Per-file diff cards (added/removed lines) for this generation -->
              <div
                v-if="msg.role === 'assistant' && msg.changes.length"
                class="w-full space-y-1.5"
              >
                <DiffCard v-for="c in msg.changes" :key="c.path" :change="c" />
              </div>
            </div>
          </div>
        </template>

        <!-- Optimistic user bubble (until the backend copy arrives) -->
        <div v-if="showOptimistic" class="flex flex-row-reverse gap-2.5">
          <div
            class="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground"
          >
            <UserIcon class="size-3.5" />
          </div>
          <div
            class="max-w-[85%] rounded-2xl rounded-tr-sm bg-primary px-3 py-2 text-sm whitespace-pre-wrap break-words text-primary-foreground opacity-80"
          >
            {{ pendingUser }}
          </div>
        </div>

        <!-- Live streaming assistant bubble -->
        <div v-if="generation.generating.value" class="flex flex-row gap-2.5">
          <div
            class="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
          >
            <BotIcon class="size-3.5" />
          </div>
          <div
            class="max-w-[85%] rounded-2xl rounded-tl-sm bg-muted px-3 py-2 text-sm whitespace-pre-wrap break-words text-foreground"
          >
            <template v-if="generation.streamingAssistant.value">{{
              generation.streamingAssistant.value
            }}</template>
            <span class="inline-flex items-center gap-1 align-middle">
              <span class="size-1.5 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:-0.3s]" />
              <span class="size-1.5 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:-0.15s]" />
              <span class="size-1.5 animate-bounce rounded-full bg-muted-foreground/60" />
            </span>
          </div>
        </div>
      </div>
    </div>

    <div class="border-t p-3">
      <div class="flex items-end gap-2">
        <Textarea
          v-model="draft"
          placeholder="Message Genesis…"
          rows="1"
          :disabled="generation.generating.value"
          class="max-h-40 min-h-9 resize-none"
          @keydown="onKeydown"
        />
        <Button
          v-if="generation.generating.value"
          size="icon"
          variant="destructive"
          title="Stop generating"
          @click="stop"
        >
          <SquareIcon class="size-4" />
        </Button>
        <Button
          v-else
          size="icon"
          :disabled="!draft.trim()"
          title="Send"
          @click="send"
        >
          <SendIcon class="size-4" />
        </Button>
      </div>
      <p class="mt-1.5 px-1 text-[11px] text-muted-foreground">
        Enter to send · Shift+Enter for a new line
      </p>
    </div>
  </section>
</template>

<style scoped>
.chat-md :deep(p) {
  margin: 0 0 0.5em;
}
.chat-md :deep(> :last-child) {
  margin-bottom: 0;
}
.chat-md :deep(strong) {
  font-weight: 600;
}
.chat-md :deep(em) {
  font-style: italic;
}
.chat-md :deep(ul),
.chat-md :deep(ol) {
  margin: 0.35em 0;
  padding-left: 1.25em;
}
.chat-md :deep(ul) {
  list-style: disc;
}
.chat-md :deep(ol) {
  list-style: decimal;
}
.chat-md :deep(li) {
  margin: 0.15em 0;
}
.chat-md :deep(h1),
.chat-md :deep(h2),
.chat-md :deep(h3),
.chat-md :deep(h4) {
  font-weight: 600;
  font-size: 0.95em;
  margin: 0.6em 0 0.25em;
}
.chat-md :deep(code) {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.85em;
  background: color-mix(in oklab, currentColor 12%, transparent);
  padding: 0.1em 0.3em;
  border-radius: 0.25em;
}
.chat-md :deep(pre) {
  background: color-mix(in oklab, currentColor 10%, transparent);
  padding: 0.5em 0.65em;
  border-radius: 0.4em;
  overflow-x: auto;
  margin: 0.4em 0;
}
.chat-md :deep(pre code) {
  background: none;
  padding: 0;
}
.chat-md :deep(a) {
  text-decoration: underline;
}
</style>
