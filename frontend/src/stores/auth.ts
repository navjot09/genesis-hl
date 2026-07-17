import { defineStore } from 'pinia'
import { ref } from 'vue'
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  type User,
} from 'firebase/auth'
import { auth } from '@/lib/firebase'

export const useAuthStore = defineStore('auth', () => {
  const user = ref<User | null>(null)
  const loading = ref(true)

  let initialized = false
  let resolveReady: () => void = () => {}
  // Resolves once Firebase has reported the initial auth state, so route
  // guards can wait for it and avoid a login-redirect flicker on refresh.
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve
  })

  function init(): void {
    if (initialized) return
    initialized = true
    onAuthStateChanged(auth, (nextUser) => {
      user.value = nextUser
      loading.value = false
      resolveReady()
    })
  }

  async function signUp(email: string, password: string): Promise<void> {
    await createUserWithEmailAndPassword(auth, email, password)
  }

  async function signIn(email: string, password: string): Promise<void> {
    await signInWithEmailAndPassword(auth, email, password)
  }

  async function signOutUser(): Promise<void> {
    await signOut(auth)
  }

  return { user, loading, ready, init, signUp, signIn, signOutUser }
})
