<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { FirebaseError } from 'firebase/app'
import { toast } from 'vue-sonner'
import {
  CalendarClockIcon,
  EyeIcon,
  EyeOffIcon,
  Loader2Icon,
  MessagesSquareIcon,
  SparklesIcon,
  UsersIcon,
  WandSparklesIcon,
} from '@lucide/vue'
import { useAuthStore } from '@/stores/auth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'

type Mode = 'signin' | 'signup'

const router = useRouter()
const authStore = useAuthStore()

const mode = ref<Mode>('signin')
const email = ref('')
const password = ref('')
const showPassword = ref(false)
const submitting = ref(false)

const heading = computed(() => (mode.value === 'signup' ? 'Create your account' : 'Welcome back'))
const subheading = computed(() =>
  mode.value === 'signup'
    ? 'Start building HighLevel apps in seconds.'
    : 'Sign in to keep building.',
)

const features = [
  { icon: WandSparklesIcon, text: 'Describe an app — watch it generate live' },
  { icon: UsersIcon, text: 'Real Contacts, Conversations & Calendars data' },
  { icon: MessagesSquareIcon, text: 'Streamed to your editor, previewed instantly' },
  { icon: CalendarClockIcon, text: 'Every generation is a restorable snapshot' },
]

function friendlyError(error: unknown): string {
  if (error instanceof FirebaseError) {
    switch (error.code) {
      case 'auth/invalid-credential':
      case 'auth/wrong-password':
      case 'auth/user-not-found':
        return 'Invalid email or password.'
      case 'auth/email-already-in-use':
        return 'That email is already registered. Try signing in.'
      case 'auth/weak-password':
        return 'Password should be at least 6 characters.'
      case 'auth/invalid-email':
        return 'Please enter a valid email address.'
      default:
        return error.message
    }
  }
  return 'Something went wrong. Please try again.'
}

async function handleSubmit(): Promise<void> {
  if (!email.value || !password.value) {
    toast.error('Please enter both an email and a password.')
    return
  }
  submitting.value = true
  try {
    if (mode.value === 'signup') {
      await authStore.signUp(email.value, password.value)
      toast.success('Account created. Welcome to Genesis!')
    } else {
      await authStore.signIn(email.value, password.value)
    }
    await router.push({ name: 'dashboard' })
  } catch (error) {
    toast.error(friendlyError(error))
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="grid min-h-svh lg:grid-cols-2">
    <!-- Brand / hero panel -->
    <div
      class="relative hidden flex-col justify-between overflow-hidden bg-zinc-950 p-10 text-white lg:flex xl:p-14"
    >
      <!-- decorative glows -->
      <div
        class="pointer-events-none absolute -left-24 -top-24 size-96 rounded-full bg-indigo-600/30 blur-3xl"
      />
      <div
        class="pointer-events-none absolute -bottom-32 -right-16 size-[28rem] rounded-full bg-fuchsia-600/20 blur-3xl"
      />
      <div
        class="pointer-events-none absolute inset-0 opacity-[0.15] [background-image:linear-gradient(to_right,white_1px,transparent_1px),linear-gradient(to_bottom,white_1px,transparent_1px)] [background-size:44px_44px] [mask-image:radial-gradient(ellipse_at_center,black,transparent_75%)]"
      />

      <!-- brand -->
      <div class="relative flex items-center gap-2.5">
        <div
          class="flex size-9 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-fuchsia-500 shadow-lg shadow-indigo-500/30"
        >
          <SparklesIcon class="size-5" />
        </div>
        <span class="text-lg font-semibold tracking-tight">Genesis</span>
      </div>

      <!-- pitch -->
      <div class="relative max-w-md">
        <h1 class="text-3xl font-semibold leading-tight tracking-tight xl:text-4xl">
          Build HighLevel apps by
          <span
            class="bg-gradient-to-r from-indigo-300 to-fuchsia-300 bg-clip-text text-transparent"
          >
            describing them.
          </span>
        </h1>
        <p class="mt-4 text-sm leading-relaxed text-zinc-400">
          Genesis turns a prompt into a working app that talks to your real HighLevel data —
          generated live, right in your browser.
        </p>

        <ul class="mt-8 space-y-3.5">
          <li
            v-for="f in features"
            :key="f.text"
            class="flex items-center gap-3 text-sm text-zinc-300"
          >
            <span
              class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-white/5 ring-1 ring-white/10"
            >
              <component :is="f.icon" class="size-4 text-indigo-300" />
            </span>
            {{ f.text }}
          </li>
        </ul>
      </div>

      <p class="relative text-xs text-zinc-500">Vue 3 · Firebase · Gemini · Monaco</p>
    </div>

    <!-- Auth form panel -->
    <div class="flex items-center justify-center bg-background p-6 sm:p-10">
      <div class="w-full max-w-sm">
        <!-- compact brand for small screens -->
        <div class="mb-8 flex items-center gap-2 lg:hidden">
          <div
            class="flex size-9 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-fuchsia-500 text-white"
          >
            <SparklesIcon class="size-5" />
          </div>
          <span class="text-lg font-semibold tracking-tight">Genesis</span>
        </div>

        <div class="mb-6">
          <h2 class="text-2xl font-semibold tracking-tight">{{ heading }}</h2>
          <p class="mt-1 text-sm text-muted-foreground">{{ subheading }}</p>
        </div>

        <Tabs v-model="mode" class="mb-5">
          <TabsList class="grid w-full grid-cols-2">
            <TabsTrigger value="signin">Sign in</TabsTrigger>
            <TabsTrigger value="signup">Sign up</TabsTrigger>
          </TabsList>
        </Tabs>

        <form class="flex flex-col gap-4" @submit.prevent="handleSubmit">
          <div class="flex flex-col gap-2">
            <Label for="email">Email</Label>
            <Input
              id="email"
              v-model="email"
              type="email"
              autocomplete="email"
              placeholder="you@example.com"
              :disabled="submitting"
            />
          </div>

          <div class="flex flex-col gap-2">
            <Label for="password">Password</Label>
            <div class="relative">
              <Input
                id="password"
                v-model="password"
                :type="showPassword ? 'text' : 'password'"
                :autocomplete="mode === 'signup' ? 'new-password' : 'current-password'"
                placeholder="••••••••"
                class="pr-10"
                :disabled="submitting"
              />
              <button
                type="button"
                tabindex="-1"
                class="absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground hover:text-foreground"
                :aria-label="showPassword ? 'Hide password' : 'Show password'"
                @click="showPassword = !showPassword"
              >
                <EyeOffIcon v-if="showPassword" class="size-4" />
                <EyeIcon v-else class="size-4" />
              </button>
            </div>
          </div>

          <Button type="submit" class="mt-1 w-full gap-2" :disabled="submitting">
            <Loader2Icon v-if="submitting" class="size-4 animate-spin" />
            {{ mode === 'signup' ? 'Create account' : 'Sign in' }}
          </Button>
        </form>

        <p class="mt-6 text-center text-xs text-muted-foreground">
          {{ mode === 'signup' ? 'Already have an account?' : "Don't have an account?" }}
          <button
            type="button"
            class="font-medium text-foreground underline-offset-4 hover:underline"
            @click="mode = mode === 'signup' ? 'signin' : 'signup'"
          >
            {{ mode === 'signup' ? 'Sign in' : 'Sign up' }}
          </button>
        </p>
      </div>
    </div>
  </div>
</template>
