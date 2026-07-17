/**
 * Bundle Monaco locally (no CDN loader) and wire up its web workers through
 * Vite's `?worker` imports. Imported once from `main.ts` so the editor is
 * configured before any <VueMonacoEditor> mounts.
 */
import * as monaco from 'monaco-editor'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'
import { loader } from '@guolao/vue-monaco-editor'

interface MonacoEnvironmentHost {
  MonacoEnvironment?: {
    getWorker: (workerId: string, label: string) => Worker
  }
}

;(self as unknown as MonacoEnvironmentHost).MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    if (label === 'json') return new jsonWorker()
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker()
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker()
    if (label === 'typescript' || label === 'javascript') return new tsWorker()
    return new editorWorker()
  },
}

// Hand our locally-bundled monaco to the loader so it never fetches the CDN.
loader.config({ monaco: monaco as unknown as Parameters<typeof loader.config>[0]['monaco'] })

/** Map a file path's extension to a Monaco language id. */
export function languageForPath(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  switch (ext) {
    case 'html':
    case 'htm':
      return 'html'
    case 'css':
      return 'css'
    case 'json':
      return 'json'
    case 'ts':
      return 'typescript'
    case 'js':
    case 'mjs':
    case 'cjs':
      return 'javascript'
    case 'vue':
      return 'html'
    case 'md':
      return 'markdown'
    default:
      return 'plaintext'
  }
}
