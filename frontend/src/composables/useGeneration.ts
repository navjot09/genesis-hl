/**
 * Drives a single project's AI generation over the backend SSE endpoint.
 *
 * ONE instance is created per workspace (in WorkspaceView) and shared with the
 * ChatPanel (which triggers `generate`) and the EditorPanel (which renders the
 * streamed files) via provide/inject — see `GenerationKey`. This shared state
 * is what keeps the chat and the live editor in sync during a generation.
 *
 * The SSE stream is consumed with fetch + ReadableStream (NOT EventSource,
 * which cannot attach the Firebase auth header). Events are `\n\n`-delimited
 * blocks with an `event:` line and a JSON `data:` line.
 */
import { computed, onUnmounted, reactive, ref, type InjectionKey } from 'vue'
import { doc, getDoc, onSnapshot } from 'firebase/firestore'
import { toast } from 'vue-sonner'
import { db } from '@/lib/firebase'
import { authedFetch } from '@/lib/api'
import type { SsePayload } from '@contracts'

export interface GenFile {
  content: string
  op: string
  streaming: boolean
}

// --- SSE payloads: DERIVED from the shared wire contract (@contracts). ----
type AssistantDeltaData = SsePayload<'assistant_delta'>
type FileOpenData = SsePayload<'file_open'>
type FileDeltaData = SsePayload<'file_delta'>
type FileCloseData = SsePayload<'file_close'>
type SnapshotData = SsePayload<'snapshot'>
type DoneData = SsePayload<'done'>
type ErrorData = SsePayload<'error'>

interface ParsedEvent {
  event: string
  data: unknown
}

/** Parse a single `event:` / `data:` SSE block into a name + JSON payload. */
function parseEventBlock(block: string): ParsedEvent | null {
  let event = ''
  const dataLines: string[] = []
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
  }
  if (!event) return null
  const raw = dataLines.join('\n')
  let data: unknown = undefined
  if (raw) {
    try {
      data = JSON.parse(raw)
    } catch {
      data = raw
    }
  }
  return { event, data }
}

/**
 * Run lifecycle as a discriminated union — ONE source of truth. Contradictory
 * flag combinations (generating && error, finalizing after done) are
 * unrepresentable, and every consumer must handle every phase.
 */
export type GenStatus =
  | { phase: 'idle' }
  | { phase: 'streaming' }
  | { phase: 'finalizing' } // stream lost; waiting for the server's commit
  | { phase: 'done'; snapshotId: string | null }
  | { phase: 'error'; message: string }

export function useGeneration(projectId: string) {
  const status = ref<GenStatus>({ phase: 'idle' })
  // Compatibility façades — derived, so they can never disagree with status.
  const generating = computed(
    () => status.value.phase === 'streaming' || status.value.phase === 'finalizing',
  )
  const finalizing = computed(() => status.value.phase === 'finalizing')
  const lastError = computed(() =>
    status.value.phase === 'error' ? status.value.message : null,
  )
  const isTerminal = () => status.value.phase === 'done' || status.value.phase === 'error'

  const activePath = ref<string | null>(null)
  const streamingAssistant = ref('')
  const lastSnapshotId = ref<string | null>(null)

  // Live streamed files for the IN-PROGRESS generation, keyed by path.
  const files = reactive<Record<string, GenFile>>({})
  // Insertion order of paths, drives tabs / the file tree during streaming.
  const filePaths = ref<string[]>([])

  let controller: AbortController | null = null

  const fileCount = computed(() => filePaths.value.length)
  const activeFile = computed<GenFile | null>(() =>
    activePath.value ? (files[activePath.value] ?? null) : null,
  )

  function resetLiveState(): void {
    for (const key of Object.keys(files)) delete files[key]
    filePaths.value = []
    activePath.value = null
    streamingAssistant.value = ''
  }

  function ensureFile(path: string, op: string): void {
    if (!files[path]) {
      files[path] = { content: '', op, streaming: true }
      filePaths.value = [...filePaths.value, path]
    } else {
      files[path].op = op
      files[path].streaming = true
    }
  }

  function dispatch({ event, data }: ParsedEvent): void {
    switch (event) {
      case 'assistant_delta': {
        streamingAssistant.value += (data as AssistantDeltaData).text ?? ''
        break
      }
      case 'file_open': {
        const d = data as FileOpenData
        ensureFile(d.path, d.op)
        activePath.value = d.path
        break
      }
      case 'file_delta': {
        const d = data as FileDeltaData
        if (!files[d.path]) ensureFile(d.path, 'edit')
        files[d.path].content += d.text ?? ''
        break
      }
      case 'file_close': {
        const d = data as FileCloseData
        if (files[d.path]) files[d.path].streaming = false
        break
      }
      case 'snapshot': {
        const d = data as SnapshotData
        lastSnapshotId.value = d.snapshotId
        // The commit is the real result — reaching it means the run succeeded
        // even if the stream dies before the trailing done event arrives.
        status.value = { phase: 'done', snapshotId: d.snapshotId }
        for (const p of Object.keys(files)) files[p].streaming = false
        break
      }
      case 'done': {
        const d = data as DoneData
        if (status.value.phase !== 'done') status.value = { phase: 'done', snapshotId: lastSnapshotId.value }
        for (const p of Object.keys(files)) files[p].streaming = false
        if (d.truncated) {
          toast.info('Generation stopped early', {
            description: 'The response was truncated — you can ask Genesis to continue.',
          })
        }
        if (d.warnings?.length) {
          toast.warning('Generation finished with warnings', {
            description: d.warnings.join('\n'),
          })
        }
        break
      }
      case 'error': {
        const d = data as ErrorData
        status.value = { phase: 'error', message: d.message }
        toast.error('Generation failed', {
          description: d.message + (d.partial ? ' (partial result kept)' : ''),
        })
        // On a non-partial failure there is nothing usable to keep.
        for (const p of Object.keys(files)) files[p].streaming = false
        break
      }
      default:
        break
    }
  }

  async function generate(prompt: string): Promise<void> {
    const text = prompt.trim()
    if (!text || generating.value) return

    resetLiveState()
    status.value = { phase: 'streaming' }
    controller = new AbortController()
    // The job id is CLIENT-chosen so recovery can watch generations/{id} even
    // if the stream dies before any server byte arrives.
    const generationId = crypto.randomUUID()

    // Snapshot pointer BEFORE we start: if the SSE drops, the server still
    // commits and advances this id, which is how we detect the real result.
    const baseSnapshotId = await currentSnapshotId()
    let streamStarted = false

    try {
      const res = await authedFetch('/generate', {
        method: 'POST',
        // messageId = idempotency key: a retried request must not duplicate
        // the user message in the chat log.
        body: JSON.stringify({
          projectId,
          prompt: text,
          messageId: crypto.randomUUID(),
          generationId,
        }),
        signal: controller.signal,
      })

      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error ?? `Generation request failed (${res.status})`)
      }

      streamStarted = true
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        let sep = buffer.indexOf('\n\n')
        while (sep !== -1) {
          const block = buffer.slice(0, sep)
          buffer = buffer.slice(sep + 2)
          const parsed = parseEventBlock(block)
          if (parsed) dispatch(parsed)
          sep = buffer.indexOf('\n\n')
        }
      }

      // Flush any trailing event that arrived without a final blank line.
      buffer += decoder.decode()
      const trailing = parseEventBlock(buffer)
      if (trailing) dispatch(trailing)

      // Clean EOF without a terminal event: a proxy gracefully closed the
      // stream mid-generation (resolves done=true, nothing thrown). Same
      // situation as a dropped connection — recover from the commit.
      if (streamStarted && !isTerminal()) {
        await recoverAfterDrop(baseSnapshotId, generationId)
      }
    } catch (err) {
      if (controller?.signal.aborted) {
        // User pressed Stop. The server intentionally finishes and commits
        // (results are never lost); we just stop watching the stream.
        toast.info('Stopped watching', {
          description: 'Generation finishes on the server — results will appear shortly.',
        })
      } else if (streamStarted && !isTerminal()) {
        // The stream dropped mid-generation (common on networks that cut
        // long-lived connections). The server keeps running and commits the
        // result, so wait for it rather than declaring failure.
        await recoverAfterDrop(baseSnapshotId, generationId)
      } else {
        // Failed before streaming began (auth / bad request / server error).
        const message = err instanceof Error ? err.message : 'Connection lost'
        status.value = { phase: 'error', message }
        toast.error('Could not start generation', { description: message })
      }
    } finally {
      // A run that ended without a terminal outcome (e.g. user Stop) is idle.
      if (!isTerminal()) status.value = { phase: 'idle' }
      controller = null
    }
  }

  /** Read the project's current snapshot pointer (null if none / unreadable). */
  async function currentSnapshotId(): Promise<string | null> {
    try {
      const snap = await getDoc(doc(db, 'projects', projectId))
      return (snap.data()?.currentSnapshotId as string | undefined) ?? null
    } catch {
      return null
    }
  }

  /**
   * The SSE dropped mid-generation, but the backend keeps running and commits.
   * Recovery watches the run's JOB RECORD (generations/{id}) — status +
   * heartbeat — with the project's snapshot pointer as a fallback success
   * signal (job writes are best-effort). No fixed timer: a healthy long run is
   * waited out indefinitely; a dead one is detected by heartbeat silence.
   */
  async function recoverAfterDrop(
    baseSnapshotId: string | null,
    generationId: string,
  ): Promise<void> {
    status.value = { phase: 'finalizing' }
    const toastId = toast.loading('Connection dropped — finalizing on the server…', {
      description: 'Your app is still being generated and saved. This can take a few minutes.',
    })
    const outcome = await waitForJobOutcome(generationId, baseSnapshotId)
    if (outcome.kind === 'committed') {
      status.value = { phase: 'done', snapshotId: null }
      toast.success('Generation complete', {
        id: toastId,
        description: 'The connection dropped mid-stream, but your app finished and was saved.',
      })
    } else {
      const message =
        outcome.kind === 'failed'
          ? (outcome.message ?? 'The generation failed.')
          : 'The result didn’t arrive in time. Please try again.'
      status.value = { phase: 'error', message }
      toast.error('Generation interrupted', { id: toastId, description: message })
    }
  }

  interface JobOutcome {
    kind: 'committed' | 'failed' | 'gave-up'
    message?: string
  }

  /** Heartbeat silence after which a 'streaming' job is considered dead.
   *  (The server touches the job at least every ~20s while streaming.) */
  const JOB_STALE_MS = 90_000
  /** Without a visible job record (older server), fall back to a fixed window. */
  const LEGACY_WINDOW_MS = 180_000
  /** Absolute safety valve, above the server's own 600s ceiling. */
  const MAX_WAIT_MS = 15 * 60_000

  function waitForJobOutcome(
    generationId: string,
    baseSnapshotId: string | null,
  ): Promise<JobOutcome> {
    return new Promise((resolve) => {
      const startedAt = Date.now()
      let settled = false
      let jobSeen = false
      let jobStatus: string | null = null
      let lastHeartbeatMs = Date.now()

      const finish = (outcome: JobOutcome): void => {
        if (settled) return
        settled = true
        stop()
        resolve(outcome)
      }

      const unsubJob = onSnapshot(
        doc(db, 'generations', generationId),
        (snap) => {
          if (!snap.exists()) return
          jobSeen = true
          const data = snap.data() as {
            status?: string
            error?: string
            updatedAt?: { toMillis(): number } | null
          }
          jobStatus = data.status ?? null
          lastHeartbeatMs = data.updatedAt?.toMillis() ?? lastHeartbeatMs
          if (data.status === 'committed') finish({ kind: 'committed' })
          if (data.status === 'failed') {
            finish({ kind: 'failed', message: data.error ?? 'The generation failed.' })
          }
        },
        () => {}, // job doc unreadable — the snapshot fallback still covers success
      )

      // Fallback success signal: the commit moves the head pointer even if
      // every best-effort job write failed.
      const unsubProj = onSnapshot(
        doc(db, 'projects', projectId),
        (snap) => {
          const cur = (snap.data()?.currentSnapshotId as string | undefined) ?? null
          if (cur && cur !== baseSnapshotId) finish({ kind: 'committed' })
        },
        () => {},
      )

      const ticker = setInterval(() => {
        const elapsed = Date.now() - startedAt
        if (elapsed > MAX_WAIT_MS) finish({ kind: 'gave-up' })
        else if (jobSeen && jobStatus === 'streaming') {
          if (Date.now() - lastHeartbeatMs > JOB_STALE_MS) {
            finish({
              kind: 'failed',
              message: 'The server stopped responding mid-generation. Please try again.',
            })
          }
        } else if (!jobSeen && elapsed > LEGACY_WINDOW_MS) {
          finish({ kind: 'gave-up' })
        }
      }, 10_000)

      const onAbort = (): void => finish({ kind: 'gave-up' })
      controller?.signal.addEventListener('abort', onAbort, { once: true })

      function stop(): void {
        unsubJob()
        unsubProj()
        clearInterval(ticker)
        controller?.signal.removeEventListener('abort', onAbort)
      }
    })
  }

  function cancel(): void {
    controller?.abort()
  }

  onUnmounted(() => controller?.abort())

  return {
    status,
    generating,
    finalizing,
    activePath,
    activeFile,
    files,
    filePaths,
    fileCount,
    streamingAssistant,
    lastSnapshotId,
    lastError,
    generate,
    cancel,
  }
}

export type Generation = ReturnType<typeof useGeneration>

/** Injection key for the single shared generation instance per workspace. */
export const GenerationKey: InjectionKey<Generation> = Symbol('generation')
