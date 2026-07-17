/**
 * HighLevel OAuth token storage + refresh.
 *
 * Tokens live in `hlTokens/{uid}` — a backend-only collection (security rules
 * default-deny; the client can never read them). `users/{uid}` holds only safe
 * connection metadata for the dashboard UI.
 *
 * ⚠️ HL refresh tokens are SINGLE-USE and rotate on every refresh. Losing the
 * rotated token (or double-refreshing concurrently) permanently invalidates the
 * grant and forces a reinstall. So:
 *   - refresh proactively (TOKEN_REFRESH_MARGIN_MS before expiry),
 *   - serialize refreshes with a Firestore-transaction lock per user,
 *   - ALWAYS persist the refresh_token returned by each refresh response.
 */
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { db } from '../lib/admin.js';
import { HL_API_BASE, HL_CLIENT_ID, HL_CLIENT_SECRET, HL_REDIRECT_URI } from '../config.js';
import { REFRESH_LOCK_TTL_MS, TOKEN_REFRESH_MARGIN_MS } from './constants.js';

export interface HlTokenDoc {
  accessToken: string;
  refreshToken: string;
  /** Absolute expiry of accessToken, epoch ms. */
  expiresAt: number;
  locationId: string;
  companyId?: string;
  scope?: string;
  userType?: string;
  refreshLockAt?: Timestamp | null;
  updatedAt?: Timestamp;
}

interface HlTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  locationId?: string;
  companyId?: string;
  scope?: string;
  userType?: string;
}

export class HlAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HlAuthError';
  }
}

const tokenRef = (uid: string) => db.collection('hlTokens').doc(uid);

async function postTokenEndpoint(body: Record<string, string>): Promise<HlTokenResponse> {
  const res = await fetch(`${HL_API_BASE.value()}/oauth/token`, {
    method: 'POST',
    // HL's token endpoint expects form-encoding (its docs are inconsistent; form works).
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(body).toString(),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new HlAuthError(
      `HL token endpoint ${res.status}: ${JSON.stringify(json).slice(0, 300)}`,
    );
  }
  return json as unknown as HlTokenResponse;
}

/** Exchange an authorization code for tokens (user_type=Location → one sub-account). */
export async function exchangeCode(code: string): Promise<HlTokenResponse> {
  return postTokenEndpoint({
    grant_type: 'authorization_code',
    client_id: HL_CLIENT_ID.value(),
    client_secret: HL_CLIENT_SECRET.value(),
    code,
    redirect_uri: HL_REDIRECT_URI.value(),
    user_type: 'Location',
  });
}

async function refreshWithHl(refreshToken: string): Promise<HlTokenResponse> {
  return postTokenEndpoint({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: HL_CLIENT_ID.value(),
    client_secret: HL_CLIENT_SECRET.value(),
    user_type: 'Location',
    redirect_uri: HL_REDIRECT_URI.value(),
  });
}

/**
 * Persist a token response (initial exchange or refresh). Always overwrites
 * refreshToken. Merge semantics + undefined-stripping matter: HL's REFRESH
 * responses omit companyId/scope/locationId — those keep their stored values
 * (Firestore rejects `undefined` outright).
 */
export async function saveTokens(uid: string, t: HlTokenResponse): Promise<HlTokenDoc> {
  const doc: HlTokenDoc = {
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    expiresAt: Date.now() + t.expires_in * 1000,
    locationId: t.locationId ?? '',
    companyId: t.companyId,
    scope: t.scope,
    userType: t.userType,
    refreshLockAt: null,
  };
  const write: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
  for (const [k, v] of Object.entries(doc)) {
    if (v !== undefined) write[k] = v;
  }
  await tokenRef(uid).set(write, { merge: true });
  return doc;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Return a currently-valid access token for `uid`, refreshing if needed.
 *
 * Concurrency: a Firestore transaction atomically claims `refreshLockAt`; exactly
 * one caller performs the HL refresh while others poll until the new token lands.
 * `force` treats the current token as expired regardless of expiresAt (used for
 * the single retry after an unexpected 401 from HL).
 */
export async function ensureFreshToken(
  uid: string,
  opts: { force?: boolean } = {},
  attempt = 0,
): Promise<{ accessToken: string; locationId: string }> {
  if (attempt > 3) throw new HlAuthError('Token refresh contention: too many attempts');

  const claim = await db.runTransaction(async (tx) => {
    const snap = await tx.get(tokenRef(uid));
    if (!snap.exists) return { action: 'missing' as const };
    const d = snap.data() as HlTokenDoc;

    const fresh = !opts.force && d.expiresAt - Date.now() > TOKEN_REFRESH_MARGIN_MS;
    if (fresh) {
      return { action: 'ok' as const, accessToken: d.accessToken, locationId: d.locationId };
    }

    const lockAgeMs = d.refreshLockAt ? Date.now() - d.refreshLockAt.toMillis() : Infinity;
    if (lockAgeMs < REFRESH_LOCK_TTL_MS) return { action: 'wait' as const };

    tx.update(tokenRef(uid), { refreshLockAt: Timestamp.now() });
    return { action: 'refresh' as const, refreshToken: d.refreshToken, locationId: d.locationId };
  });

  switch (claim.action) {
    case 'missing':
      throw new HlAuthError('HighLevel is not connected for this user');

    case 'ok':
      return { accessToken: claim.accessToken, locationId: claim.locationId };

    case 'wait': {
      // Another caller is refreshing; poll for the outcome, then re-evaluate.
      for (let i = 0; i < 20; i++) {
        await sleep(500);
        const snap = await tokenRef(uid).get();
        const d = snap.data() as HlTokenDoc | undefined;
        if (!d) throw new HlAuthError('HighLevel connection was removed');
        if (d.expiresAt - Date.now() > TOKEN_REFRESH_MARGIN_MS) {
          return { accessToken: d.accessToken, locationId: d.locationId };
        }
        if (!d.refreshLockAt) break; // holder failed and released — take over
      }
      return ensureFreshToken(uid, {}, attempt + 1);
    }

    case 'refresh': {
      try {
        const t = await refreshWithHl(claim.refreshToken);
        const saved = await saveTokens(uid, {
          ...t,
          // Some responses omit locationId on refresh — keep the original.
          locationId: t.locationId ?? claim.locationId,
        });
        return { accessToken: saved.accessToken, locationId: saved.locationId };
      } catch (err) {
        await tokenRef(uid).update({ refreshLockAt: null }).catch(() => undefined);
        throw err instanceof HlAuthError
          ? err
          : new HlAuthError(`Refresh failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}
