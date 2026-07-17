/**
 * HighLevel OAuth 2.0 flow (authorization code, user_type=Location).
 *
 * Security note — account-linking CSRF defense:
 *   The token exchange + account linking happens in `hlOauthComplete`, which is
 *   AUTHENTICATED and requires BOTH (a) the caller's Firebase identity to equal
 *   the flow's initiator (state.uid), and (b) possession of the authorization
 *   `code`. In a phishing attack these two never coexist: the victim's browser
 *   receives the code (from HL consent) but is authenticated as the victim (≠
 *   initiator), while the attacker is the initiator but never receives the
 *   victim's code. So a flow started in one session cannot be completed in
 *   another. `oauthCallback` itself only bounces code+state back to the SPA — it
 *   never exchanges or links, so it needs no secret and links no account.
 */
import { onRequest } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { randomBytes } from 'node:crypto';
import { db } from '../lib/admin.js';
import { AuthError, requireFirebaseUser } from '../lib/authn.js';
import {
  APP_BASE_URL,
  HL_AUTHORIZE_BASE,
  HL_CLIENT_ID,
  HL_CLIENT_SECRET,
  HL_REDIRECT_URI,
  HL_SCOPES,
} from '../config.js';
import { OAUTH_STATE_TTL_MS } from '../hl/constants.js';
import { exchangeCode, saveTokens } from '../hl/tokens.js';
import { hlFetch } from '../hl/client.js';

/** Step 1 — SPA calls this (authed); it stores `state` in sessionStorage and navigates to `url`. */
export const hlOauthStart = onRequest({ cors: true }, async (req, res) => {
  let uid: string;
  try {
    ({ uid } = await requireFirebaseUser(req));
  } catch (err) {
    res.status(401).json({ error: err instanceof AuthError ? err.message : 'Unauthorized' });
    return;
  }

  const state = randomBytes(24).toString('hex');
  await db.collection('oauthStates').doc(state).set({
    uid,
    createdAt: FieldValue.serverTimestamp(),
  });

  const url = new URL('/oauth/chooselocation', HL_AUTHORIZE_BASE.value());
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', HL_REDIRECT_URI.value());
  url.searchParams.set('client_id', HL_CLIENT_ID.value());
  url.searchParams.set('scope', HL_SCOPES.value());
  url.searchParams.set('state', state);

  res.json({ url: url.toString(), state });
});

/**
 * Step 2 — HighLevel redirects the browser here with ?code&state (or ?error).
 * This endpoint does NOT exchange or link; it only forwards code+state to the
 * SPA, which completes the flow authenticated (see hlOauthComplete).
 */
export const oauthCallback = onRequest({ cors: true }, (req, res) => {
  const dest = new URL(APP_BASE_URL.value());
  const q = req.query;

  if (typeof q.error === 'string' && q.error) {
    dest.searchParams.set('hl', 'error');
    dest.searchParams.set('reason', String(q.error_description ?? q.error));
  } else if (typeof q.code === 'string' && typeof q.state === 'string' && q.code && q.state) {
    dest.searchParams.set('hl', 'callback');
    dest.searchParams.set('state', q.state);
    dest.searchParams.set('code', q.code);
  } else {
    dest.searchParams.set('hl', 'error');
    dest.searchParams.set('reason', 'missing_code_or_state');
  }

  res.redirect(302, dest.toString());
});

/**
 * Step 3 — SPA calls this (authed) with {state, code} after the callback.
 * Verifies the completer IS the initiator, exchanges the code, and links tokens.
 */
export const hlOauthComplete = onRequest(
  { cors: true, secrets: [HL_CLIENT_SECRET] },
  async (req, res) => {
    let uid: string;
    try {
      ({ uid } = await requireFirebaseUser(req));
    } catch (err) {
      res.status(401).json({ error: err instanceof AuthError ? err.message : 'Unauthorized' });
      return;
    }

    const body = (req.body ?? {}) as { state?: unknown; code?: unknown };
    const state = typeof body.state === 'string' ? body.state : '';
    const code = typeof body.code === 'string' ? body.code : '';
    if (!state || !code) {
      res.status(400).json({ error: 'Missing state or code' });
      return;
    }

    // Resolve + consume the single-use, TTL-bound state nonce.
    const stateRef = db.collection('oauthStates').doc(state);
    const stateSnap = await stateRef.get();
    if (!stateSnap.exists) {
      res.status(400).json({ error: 'invalid_state' });
      return;
    }
    const { uid: initiatorUid, createdAt } = stateSnap.data() as {
      uid: string;
      createdAt?: Timestamp;
    };
    await stateRef.delete(); // single-use regardless of outcome

    const age = createdAt ? Date.now() - createdAt.toMillis() : Infinity;
    if (age > OAUTH_STATE_TTL_MS) {
      res.status(400).json({ error: 'state_expired' });
      return;
    }
    // The CSRF guard: only the initiator, authenticated, may complete their flow.
    if (initiatorUid !== uid) {
      logger.warn('OAuth completer is not the initiator', { initiatorUid, completerUid: uid });
      res.status(403).json({ error: 'state_user_mismatch' });
      return;
    }

    try {
      const tokens = await exchangeCode(code);
      const saved = await saveTokens(uid, tokens);

      let locationName = '';
      try {
        const loc = await hlFetch(uid, { method: 'GET', path: `/locations/${saved.locationId}` });
        if (loc.status === 200) {
          locationName = (loc.body as { location?: { name?: string } }).location?.name ?? '';
        }
      } catch (err) {
        logger.warn('Could not fetch HL location name', { err: String(err) });
      }

      await db.collection('users').doc(uid).set(
        {
          hl: {
            connected: true,
            locationId: saved.locationId,
            locationName,
            scope: saved.scope ?? '',
            connectedAt: FieldValue.serverTimestamp(),
          },
        },
        { merge: true },
      );

      res.json({ connected: true, locationId: saved.locationId, locationName });
    } catch (err) {
      logger.error('OAuth code exchange failed', { err: String(err) });
      res.status(502).json({ error: 'token_exchange_failed' });
    }
  },
);
