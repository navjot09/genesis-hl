/**
 * Realtime CRUD for the signed-in user's projects.
 *
 * The list query orders by `updatedAt` (a composite index for
 * ownerUid + updatedAt exists) and filters out soft-deleted projects
 * CLIENT-SIDE, so we never need a second composite index that includes
 * `deletedAt` and never surface an index error in the console.
 */
import { computed, onUnmounted, ref, watch } from 'vue'
import {
  Timestamp,
  addDoc,
  collection,
  doc,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where,
  onSnapshot,
  type Unsubscribe,
} from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { useAuthStore } from '@/stores/auth'

export interface Project {
  id: string
  name: string
  description: string
  ownerUid: string
  locationId?: string
  currentSnapshotId: string | null
  deletedAt: Timestamp | null
  createdAt: Timestamp | null
  updatedAt: Timestamp | null
}

export function useProjects() {
  const authStore = useAuthStore()
  const projects = ref<Project[]>([])
  const loading = ref(true)
  const error = ref<string | null>(null)

  let unsub: Unsubscribe | null = null

  watch(
    () => authStore.user?.uid,
    (uid) => {
      unsub?.()
      unsub = null
      projects.value = []
      error.value = null
      if (!uid) {
        loading.value = false
        return
      }
      loading.value = true
      const q = query(
        collection(db, 'projects'),
        where('ownerUid', '==', uid),
        orderBy('updatedAt', 'desc'),
      )
      unsub = onSnapshot(
        q,
        (snap) => {
          projects.value = snap.docs
            .map((d) => ({ id: d.id, ...(d.data() as Omit<Project, 'id'>) }))
            // Hide soft-deleted projects client-side (keeps the query index simple).
            .filter((p) => p.deletedAt == null)
          loading.value = false
        },
        (err) => {
          error.value = err.message
          loading.value = false
        },
      )
    },
    { immediate: true },
  )

  onUnmounted(() => unsub?.())

  async function createProject(name: string, description: string): Promise<string> {
    const uid = authStore.user?.uid
    if (!uid) throw new Error('Not signed in')
    const ref = await addDoc(collection(db, 'projects'), {
      ownerUid: uid,
      name,
      description,
      currentSnapshotId: null,
      deletedAt: null,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    })
    return ref.id
  }

  async function softDeleteProject(id: string): Promise<void> {
    await updateDoc(doc(db, 'projects', id), { deletedAt: serverTimestamp() })
  }

  return {
    projects,
    loading,
    error,
    isEmpty: computed(() => !loading.value && projects.value.length === 0),
    createProject,
    softDeleteProject,
  }
}
