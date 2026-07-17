/**
 * Authenticated calls to the Genesis Cloud Functions.
 * Always hits the DIRECT functions base URL (never Hosting rewrites — they
 * buffer SSE), attaching the caller's Firebase ID token.
 */
import { auth, functionsBaseUrl } from '@/lib/firebase'

export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

export async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const user = auth.currentUser
  if (!user) throw new ApiError('Not signed in', 401)
  const idToken = await user.getIdToken()

  return fetch(`${functionsBaseUrl}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${idToken}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
  })
}

export async function authedJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await authedFetch(path, init)
  const body = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new ApiError(body.error ?? `Request failed (${res.status})`, res.status)
  return body
}
