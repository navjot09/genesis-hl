<script setup lang="ts">
import { RouterView } from 'vue-router'
import { Toaster } from '@/components/ui/sonner'
import { useAuthStore } from '@/stores/auth'

// Kick off the Firebase auth listener once, as early as the app mounts.
const authStore = useAuthStore()
authStore.init()
</script>

<template>
  <RouterView />
  <Toaster rich-colors position="top-right" />
</template>
