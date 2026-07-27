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
  return injectIntoHead(html, buildCsp() + buildBridge(envJson))
}

/**
 * Content-Security-Policy for the preview document.
 *
 * The iframe runs UNTRUSTED generated code. With the token broker (below) the
 * sandbox holds NO credential and needs NO network access of its own, so
 * egress is locked down completely:
 *  - connect-src 'none': zero direct network requests (proxy calls travel over
 *    postMessage to the parent, which holds the real token)
 *  - img/font/media: data:/blob: only — no URL-based beacons
 *  - form-action 'none': no form-based exfiltration
 * Inline script/style must stay allowed — the whole app is inlined into srcdoc.
 */
function buildCsp(): string {
  const policy = [
    `default-src 'none'`,
    `script-src 'unsafe-inline'`,
    `style-src 'unsafe-inline'`,
    `connect-src 'none'`,
    `img-src data: blob:`,
    `font-src data:`,
    `media-src data: blob:`,
    `form-action 'none'`,
    `base-uri 'none'`,
  ].join('; ')
  return `<meta http-equiv="Content-Security-Policy" content="${policy}">\n`
}

/**
 * The runtime injected into every preview (runs BEFORE any generated code).
 *
 * TOKEN BROKER: the sandbox holds no credential. `env.token` is a placeholder;
 * window.fetch is replaced with a shim that relays proxy-bound requests to the
 * PARENT over postMessage. The parent validates the path, attaches the real
 * capability token, performs the network call, and posts the result back. So
 * even fully malicious generated code has exactly one capability — asking the
 * broker — and nothing worth exfiltrating. Existing generated apps keep
 * working unchanged: they already call fetch(env.proxyUrl + path, ...).
 *
 * WATCHDOG: pings the parent every 3s; a stopped ping means the generated app
 * froze (e.g. an infinite loop) and the parent can offer a reload.
 *
 * Also exposes `onWebhook(handler)` — live HighLevel events polled via the
 * same brokered fetch.
 */
function buildBridge(envJson: string): string {
  return `<script>
(function () {
  var env = ${envJson};
  window.__GENESIS__ = env;

  function ping() {
    try { parent.postMessage({ __genesis: true, kind: 'ping' }, '*'); } catch (e) {}
  }
  ping();
  setInterval(ping, 3000);

  if (!env || !env.proxyUrl) return;

  // --- Brokered fetch -------------------------------------------------------
  var pending = {};
  var seq = 0;
  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (!d || d.__genesis !== true || d.kind !== 'hl-response') return;
    var entry = pending[d.id];
    if (!entry) return;
    delete pending[d.id];
    clearTimeout(entry.timer);
    entry.resolve({
      ok: d.ok,
      status: d.status,
      json: function () { return Promise.resolve(d.body); },
      text: function () {
        return Promise.resolve(typeof d.body === 'string' ? d.body : JSON.stringify(d.body));
      },
    });
  });

  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.indexOf(env.proxyUrl) !== 0) {
      return Promise.reject(new TypeError('Network access is disabled in the preview sandbox'));
    }
    var id = ++seq;
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        if (pending[id]) {
          delete pending[id];
          reject(new TypeError('Preview bridge timed out'));
        }
      }, 20000);
      pending[id] = { resolve: resolve, timer: timer };
      parent.postMessage({
        __genesis: true,
        kind: 'hl-fetch',
        id: id,
        path: url.slice(env.proxyUrl.length),
        method: (init && init.method) || 'GET',
        body: init && typeof init.body === 'string' ? init.body : null,
      }, '*');
    });
  };

  // --- Live HighLevel webhook events (rides the brokered fetch) -------------
  var handlers = [];
  // Only surface events that arrive AFTER this preview loads.
  var since = new Date().toISOString();
  var timer = null;

  async function poll() {
    try {
      var res = await fetch(env.proxyUrl + '/__events?since=' + encodeURIComponent(since));
      if (res.ok) {
        var body = await res.json();
        var events = (body && body.events) || [];
        if (events.length) {
          since = events[events.length - 1].receivedAt || since;
          events.forEach(function (ev) {
            handlers.forEach(function (h) {
              try { h(ev); } catch (_) {}
            });
          });
        }
      }
    } catch (_) { /* transient — try again next tick */ }
    timer = setTimeout(poll, 5000);
  }

  env.onWebhook = function (handler) {
    if (typeof handler !== 'function') return function () {};
    handlers.push(handler);
    if (timer === null) timer = setTimeout(poll, 1500);
    // returns an unsubscribe fn
    return function () {
      var i = handlers.indexOf(handler);
      if (i >= 0) handlers.splice(i, 1);
    };
  };
})();
</script>`
}
