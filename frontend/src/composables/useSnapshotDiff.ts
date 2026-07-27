/**
 * Loads the "before" file contents for a diff view: the files as they were in
 * the PARENT of the project's current snapshot. Diffing current-vs-parent shows
 * exactly what the most recent generation changed.
 */
import { reactive, ref, watch } from 'vue'
import { collection, doc, getDoc, getDocs } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { useProjectStore } from '@/stores/project'

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
        // Parent contents: content-addressed manifest (new snapshots) or the
        // inline files subcollection (legacy snapshots).
        const parentDoc = await getDoc(doc(db, 'projects', projectId, 'snapshots', parentId))
        if (token !== loadToken) return
        const blobs = parentDoc.data()?.blobs as { path: string; hash: string }[] | undefined
        if (Array.isArray(blobs) && blobs.length > 0) {
          const docs = await Promise.all(
            blobs.map((b) => getDoc(doc(db, 'projects', projectId, 'blobs', b.hash))),
          )
          if (token !== loadToken) return
          blobs.forEach((b, i) => {
            baseFiles[b.path] = (docs[i].data()?.content as string | undefined) ?? ''
          })
        } else {
          const files = await getDocs(
            collection(db, 'projects', projectId, 'snapshots', parentId, 'files'),
          )
          if (token !== loadToken) return
          files.forEach((d) => {
            const x = d.data() as { path?: string; content?: string }
            if (x.path) baseFiles[x.path] = x.content ?? ''
          })
        }
      }
    } finally {
      if (token === loadToken) loading.value = false
    }
  }

  // Head pointer comes from the shared project store (no extra subscription).
  const store = useProjectStore()
  watch(
    () => store.currentSnapshotId,
    (sid) => {
      currentSnapshotId.value = sid
      void loadFor(sid)
    },
    { immediate: true },
  )

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
