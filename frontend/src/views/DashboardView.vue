<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import type { Timestamp } from 'firebase/firestore'
import {
  CheckCircle2Icon,
  FolderPlusIcon,
  LogOutIcon,
  MoreVerticalIcon,
  PlugZapIcon,
  PlusIcon,
  SparklesIcon,
  Trash2Icon,
} from '@lucide/vue'
import { useAuthStore } from '@/stores/auth'
import { useHlConnection } from '@/composables/useHlConnection'
import { useProjects } from '@/composables/useProjects'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

const router = useRouter()
const authStore = useAuthStore()
const { connection, connecting, connect, complete, statusLabel } = useHlConnection()
const { projects, loading, isEmpty, createProject, softDeleteProject } = useProjects()

const email = computed(() => authStore.user?.email ?? '')
const initials = computed(() => (email.value ? email.value[0]?.toUpperCase() : '?'))

// --- New project dialog ----------------------------------------------------
const dialogOpen = ref(false)
const newName = ref('')
const newDescription = ref('')
const creating = ref(false)

function openDialog(): void {
  newName.value = ''
  newDescription.value = ''
  dialogOpen.value = true
}

async function handleCreate(): Promise<void> {
  const name = newName.value.trim()
  if (!name || creating.value) return
  creating.value = true
  try {
    const id = await createProject(name, newDescription.value.trim())
    dialogOpen.value = false
    await router.push({ name: 'workspace', params: { id } })
  } catch (err) {
    toast.error('Could not create project', {
      description: err instanceof Error ? err.message : undefined,
    })
  } finally {
    creating.value = false
  }
}

async function handleDelete(id: string, name: string): Promise<void> {
  try {
    await softDeleteProject(id)
    toast.success('Project deleted', { description: name })
  } catch (err) {
    toast.error('Could not delete project', {
      description: err instanceof Error ? err.message : undefined,
    })
  }
}

function openProject(id: string): void {
  void router.push({ name: 'workspace', params: { id } })
}

function formatUpdated(ts: Timestamp | null): string {
  if (!ts) return 'just now'
  const date = ts.toDate()
  const diffMs = Date.now() - date.getTime()
  const mins = Math.round(diffMs / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 7) return `${days}d ago`
  return date.toLocaleDateString()
}

async function handleSignOut(): Promise<void> {
  await authStore.signOutUser()
  await router.push({ name: 'login' })
}

async function handleConnect(): Promise<void> {
  try {
    await connect()
  } catch (err) {
    toast.error('Could not start the HighLevel connection', {
      description: err instanceof Error ? err.message : undefined,
    })
  }
}

// Handle the OAuth round-trip return (?hl=callback&state&code | ?hl=error&reason=…).
onMounted(async () => {
  const params = new URLSearchParams(window.location.search)
  const hl = params.get('hl')
  if (!hl) return

  // Strip the sensitive params from the URL immediately (code/state out of history).
  const state = params.get('state') ?? ''
  const code = params.get('code') ?? ''
  const reason = params.get('reason') ?? undefined
  for (const k of ['hl', 'state', 'code', 'reason']) params.delete(k)
  const rest = params.toString()
  window.history.replaceState({}, '', window.location.pathname + (rest ? `?${rest}` : ''))

  if (hl === 'error') {
    toast.error('HighLevel connection failed', { description: reason })
    return
  }
  if (hl === 'callback') {
    try {
      await complete(state, code)
      toast.success('HighLevel connected')
    } catch (err) {
      toast.error('Could not complete the HighLevel connection', {
        description: err instanceof Error ? err.message : undefined,
      })
    }
  }
})
</script>

<template>
  <div class="flex min-h-svh flex-col bg-muted/30">
    <header
      class="flex items-center justify-between gap-4 border-b bg-background px-4 py-3 md:px-6"
    >
      <div class="flex items-center gap-2">
        <div
          class="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground"
        >
          <SparklesIcon class="size-4" />
        </div>
        <span class="text-base font-semibold">Genesis</span>
      </div>

      <div class="flex items-center gap-3">
        <Button
          variant="outline"
          size="sm"
          class="gap-2"
          :disabled="connecting || connection.connected"
          @click="handleConnect"
        >
          <CheckCircle2Icon v-if="connection.connected" class="size-4 text-green-600" />
          <PlugZapIcon v-else class="size-4" />
          {{ connection.connected ? 'HighLevel' : connecting ? 'Connecting…' : 'Connect HighLevel' }}
          <Badge :variant="connection.connected ? 'default' : 'secondary'" class="ml-1">
            {{ statusLabel }}
          </Badge>
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <Button variant="ghost" size="icon" class="rounded-full">
              <Avatar class="size-8">
                <AvatarFallback>{{ initials }}</AvatarFallback>
              </Avatar>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" class="w-56">
            <DropdownMenuLabel class="flex flex-col">
              <span class="text-sm font-medium">Signed in as</span>
              <span class="truncate text-xs font-normal text-muted-foreground">
                {{ email }}
              </span>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem @select="handleSignOut">
              <LogOutIcon class="size-4" />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>

    <main class="mx-auto w-full max-w-5xl flex-1 px-4 py-8 md:px-6">
      <div class="flex items-center justify-between">
        <div>
          <h1 class="text-2xl font-semibold tracking-tight">Your projects</h1>
          <p class="text-sm text-muted-foreground">
            Build and manage your AI-generated HighLevel apps.
          </p>
        </div>
        <Button class="gap-2" @click="openDialog">
          <PlusIcon class="size-4" />
          New project
        </Button>
      </div>

      <Separator class="my-6" />

      <!-- Loading -->
      <div v-if="loading" class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Card v-for="n in 6" :key="n">
          <CardHeader class="gap-2">
            <Skeleton class="h-5 w-2/3" />
            <Skeleton class="h-4 w-full" />
          </CardHeader>
          <CardContent>
            <Skeleton class="h-4 w-24" />
          </CardContent>
        </Card>
      </div>

      <!-- Empty state -->
      <Card v-else-if="isEmpty" class="border-dashed">
        <CardHeader class="items-center text-center">
          <div
            class="mx-auto mb-2 flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground"
          >
            <FolderPlusIcon class="size-6" />
          </div>
          <CardTitle>No projects yet</CardTitle>
          <CardDescription>
            Create your first project to start building with Genesis.
          </CardDescription>
        </CardHeader>
        <CardContent class="flex justify-center">
          <Button variant="outline" class="gap-2" @click="openDialog">
            <PlusIcon class="size-4" />
            New project
          </Button>
        </CardContent>
      </Card>

      <!-- Project grid -->
      <div v-else class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Card
          v-for="project in projects"
          :key="project.id"
          class="group cursor-pointer transition-colors hover:border-primary/40 hover:bg-accent/30"
          @click="openProject(project.id)"
        >
          <CardHeader>
            <div class="flex items-start justify-between gap-2">
              <CardTitle class="truncate text-base">{{ project.name }}</CardTitle>
              <DropdownMenu>
                <DropdownMenuTrigger as-child @click.stop>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    class="-mt-1 -mr-1 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 data-[state=open]:opacity-100"
                  >
                    <MoreVerticalIcon class="size-4" />
                    <span class="sr-only">Project actions</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" class="w-40">
                  <DropdownMenuItem
                    variant="destructive"
                    @click.stop
                    @select="handleDelete(project.id, project.name)"
                  >
                    <Trash2Icon class="size-4" />
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <CardDescription class="line-clamp-2 min-h-[2.5em]">
              {{ project.description || 'No description' }}
            </CardDescription>
          </CardHeader>
          <CardContent class="flex items-center justify-between">
            <span class="text-xs text-muted-foreground">
              Updated {{ formatUpdated(project.updatedAt) }}
            </span>
            <Button
              variant="secondary"
              size="sm"
              @click.stop="openProject(project.id)"
            >
              Open
            </Button>
          </CardContent>
        </Card>
      </div>
    </main>

    <!-- New project dialog -->
    <Dialog v-model:open="dialogOpen">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            Give your app a name. You can describe what to build now or in the chat.
          </DialogDescription>
        </DialogHeader>

        <form class="grid gap-4" @submit.prevent="handleCreate">
          <div class="grid gap-2">
            <Label for="project-name">Name</Label>
            <Input
              id="project-name"
              v-model="newName"
              placeholder="My awesome app"
              autofocus
              maxlength="80"
            />
          </div>
          <div class="grid gap-2">
            <Label for="project-description">Description</Label>
            <Textarea
              id="project-description"
              v-model="newDescription"
              placeholder="A landing page for my coaching business…"
              rows="3"
              class="resize-none"
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              :disabled="creating"
              @click="dialogOpen = false"
            >
              Cancel
            </Button>
            <Button type="submit" :disabled="!newName.trim() || creating">
              {{ creating ? 'Creating…' : 'Create project' }}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </div>
</template>
