/**
 * Authenticated HighLevel API client used by the proxy and (later) generation
 * context assembly. Injects the per-user access token + per-module Version
 * header; on an unexpected 401 performs exactly one locked refresh-and-retry.
 */
import { HL_API_BASE } from '../config.js';
import { hlVersionForPath } from './constants.js';
import { ensureFreshToken } from './tokens.js';

export interface HlResponse {
  status: number;
  body: unknown;
}

export interface HlRequest {
  method: string;
  /** HL API path, e.g. "/contacts/search". */
  path: string;
  query?: Record<string, string | string[]>;
  body?: unknown;
}

export async function hlFetch(uid: string, reqSpec: HlRequest): Promise<HlResponse> {
  const attempt = async (force: boolean): Promise<HlResponse> => {
    const { accessToken } = await ensureFreshToken(uid, { force });

    const url = new URL(reqSpec.path, HL_API_BASE.value());
    for (const [k, v] of Object.entries(reqSpec.query ?? {})) {
      for (const item of Array.isArray(v) ? v : [v]) url.searchParams.append(k, item);
    }

    const res = await fetch(url, {
      method: reqSpec.method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Version: hlVersionForPath(reqSpec.path),
        Accept: 'application/json',
        ...(reqSpec.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: reqSpec.body !== undefined ? JSON.stringify(reqSpec.body) : undefined,
    });

    const body: unknown = await res.json().catch(() => ({}));
    return { status: res.status, body };
  };

  const first = await attempt(false);
  if (first.status !== 401) return first;
  // Token may have been revoked/expired server-side despite our clock: one locked
  // refresh, one retry. A second 401 is returned to the caller as-is.
  return attempt(true);
}
