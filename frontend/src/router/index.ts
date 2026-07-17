import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'login',
    component: () => import('@/views/LoginView.vue'),
  },
  {
    path: '/',
    name: 'dashboard',
    component: () => import('@/views/DashboardView.vue'),
  },
  {
    path: '/projects/:id',
    name: 'workspace',
    component: () => import('@/views/WorkspaceView.vue'),
  },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

router.beforeEach(async (to) => {
  const authStore = useAuthStore()
  authStore.init()
  // Wait for the first auth-state resolution so we never decide on a stale
  // (null) user right after a page refresh.
  await authStore.ready

  const isAuthenticated = authStore.user !== null

  if (!isAuthenticated && to.name !== 'login') {
    return { name: 'login' }
  }

  if (isAuthenticated && to.name === 'login') {
    return { name: 'dashboard' }
  }

  return true
})

export default router
