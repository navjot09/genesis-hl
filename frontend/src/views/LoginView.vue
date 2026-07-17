<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { FirebaseError } from 'firebase/app'
import { toast } from 'vue-sonner'
import { Loader2Icon, SparklesIcon } from '@lucide/vue'
import { useAuthStore } from '@/stores/auth'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

type Mode = 'signin' | 'signup'

const router = useRouter()
const authStore = useAuthStore()

const mode = ref<Mode>('signin')
const email = ref('')
const password = ref('')
const submitting = ref(false)

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
  <div class="flex min-h-svh items-center justify-center bg-muted/40 p-4">
    <Card class="w-full max-w-sm">
      <CardHeader class="text-center">
        <div
          class="mx-auto mb-2 flex size-11 items-center justify-center rounded-xl bg-primary text-primary-foreground"
        >
          <SparklesIcon class="size-5" />
        </div>
        <CardTitle class="text-xl">Genesis</CardTitle>
        <CardDescription>
          The AI app-builder for HighLevel. Sign in to continue.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <Tabs v-model="mode" class="w-full">
          <TabsList class="grid w-full grid-cols-2">
            <TabsTrigger value="signin">Sign in</TabsTrigger>
            <TabsTrigger value="signup">Sign up</TabsTrigger>
          </TabsList>

          <TabsContent value="signin" class="pt-2">
            <p class="text-sm text-muted-foreground">
              Welcome back. Enter your credentials.
            </p>
          </TabsContent>
          <TabsContent value="signup" class="pt-2">
            <p class="text-sm text-muted-foreground">
              Create an account to start building.
            </p>
          </TabsContent>

          <form class="mt-4 flex flex-col gap-4" @submit.prevent="handleSubmit">
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
              <Input
                id="password"
                v-model="password"
                type="password"
                :autocomplete="mode === 'signup' ? 'new-password' : 'current-password'"
                placeholder="••••••••"
                :disabled="submitting"
              />
            </div>

            <Button type="submit" class="w-full" :disabled="submitting">
              <Loader2Icon v-if="submitting" class="size-4 animate-spin" />
              <span>{{ mode === 'signup' ? 'Create account' : 'Sign in' }}</span>
            </Button>
          </form>
        </Tabs>
      </CardContent>
    </Card>
  </div>
</template>
