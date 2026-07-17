/**
 * HighLevel API constants.
 *
 * ⚠️ The `Version` header value differs PER MODULE (verified against the official
 * OpenAPI specs in github.com/GoHighLevel/highlevel-api-docs):
 *   - Contacts:      2021-07-28
 *   - Conversations: 2021-04-15
 *   - Calendars:     2021-04-15
 *   - Locations:     2021-07-28
 * Sending the wrong value is rejected (401/422).
 */

const VERSION_BY_MODULE: Record<string, string> = {
  contacts: '2021-07-28',
  conversations: '2021-04-15',
  calendars: '2021-04-15',
  locations: '2021-07-28',
};

/** Resolve the Version header for an HL API path like "/contacts/search". */
export function hlVersionForPath(path: string): string {
  const module = path.replace(/^\/+/, '').split('/')[0] ?? '';
  return VERSION_BY_MODULE[module] ?? '2021-07-28';
}

/** How long before expiry we proactively refresh the access token. */
export const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** A concurrent refresher's lock is considered stale after this long. */
export const REFRESH_LOCK_TTL_MS = 30 * 1000;

/** OAuth `state` documents older than this are rejected (CSRF window). */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/** Lifetime of a preview capability token handed to the generated app's iframe. */
export const PREVIEW_TOKEN_TTL_S = 15 * 60;
