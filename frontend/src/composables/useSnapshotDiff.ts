/**
 * Loads the "before" file contents for a diff view: the files as they were in
 * the PARENT of the project's current snapshot. Diffing current-vs-parent shows
 * exactly what the most recent generation changed.
 */
import { onUnmounted, reactive, ref, watch } from 'vue'
import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  type Unsubscribe,
} from 'firebase/firestore'
import { db } from '@/lib/firebase'

interface ChangedEntry {
  path: string
  op: string
}

export function useSnapshotDiff(projectId: string) {
  // path -> content in the PARENT snapshot (the "before").
  const baseFiles = reactive<Record<string, string>>({})
  const changedPaths = ref<Set<string>>(new Set())
  const hasParent = ref(false)
  const currentSnapshotId = ref<string | null>(null)
  const loading = ref(false)

  let unsubProject: Unsubscribe | null = null
  let loadToken = 0

  async function loadFor(snapshotId: string | null): Promise<void> {
    const token = ++loadToken
    for (const k of Object.keys(baseFiles)) delete baseFiles[k]
    changedPaths.value = new Set()
    hasParent.value = false
    if (!snapshotId) return
    loading.value = true
    try {
      const snap = await getDoc(doc(db, 'projects', projectId, 'snapshots', snapshotId))
      if (token !== loadToken) return
      const data = snap.data() as
        | { parentSnapshotId?: string | null; changed?: ChangedEntry[] }
        | undefined
      changedPaths.value = new Set((data?.changed ?? []).map((c) => c.path))
      const parentId = data?.parentSnapshotId ?? null
      hasParent.value = !!parentId
      if (parentId) {
        const files = await getDocs(
          collection(db, 'projects', projectId, 'snapshots', parentId, 'files'),
        )
        if (token !== loadToken) return
        files.forEach((d) => {
          const x = d.data() as { path?: string; content?: string }
          if (x.path) baseFiles[x.path] = x.content ?? ''
        })
      }
    } finally {
      if (token === loadToken) loading.value = false
    }
  }

  watch(
    () => projectId,
    (id) => {
      unsubProject?.()
      unsubProject = onSnapshot(doc(db, 'projects', id), (snap) => {
        const sid = (snap.data()?.currentSnapshotId as string | undefined) ?? null
        currentSnapshotId.value = sid
        void loadFor(sid)
      })
    },
    { immediate: true },
  )
  onUnmounted(() => unsubProject?.())

  return {
    baseFiles,
    changedPaths,
    hasParent,
    loading,
    currentSnapshotId,
    /** "before" content for a path (empty string if the file is new). */
    baseFor: (path: string): string => baseFiles[path] ?? '',
    /** Whether a path changed in the latest generation. */
    didChange: (path: string): boolean => changedPaths.value.has(path),
  }
}
