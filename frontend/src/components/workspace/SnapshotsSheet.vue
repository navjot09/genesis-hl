<script setup lang="ts">
import { toast } from 'vue-sonner'
import type { Timestamp } from 'firebase/firestore'
import { CameraIcon, HistoryIcon, Loader2Icon, RotateCcwIcon } from '@lucide/vue'
import { useSnapshots } from '@/composables/useSnapshots'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

const props = defineProps<{ projectId: string }>()
const open = defineModel<boolean>('open', { default: false })

const { snapshots, currentSnapshotId, loading, restoring, restore } = useSnapshots(props.projectId)

function formatTime(ts: Timestamp | null): string {
  if (!ts) return 'just now'
  return ts.toDate().toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

async function handleRestore(id: string): Promise<void> {
  try {
    await restore(id)
    toast.success('Project restored to this snapshot')
  } catch (err) {
    toast.error('Could not restore', {
      description: err instanceof Error ? err.message : undefined,
    })
  }
}
</script>

<template>
  <Sheet v-model:open="open">
    <SheetContent side="right" class="flex w-[400px] flex-col gap-0 p-0 sm:max-w-[400px]">
      <SheetHeader class="border-b px-5 py-4">
        <SheetTitle class="flex items-center gap-2">
          <CameraIcon class="size-4" />
          Snapshots
        </SheetTitle>
        <SheetDescription>
          Every generation is a restorable point in time.
        </SheetDescription>
      </SheetHeader>

      <div class="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div v-if="loading" class="space-y-3">
          <Skeleton v-for="n in 4" :key="n" class="h-20 w-full rounded-lg" />
        </div>

        <div
          v-else-if="snapshots.length === 0"
          class="flex flex-col items-center justify-center gap-2 py-16 text-center"
        >
          <div class="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <HistoryIcon class="size-5" />
          </div>
          <p class="text-sm font-medium">No snapshots yet</p>
          <p class="max-w-[28ch] text-xs text-muted-foreground">
            Each time you generate or edit, a snapshot is saved here.
          </p>
        </div>

        <ol v-else class="relative space-y-3 pl-4">
          <div class="absolute bottom-2 left-[3px] top-2 w-px bg-border" />
          <li v-for="s in snapshots" :key="s.id" class="relative">
            <span
              :class="
                cn(
                  'absolute -left-4 top-3 size-2 rounded-full ring-4 ring-background',
                  s.id === currentSnapshotId ? 'bg-primary' : 'bg-muted-foreground/40',
                )
              "
            />
            <div
              :class="
                cn(
                  'rounded-lg border p-3 transition-colors',
                  s.id === currentSnapshotId ? 'border-primary/40 bg-primary/5' : 'bg-card',
                )
              "
            >
              <div class="flex items-center justify-between gap-2">
                <span class="text-xs text-muted-foreground">{{ formatTime(s.createdAt) }}</span>
                <Badge v-if="s.id === currentSnapshotId" class="h-5 text-[10px]">Current</Badge>
                <Badge v-else-if="s.isRestore" variant="secondary" class="h-5 gap-1 text-[10px]">
                  <RotateCcwIcon class="size-2.5" />
                  Restore
                </Badge>
              </div>
              <p class="mt-1.5 line-clamp-2 text-sm">{{ s.prompt || 'Generation' }}</p>
              <div class="mt-2.5 flex items-center justify-between">
                <span class="text-xs text-muted-foreground">
                  {{ s.fileCount }} file{{ s.fileCount === 1 ? '' : 's' }}
                </span>
                <Button
                  v-if="s.id !== currentSnapshotId"
                  size="xs"
                  variant="outline"
                  class="gap-1"
                  :disabled="restoring !== null"
                  @click="handleRestore(s.id)"
                >
                  <Loader2Icon v-if="restoring === s.id" class="size-3 animate-spin" />
                  <RotateCcwIcon v-else class="size-3" />
                  Restore
                </Button>
              </div>
            </div>
          </li>
        </ol>
      </div>
    </SheetContent>
  </Sheet>
</template>
