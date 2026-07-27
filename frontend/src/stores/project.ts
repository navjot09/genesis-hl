/**
 * SINGLE source of truth for the open project's realtime state.
 *
 * Exactly ONE Firestore subscription per collection (project doc, working
 * files, chat messages) lives here; panels are pure readers. Previously
 * EditorPanel and PreviewPanel each opened their own `files` listener and
 * re-implemented normalization, and the project doc was subscribed in three
 * places — duplicate reads, duplicate code, and no answer to "where does
 * project state live?".
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import {
  collection,
  doc,
  limitToLast,
  onSnapshot,
  orderBy,
  query,
  type Timestamp,
  type Unsubscribe,
} from 'firebase/firestore'
import { db } from '@/lib/firebase'
import type { FileChange } from '@/lib/diffTypes'

export interface ProjectDoc {
  name: string
  description: string
  ownerUid: string
  deletedAt: Timestamp | null
  currentSnapshotId?: string | null
}

export interface CommittedFile {
  docId: string
  content: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  changes: FileChange[]
  createdAt: Timestamp | null
}

export const useProjectStore = defineStore('project', () => {
  const projectId = ref<string | null>(null)

  const project = ref<ProjectDoc | null>(null)
  const projectLoading = ref(true)
  /** Doc missing or unreadable (deleted project / permission error). */
  const projectMissing = ref(false)
  const currentSnapshotId = computed(() => project.value?.currentSnapshotId ?? null)

  /** Working files keyed by path. Replaced WHOLESALE per snapshot so watchers
   *  receive distinct old/new objects (drafts sync relies on that). */
  const files = ref<Record<string, CommittedFile>>({})
  const filePaths = computed(() => Object.keys(files.value).sort())
  const filesLoading = ref(true)

  const messages = ref<ChatMessage[]>([])
  const messagesLoading = ref(true)

  /** First realtime-listener failure (permissions/connectivity) — panels would
   *  otherwise just render empty data with no explanation. */
  const listenerError = ref<string | null>(null)

  let unsubs: Unsubscribe[] = []

  /** Subscribe this store to a project. Idempotent for the same id. */
  function bind(id: string): void {
    if (projectId.value === id) return
    unbind()
    projectId.value = id
    project.value = null
    projectLoading.value = true
    projectMissing.value = false
    listenerError.value = null
    files.value = {}
    filesLoading.value = true
    messages.value = []
    messagesLoading.value = true

    unsubs.push(
      onSnapshot(
        doc(db, 'projects', id),
        (snap) => {
          projectLoading.value = false
          if (!snap.exists()) {
            projectMissing.value = true
            project.value = null
            return
          }
          project.value = snap.data() as ProjectDoc
        },
        () => {
          projectLoading.value = false
          projectMissing.value = true
          listenerError.value ??= 'Could not load this project.'
        },
      ),
    )

    unsubs.push(
      onSnapshot(
        collection(db, 'projects', id, 'files'),
        (snap) => {
          const next: Record<string, CommittedFile> = {}
          for (const d of snap.docs) {
            const data = d.data() as { path?: string; content?: string }
            if (!data.path) continue
            next[data.path] = { docId: d.id, content: data.content ?? '' }
          }
          files.value = next
          filesLoading.value = false
        },
        () => {
          filesLoading.value = false
          listenerError.value ??= 'Could not load the project files.'
        },
      ),
    )

    unsubs.push(
      onSnapshot(
        query(
          collection(db, 'projects', id, 'messages'),
          orderBy('createdAt', 'asc'),
          // Bounded: chat renders the recent conversation, not unbounded history.
          limitToLast(200),
        ),
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
          messagesLoading.value = false
        },
        () => {
          messagesLoading.value = false
          listenerError.value ??= 'Could not load the chat history.'
        },
      ),
    )
  }

  function unbind(): void {
    unsubs.forEach((u) => u())
    unsubs = []
    projectId.value = null
  }

  return {
    projectId,
    project,
    projectLoading,
    projectMissing,
    currentSnapshotId,
    files,
    filePaths,
    filesLoading,
    messages,
    messagesLoading,
    listenerError,
    bind,
    unbind,
  }
})
