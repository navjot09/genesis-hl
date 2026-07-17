/**
 * /hlProxy — the allowlisted forwarder that lets the workspace UI and the
 * GENERATED app (untrusted, in an iframe) read real HighLevel data without
 * ever holding the HL OAuth token.
 *
 * Auth accepted (Bearer):
 *   1. a preview capability token (what generated apps get), or
 *   2. a Firebase ID token (the workspace UI itself).
 *
 * Location scoping: the caller's locationId comes from its token, never from
 * the request. Any caller-supplied locationId that disagrees is rejected; when
 * absent, the proxy injects the right one (generated code stays simple).
 */
import { onRequest } from 'firebase-functions/v2/https';
import { db } from '../lib/admin.js';
import { bearerToken, requireFirebaseUser } from '../lib/authn.js';
import { HL_CLIENT_SECRET, PREVIEW_TOKEN_SECRET } from '../config.js';
import { hlFetch } from '../hl/client.js';
import { HlAuthError } from '../hl/tokens.js';
import { matchRule } from './allowlist.js';
import { mintPreviewJwt, verifyPreviewJwt } from './preview.js';

/** Mint a preview capability token for the signed-in user's connected location. */
export const mintPreviewToken = onRequest(
  { cors: true, secrets: [PREVIEW_TOKEN_SECRET] },
  async (req, res) => {
    let uid: string;
    try {
      ({ uid } = await requireFirebaseUser(req));
    } catch {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const user = await db.collection('users').doc(uid).get();
    const hl = user.data()?.hl as { connected?: boolean; locationId?: string } | undefined;
    if (!hl?.connected || !hl.locationId) {
      res.status(409).json({ error: 'HighLevel is not connected' });
      return;
    }

    res.json(mintPreviewJwt({ uid, locationId: hl.locationId }));
  },
);

/** Normalise the HL path from the request URL (strip the function prefix). */
function hlPathFromRequest(path: string): string {
  const idx = path.indexOf('/hlProxy');
  const p = idx >= 0 ? path.slice(idx + '/hlProxy'.length) : path;
  return p === '' ? '/' : p;
}

export const hlProxy = onRequest(
  { secrets: [PREVIEW_TOKEN_SECRET, HL_CLIENT_SECRET], timeoutSeconds: 60 },
  async (req, res) => {
    // CORS: allow ALL origins with `*` (not reflection). The generated app calls
    // this from a sandboxed srcdoc iframe whose Origin is the opaque value "null";
    // a reflected `null` ACAO is unreliable across browsers, so use `*`. Requests
    // are non-credentialed (bearer token, no cookies), so `*` is valid + safe.
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.set('Access-Control-Max-Age', '3600');
    res.set('Vary', 'Origin');
    if (req.method === 'OPTIONS') {
      res.status(204).send('');
      return;
    }

    // --- Authenticate: preview capability token, else Firebase ID token. ---
    const raw = bearerToken(req);
    if (!raw) {
      res.status(401).json({ error: 'Missing bearer token' });
      return;
    }

    let uid: string;
    let tokenLocationId: string | null = null;
    const preview = verifyPreviewJwt(raw);
    if (preview) {
      uid = preview.uid;
      tokenLocationId = preview.locationId;
    } else {
      try {
        ({ uid } = await requireFirebaseUser(req));
      } catch {
        res.status(401).json({ error: 'Invalid token' });
        return;
      }
    }

    // --- Allowlist gate (before any token work). ---
    const hlPath = hlPathFromRequest(req.path);
    const rule = matchRule(req.method, hlPath);
    if (!rule) {
      res.status(403).json({
        error: `Endpoint not allowed: ${req.method} ${hlPath}`,
        hint: 'The Genesis proxy exposes a fixed allowlist of HighLevel endpoints.',
      });
      return;
    }

    // --- Resolve + enforce location scoping. ---
    if (tokenLocationId === null) {
      const user = await db.collection('users').doc(uid).get();
      const hl = user.data()?.hl as { locationId?: string } | undefined;
      tokenLocationId = hl?.locationId ?? null;
    }
    if (!tokenLocationId) {
      res.status(409).json({ error: 'HighLevel is not connected' });
      return;
    }

    const query: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.query)) {
      if (typeof v === 'string') query[k] = v;
      else if (Array.isArray(v)) query[k] = v.map(String);
    }

    const sentLocation =
      (typeof query.locationId === 'string' ? query.locationId : undefined) ??
      (req.body && typeof req.body === 'object'
        ? (req.body as Record<string, unknown>).locationId
        : undefined);
    if (sentLocation !== undefined && sentLocation !== tokenLocationId) {
      res.status(403).json({ error: 'locationId mismatch' });
      return;
    }

    let body: Record<string, unknown> | undefined;
    if (req.method === 'POST' || req.method === 'PUT') {
      body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
    }

    // Place locationId exactly where this endpoint expects it (from the token,
    // never the caller); strip it where HL derives/rejects it.
    delete query.locationId;
    if (body) delete body.locationId;
    if (rule.locationId === 'query') query.locationId = tokenLocationId;
    else if (rule.locationId === 'body' && body) body.locationId = tokenLocationId;

    // --- Forward. ---
    try {
      const out = await hlFetch(uid, { method: req.method, path: hlPath, query, body });
      res.status(out.status).json(out.body);
    } catch (err) {
      if (err instanceof HlAuthError) {
        res.status(502).json({ error: 'HighLevel auth failed', detail: err.message });
      } else {
        res.status(502).json({ error: 'HighLevel request failed', detail: String(err) });
      }
    }
  },
);
