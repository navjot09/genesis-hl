/**
 * Realtime snapshot history for a project + the restore action. Every generation
 * (and every restore) is a snapshot; restoring calls the backend, which reverts
 * the working files and appends a new snapshot.
 */
import { onUnmounted, ref } from 'vue'
import {
  collection,
  doc,
  onSnapshot,
  orderBy,
  query,
  type Timestamp,
  type Unsubscribe,
} from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { authedJson } from '@/lib/api'

export interface SnapshotItem {
  id: string
  prompt: string
  createdAt: Timestamp | null
  fileCount: number
  isRestore: boolean
}

export function useSnapshots(projectId: string) {
  const snapshots = ref<SnapshotItem[]>([])
  const currentSnapshotId = ref<string | null>(null)
  const loading = ref(true)
  const restoring = ref<string | null>(null)

  const unsubSnaps: Unsubscribe = onSnapshot(
    query(collection(db, 'projects', projectId, 'snapshots'), orderBy('createdAt', 'desc')),
    (snap) => {
      snapshots.value = snap.docs.map((d) => {
        const x = d.data() as {
          prompt?: string
          createdAt?: Timestamp
          manifest?: unknown[]
          restoredFrom?: string
        }
        return {
          id: d.id,
          prompt: x.prompt ?? '',
          createdAt: x.createdAt ?? null,
          fileCount: Array.isArray(x.manifest) ? x.manifest.length : 0,
          isRestore: !!x.restoredFrom,
        }
      })
      loading.value = false
    },
    () => {
      loading.value = false
    },
  )

  const unsubProj: Unsubscribe = onSnapshot(doc(db, 'projects', projectId), (snap) => {
    currentSnapshotId.value = (snap.data()?.currentSnapshotId as string | undefined) ?? null
  })

  onUnmounted(() => {
    unsubSnaps()
    unsubProj()
  })

  async function restore(snapshotId: string): Promise<void> {
    restoring.value = snapshotId
    try {
      await authedJson('/restoreSnapshot', {
        method: 'POST',
        body: JSON.stringify({ projectId, snapshotId }),
      })
    } finally {
      restoring.value = null
    }
  }

  return { snapshots, currentSnapshotId, loading, restoring, restore }
}
