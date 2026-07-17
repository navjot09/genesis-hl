/**
 * Builds a single self-contained HTML document for the live preview iframe.
 *
 * The generated app is vanilla HTML/CSS/JS with index.html linking ./styles.css
 * and ./app.js. A `srcdoc` iframe has no file server, so we INLINE every linked
 * local css/js into index.html, and inject `window.__GENESIS__` so the app can
 * reach real HighLevel data through the proxy (or run its demo fallback when the
 * user hasn't connected HighLevel).
 *
 * The iframe is sandboxed WITHOUT allow-same-origin, so this untrusted, LLM-
 * generated code runs at an opaque origin and cannot touch the parent app's
 * Firebase session. It can only call the allowlisted proxy with the short-lived
 * preview capability token.
 */

export interface GenesisEnv {
  proxyUrl: string
  token: string
}

const basename = (p: string): string => p.slice(p.lastIndexOf('/') + 1)
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Find the project's entry HTML (index.html preferred, else any .html). */
function findIndexHtml(files: Record<string, string>): string | null {
  const keys = Object.keys(files)
  const idx = keys.find((k) => basename(k).toLowerCase() === 'index.html')
  if (idx) return files[idx]
  const anyHtml = keys.find((k) => k.toLowerCase().endsWith('.html'))
  return anyHtml ? files[anyHtml] : null
}

/** Replace `<link ... href="...name.css">` with an inline <style>. */
function inlineCss(html: string, name: string, css: string): string {
  const re = new RegExp(
    `<link\\b[^>]*href=["'][^"']*${escapeRe(name)}["'][^>]*>`,
    'gi',
  )
  return html.replace(re, `<style>\n${css}\n</style>`)
}

/** Replace `<script src="...name.js"></script>` with an inline <script>. */
function inlineJs(html: string, name: string, js: string): string {
  const re = new RegExp(
    `<script\\b[^>]*src=["'][^"']*${escapeRe(name)}["'][^>]*>\\s*</script>`,
    'gi',
  )
  return html.replace(re, `<script>\n${js}\n</script>`)
}

/** Inject a script at the very start of <head> (so it runs before app scripts). */
function injectIntoHead(html: string, script: string): string {
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => `${m}\n${script}`)
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => `${m}\n<head>${script}</head>`)
  return `${script}\n${html}`
}

/**
 * Build the self-contained preview document. Returns null if there's no HTML
 * entry file to render.
 */
export function buildPreviewHtml(
  files: Record<string, string>,
  env: GenesisEnv | null,
): string | null {
  let html = findIndexHtml(files)
  if (html === null) return null

  for (const [path, content] of Object.entries(files)) {
    const name = basename(path)
    if (name.toLowerCase().endsWith('.css')) html = inlineCss(html, name, content)
    else if (name.toLowerCase().endsWith('.js')) html = inlineJs(html, name, content)
  }

  // Provide the Genesis runtime bridge (or leave it undefined so the generated
  // app uses its demo fallback). JSON.stringify keeps the token out of the way
  // of any accidental </script> in content.
  const envJson = env ? JSON.stringify(env) : 'undefined'
  const bridge = `<script>window.__GENESIS__ = ${envJson};</script>`
  return injectIntoHead(html, bridge)
}
