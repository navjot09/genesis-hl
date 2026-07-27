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
import { onRequest, type Request } from 'firebase-functions/v2/https';
import type { Response } from 'express';
import { db } from '../lib/admin.js';
import { bearerToken, requireFirebaseUser } from '../lib/authn.js';
import { HL_CLIENT_SECRET, PREVIEW_TOKEN_SECRET } from '../config.js';
import { hlFetch } from '../hl/client.js';
import { HlAuthError } from '../hl/tokens.js';
import { matchRule } from './allowlist.js';
import { mintPreviewJwt, verifyPreviewJwt } from './preview.js';
import { checkRateLimit } from '../lib/rateLimit.js';
import { AppError, sendError } from '../lib/errors.js';
import { RATE_WINDOWS } from '../config/limits.js';
import { UserDocSchema, zodConverter } from '../lib/typedFirestore.js';

/**
 * Endpoints with real-world side effects (messages sent to actual customers,
 * contact writes). These get a per-user quota so a prompt-injected or buggy
 * generated app cannot spam a tenant's real contacts.
 */
function hasSideEffects(method: string, hlPath: string): boolean {
  if (method === 'PUT' || method === 'DELETE') return true;
  if (method !== 'POST') return false;
  return hlPath !== '/contacts/search'; // POST search is read-shaped; other POSTs mutate
}

/** Mint a preview capability token for the signed-in user's connected location. */
export const mintPreviewToken = onRequest(
  { cors: true, secrets: [PREVIEW_TOKEN_SECRET] },
  async (req, res) => {
    try {
      let uid: string;
      try {
        ({ uid } = await requireFirebaseUser(req));
      } catch {
        throw new AppError('UNAUTHORIZED', 'Sign in required');
      }

      const users = db.collection('users').withConverter(zodConverter(UserDocSchema));
      const user = await users.doc(uid).get();
      const hl = user.data()?.hl;
      if (!hl?.connected || !hl.locationId) {
        throw new AppError('CONFLICT', 'HighLevel is not connected');
      }

      res.json(mintPreviewJwt({ uid, locationId: hl.locationId }));
    } catch (err) {
      sendError(res, err);
    }
  },
);

/** Normalise the HL path from the request URL (strip the function prefix). */
function hlPathFromRequest(path: string): string {
  const idx = path.indexOf('/hlProxy');
  const p = idx >= 0 ? path.slice(idx + '/hlProxy'.length) : path;
  return p === '' ? '/' : p;
}

/**
 * Serve recent HL webhook events for a location from Firestore (written by the
 * hlWebhook receiver). `since` is an ISO timestamp; only later events return, so
 * the generated app can poll incrementally. Capped so a poll stays cheap.
 */
async function serveWebhookEvents(
  res: Response,
  locationId: string,
  sinceRaw: unknown,
): Promise<void> {
  const since = typeof sinceRaw === 'string' ? new Date(sinceRaw) : null;
  const sinceDate = since && !isNaN(since.getTime()) ? since : new Date(0);

  const snap = await db
    .collection('webhookEvents')
    .doc(locationId)
    .collection('events')
    .where('receivedAt', '>', sinceDate)
    .orderBy('receivedAt', 'asc')
    .limit(50)
    .get();

  const events = snap.docs.map((d) => {
    const data = d.data();
    const ts = data.receivedAt as { toDate?: () => Date } | undefined;
    return {
      id: d.id,
      type: data.type ?? 'Unknown',
      data: data.data ?? {},
      receivedAt: ts?.toDate ? ts.toDate().toISOString() : new Date(0).toISOString(),
    };
  });

  res.json({ events });
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

    try {
      await handleProxyRequest(req, res);
    } catch (err) {
      sendError(res, err);
    }
  },
);

async function handleProxyRequest(req: Request, res: Response): Promise<void> {
    // --- Authenticate: preview capability token, else Firebase ID token. ---
    const raw = bearerToken(req);
    if (!raw) throw new AppError('UNAUTHORIZED', 'Missing bearer token');

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
        throw new AppError('UNAUTHORIZED', 'Invalid token');
      }
    }

    const hlPath = hlPathFromRequest(req.path);

    // --- Resolve the caller's location (from the token, never the request). ---
    if (tokenLocationId === null) {
      const users = db.collection('users').withConverter(zodConverter(UserDocSchema));
      const user = await users.doc(uid).get();
      tokenLocationId = user.data()?.hl?.locationId ?? null;
    }
    if (!tokenLocationId) throw new AppError('CONFLICT', 'HighLevel is not connected');

    // --- Genesis-internal route: live HL webhook events for this location. ---
    // Not forwarded to HL — served from Firestore (written by the hlWebhook
    // receiver). Lets a sandboxed generated app react to events using only its
    // capability token, with no direct database access. GET /__events?since=<ISO>
    if (req.method === 'GET' && hlPath === '/__events') {
      await serveWebhookEvents(res, tokenLocationId, req.query.since);
      return;
    }

    // --- Allowlist gate (before any token work). ---
    const rule = matchRule(req.method, hlPath);
    if (!rule) {
      throw new AppError('FORBIDDEN', `Endpoint not allowed: ${req.method} ${hlPath}`, {
        hint: 'The Genesis proxy exposes a fixed allowlist of HighLevel endpoints.',
      });
    }

    // Side-effecting endpoints (send message, write contact) are quota'd: the
    // preview runs UNTRUSTED generated code, and these actions reach real
    // customers. 15/min per user bounds the blast radius of a bad generation.
    if (hasSideEffects(req.method, hlPath)) {
      const rl = await checkRateLimit(uid, 'hl-write', RATE_WINDOWS.hlWrite.limit, RATE_WINDOWS.hlWrite.windowMs);
      if (!rl.allowed) {
        throw new AppError(
          'RATE_LIMITED',
          `Write limit reached (${RATE_WINDOWS.hlWrite.limit}/min). Slow down and try again shortly.`,
          { retryAfterSeconds: Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000)) },
        );
      }
    }

    // --- Enforce location scoping. ---
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
      throw new AppError('FORBIDDEN', 'locationId mismatch');
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
        throw new AppError('HL_UPSTREAM', 'HighLevel auth failed', { detail: err.message });
      }
      throw new AppError('HL_UPSTREAM', 'HighLevel request failed');
    }
}
