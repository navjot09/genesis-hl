/**
 * Live HighLevel connection status for the signed-in user, plus the action to
 * start the OAuth flow. Status comes from a realtime subscription to the
 * user's own `users/{uid}` doc (safe metadata only — tokens live server-side).
 */
import { computed, onUnmounted, ref, watch } from 'vue'
import { doc, onSnapshot, type Unsubscribe } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { authedJson } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'

export interface HlConnection {
  connected: boolean
  locationId?: string
  locationName?: string
}

export function useHlConnection() {
  const authStore = useAuthStore()
  const connection = ref<HlConnection>({ connected: false })
  const loading = ref(true)
  const connecting = ref(false)

  let unsub: Unsubscribe | null = null

  watch(
    () => authStore.user?.uid,
    (uid) => {
      unsub?.()
      unsub = null
      connection.value = { connected: false }
      if (!uid) {
        loading.value = false
        return
      }
      loading.value = true
      unsub = onSnapshot(
        doc(db, 'users', uid),
        (snap) => {
          const hl = snap.data()?.hl as HlConnection | undefined
          connection.value = hl?.connected
            ? { connected: true, locationId: hl.locationId, locationName: hl.locationName }
            : { connected: false }
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

  const STATE_KEY = 'hlOauthState'

  /** Ask the backend for the HL authorize URL, remember the state, and navigate to it. */
  async function connect(): Promise<void> {
    connecting.value = true
    try {
      const { url, state } = await authedJson<{ url: string; state: string }>('/hlOauthStart', {
        method: 'POST',
      })
      // Stash the state so we can prove THIS browser/session initiated the flow.
      sessionStorage.setItem(STATE_KEY, state)
      window.location.assign(url)
    } finally {
      connecting.value = false
    }
  }

  /**
   * Complete the flow after HighLevel redirects back with ?hl=callback&state&code.
   * Verifies the returned state matches what we stored (CSRF), then exchanges the
   * code server-side under our authenticated identity.
   */
  async function complete(state: string, code: string): Promise<void> {
    const expected = sessionStorage.getItem(STATE_KEY)
    sessionStorage.removeItem(STATE_KEY)
    if (!expected || expected !== state) {
      throw new Error('OAuth state did not match — this flow was not started in this browser.')
    }
    await authedJson('/hlOauthComplete', {
      method: 'POST',
      body: JSON.stringify({ state, code }),
    })
  }

  return {
    connection,
    loading,
    connecting,
    connect,
    complete,
    statusLabel: computed(() =>
      connection.value.connected
        ? (connection.value.locationName || 'Connected')
        : 'Not connected',
    ),
  }
}
