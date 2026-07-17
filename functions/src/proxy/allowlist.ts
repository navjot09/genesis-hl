/**
 * Endpoint allowlist for the HL proxy.
 *
 * The proxy's callers include LLM-GENERATED (untrusted) code, so this is a
 * strict allowlist of exactly the read/demo-write surface Genesis supports —
 * NOT a pass-through. Anything else (deletes, bulk ops, settings, other
 * modules) is rejected before a token is ever attached.
 *
 * `locationId` records where HighLevel expects the location for each endpoint
 * ('query' | 'body') or 'none' where HL derives it / rejects it (e.g. contact
 * update). The proxy injects it from the caller's token accordingly — callers
 * never choose their own location.
 */

export type LocationPlacement = 'query' | 'body' | 'none';

export interface AllowRule {
  method: string;
  pattern: RegExp;
  locationId: LocationPlacement;
}

const ID = '[A-Za-z0-9_-]+';

const RULES: AllowRule[] = [
  // Contacts (Version 2021-07-28)
  { method: 'POST', pattern: new RegExp(`^/contacts/search$`), locationId: 'body' },
  { method: 'GET', pattern: new RegExp(`^/contacts/${ID}$`), locationId: 'none' },
  { method: 'POST', pattern: new RegExp(`^/contacts/?$`), locationId: 'body' }, // create
  { method: 'PUT', pattern: new RegExp(`^/contacts/${ID}$`), locationId: 'none' }, // update — HL rejects locationId in body

  // Conversations (Version 2021-04-15)
  { method: 'GET', pattern: new RegExp(`^/conversations/search$`), locationId: 'query' },
  { method: 'GET', pattern: new RegExp(`^/conversations/${ID}$`), locationId: 'none' },
  { method: 'GET', pattern: new RegExp(`^/conversations/${ID}/messages$`), locationId: 'none' },
  { method: 'POST', pattern: new RegExp(`^/conversations/messages$`), locationId: 'none' }, // send — location derived from token

  // Calendars (Version 2021-04-15)
  { method: 'GET', pattern: new RegExp(`^/calendars/?$`), locationId: 'query' },
  { method: 'GET', pattern: new RegExp(`^/calendars/events$`), locationId: 'query' },
  { method: 'GET', pattern: new RegExp(`^/calendars/${ID}/free-slots$`), locationId: 'none' },
];

/** Return the matching rule, or null if the endpoint is not allowlisted. */
export function matchRule(method: string, path: string): AllowRule | null {
  const m = method.toUpperCase();
  return RULES.find((r) => r.method === m && r.pattern.test(path)) ?? null;
}
