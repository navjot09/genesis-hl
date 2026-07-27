/**
 * Genesis Cloud Functions entrypoint. Each subsystem lives in its own module;
 * this file only wires exports and global options.
 */
import { setGlobalOptions } from 'firebase-functions/v2';
import { onRequest } from 'firebase-functions/v2/https';
import { DEFAULT_REGION } from './config.js';
import './lib/admin.js';

setGlobalOptions({ region: DEFAULT_REGION, memory: '512MiB', maxInstances: 10 });

// HighLevel OAuth flow
export { hlOauthStart, oauthCallback, hlOauthComplete } from './oauth/index.js';
// Preview capability tokens + allowlisted HL proxy
export { mintPreviewToken, hlProxy } from './proxy/index.js';
// Streaming generation pipeline
export { generate } from './generate/index.js';
// Snapshot restore (version control)
export { restoreSnapshot } from './generate/restore.js';
// HighLevel webhook receiver — stores events for generated apps to react to
export { hlWebhook } from './webhooks/index.js';
// Scheduled hygiene: mark generation jobs whose instance died as failed
export { sweepStaleGenerations } from './jobs/sweeper.js';

/** Simple liveness probe. */
export const health = onRequest({ cors: true }, (_req, res) => {
  res.json({ ok: true, service: 'genesis-functions', ts: Date.now() });
});
