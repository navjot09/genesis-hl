/**
 * Pure path→language-id mapping. Lives OUTSIDE lib/monaco.ts so components can
 * import it without statically pulling the multi-MB monaco-editor bundle into
 * their chunk — Monaco itself is dynamic-imported only when an editor mounts.
 */
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
