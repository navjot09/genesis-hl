/**
 * Genesis Cloud Functions entrypoint.
 *
 * Day 1: a health check + an SSE streaming proof (no LLM) that verifies tokens
 * reach the browser un-buffered end-to-end. OAuth, generation, and the HL proxy
 * are added in later phases and exported from here.
 */
import { setGlobalOptions } from 'firebase-functions/v2';
import { onRequest } from 'firebase-functions/v2/https';
import { DEFAULT_REGION } from './config.js';
import { startSse } from './http/sse.js';
import './lib/admin.js';

setGlobalOptions({ region: DEFAULT_REGION, memory: '512MiB', maxInstances: 10 });

// HighLevel OAuth flow (Day 2)
export { hlOauthStart, oauthCallback, hlOauthComplete } from './oauth/index.js';
// Preview capability tokens + allowlisted HL proxy (Day 2)
export { mintPreviewToken, hlProxy } from './proxy/index.js';
// Streaming generation pipeline (Day 3)
export { generate } from './generate/index.js';
// Snapshot restore (version control)
export { restoreSnapshot } from './generate/restore.js';
// HighLevel webhook receiver — stores events for generated apps to react to
export { hlWebhook } from './webhooks/index.js';

/** Simple liveness probe. */
export const health = onRequest({ cors: true }, (_req, res) => {
  res.json({ ok: true, service: 'genesis-functions', ts: Date.now() });
});

/**
 * Day-1 de-risk: prove SSE streams incrementally. Emits `token` events with a
 * small delay, then `done`. Consume with fetch + ReadableStream (or curl -N).
 */
export const sseDemo = onRequest({ cors: true, timeoutSeconds: 600 }, async (req, res) => {
  const sse = startSse(res, req);

  // Diagnostic mode: ?seconds=N&intervalMs=M streams a steady counter for N
  // seconds (no LLM) to isolate pure transport behaviour from generation.
  const seconds = Math.min(Number(req.query.seconds) || 0, 300);
  if (seconds > 0) {
    const intervalMs = Math.min(Math.max(Number(req.query.intervalMs) || 2000, 200), 60000);
    const ticks = Math.floor((seconds * 1000) / intervalMs);
    for (let i = 0; i < ticks; i++) {
      if (sse.closed) break;
      sse.send('token', { index: i, atMs: i * intervalMs });
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    if (!sse.closed) sse.send('done', { count: ticks });
    sse.end();
    return;
  }

  const words =
    'the quick brown fox jumps over the lazy dog while genesis streams tokens to the browser in real time'.split(
      ' ',
    );

  for (let i = 0; i < words.length; i++) {
    if (sse.closed) break;
    sse.send('token', { text: words[i] + ' ', index: i });
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  if (!sse.closed) sse.send('done', { count: words.length });
  sse.end();
});
