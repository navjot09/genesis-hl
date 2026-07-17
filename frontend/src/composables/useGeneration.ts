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
import { toast } from 'vue-sonner'
import { authedFetch } from '@/lib/api'

export interface GenFile {
  content: string
  op: string
  streaming: boolean
}

// --- SSE event payload shapes (as written by the backend) -----------------
interface AssistantDeltaData {
  text: string
}
interface FileOpenData {
  path: string
  op: string
}
interface FileDeltaData {
  path: string
  text: string
}
interface FileCloseData {
  path: string
}
interface SnapshotData {
  snapshotId: string
  fileCount: number
  files: { path: string; op: string }[]
}
interface DoneData {
  stopReason: string
  truncated: boolean
  usage?: unknown
  warnings?: string[]
}
interface ErrorData {
  stage: string
  message: string
  detail?: string
  partial?: boolean
}

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

export function useGeneration(projectId: string) {
  const generating = ref(false)
  const activePath = ref<string | null>(null)
  const streamingAssistant = ref('')
  const lastSnapshotId = ref<string | null>(null)
  const lastError = ref<string | null>(null)

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
    lastError.value = null
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
        for (const p of Object.keys(files)) files[p].streaming = false
        break
      }
      case 'done': {
        const d = data as DoneData
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
        generating.value = false
        break
      }
      case 'error': {
        const d = data as ErrorData
        lastError.value = d.message
        toast.error('Generation failed', {
          description: d.message + (d.partial ? ' (partial result kept)' : ''),
        })
        // On a non-partial failure there is nothing usable to keep.
        for (const p of Object.keys(files)) files[p].streaming = false
        generating.value = false
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
    generating.value = true
    controller = new AbortController()

    try {
      const res = await authedFetch('/generate', {
        method: 'POST',
        body: JSON.stringify({ projectId, prompt: text }),
        signal: controller.signal,
      })

      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error ?? `Generation request failed (${res.status})`)
      }

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
    } catch (err) {
      if (controller?.signal.aborted) {
        // User pressed Stop — the backend sees the disconnect and stops.
        toast.info('Generation stopped', {
          description: 'Any completed files were kept.',
        })
      } else {
        const message = err instanceof Error ? err.message : 'Connection lost'
        lastError.value = message
        toast.error('Generation interrupted', {
          description: `${message} — any completed files were kept.`,
        })
      }
    } finally {
      generating.value = false
      controller = null
    }
  }

  function cancel(): void {
    controller?.abort()
  }

  onUnmounted(() => controller?.abort())

  return {
    generating,
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
