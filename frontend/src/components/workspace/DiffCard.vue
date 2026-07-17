<script setup lang="ts">
import { ref } from 'vue'
import { ChevronDownIcon, FileCodeIcon } from '@lucide/vue'
import { cn } from '@/lib/utils'
import type { DiffRowKind, FileChange } from '@/lib/diffTypes'

const props = defineProps<{ change: FileChange }>()

// Auto-expand small diffs; collapse big ones.
const open = ref(props.change.rows.length <= 22)

function basename(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1)
}
const opText: Record<string, string> = { edit: 'edited', delete: 'deleted', write: 'created' }

function rowClass(t: DiffRowKind): string {
  if (t === '+') return 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
  if (t === '-') return 'bg-red-500/10 text-red-700 dark:text-red-300'
  if (t === 'gap') return 'bg-muted/50 text-center text-muted-foreground italic'
  return 'text-foreground/75'
}
function prefix(t: DiffRowKind): string {
  return t === '+' ? '+' : t === '-' ? '-' : t === 'gap' ? '' : ' '
}
</script>

<template>
  <div class="overflow-hidden rounded-lg border bg-background">
    <button
      type="button"
      class="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-xs hover:bg-muted/40"
      @click="open = !open"
    >
      <ChevronDownIcon
        :class="cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open ? '' : '-rotate-90')"
      />
      <FileCodeIcon class="size-3.5 shrink-0 text-muted-foreground" />
      <span class="min-w-0 flex-1 truncate text-left font-medium">{{ basename(change.path) }}</span>
      <span class="shrink-0 text-[10px] text-muted-foreground">{{ opText[change.op] ?? change.op }}</span>
      <span v-if="change.additions" class="shrink-0 font-semibold text-emerald-600 dark:text-emerald-400">
        +{{ change.additions }}
      </span>
      <span v-if="change.deletions" class="shrink-0 font-semibold text-red-600 dark:text-red-400">
        −{{ change.deletions }}
      </span>
    </button>

    <div
      v-if="open"
      class="max-h-72 overflow-auto border-t bg-muted/20 font-mono text-[11px] leading-[1.5]"
    >
      <div v-for="(row, i) in change.rows" :key="i" :class="cn('flex', rowClass(row.t))">
        <span class="w-4 shrink-0 select-none text-center opacity-50">{{ prefix(row.t) }}</span>
        <span class="whitespace-pre">{{ row.text }}</span>
      </div>
      <div v-if="change.truncated" class="px-2 py-1 text-[10px] italic text-muted-foreground">
        … diff truncated
      </div>
    </div>
  </div>
</template>
