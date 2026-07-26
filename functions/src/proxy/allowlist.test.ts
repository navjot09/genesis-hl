import { describe, it, expect } from 'vitest';
import { matchRule } from './allowlist.js';

const CONTACT_ID = 'ocQHyuzHvysMo5N5VsXc';
const CONVO_ID = 'tDtDnQdgm2LXpyiqYvZ6';
const CALENDAR_ID = 'CVokAlI8fgw4WYWoCtQz';

describe('matchRule: canonical allowlisted endpoints', () => {
  it('matches POST /contacts/search', () => {
    expect(matchRule('POST', '/contacts/search')).not.toBeNull();
  });

  it('matches GET /contacts/{id}', () => {
    expect(matchRule('GET', `/contacts/${CONTACT_ID}`)).not.toBeNull();
  });

  it('matches POST /contacts/ (create)', () => {
    expect(matchRule('POST', '/contacts/')).not.toBeNull();
  });

  it('matches PUT /contacts/{id} (update)', () => {
    expect(matchRule('PUT', `/contacts/${CONTACT_ID}`)).not.toBeNull();
  });

  it('matches GET /conversations/search', () => {
    expect(matchRule('GET', '/conversations/search')).not.toBeNull();
  });

  it('matches GET /conversations/{id}', () => {
    expect(matchRule('GET', `/conversations/${CONVO_ID}`)).not.toBeNull();
  });

  it('matches GET /conversations/{id}/messages', () => {
    expect(matchRule('GET', `/conversations/${CONVO_ID}/messages`)).not.toBeNull();
  });

  it('matches POST /conversations/messages (send)', () => {
    expect(matchRule('POST', '/conversations/messages')).not.toBeNull();
  });

  it('matches GET /calendars/', () => {
    expect(matchRule('GET', '/calendars/')).not.toBeNull();
  });

  it('matches GET /calendars/events', () => {
    expect(matchRule('GET', '/calendars/events')).not.toBeNull();
  });

  it('matches GET /calendars/{id}/free-slots', () => {
    expect(matchRule('GET', `/calendars/${CALENDAR_ID}/free-slots`)).not.toBeNull();
  });

  it('accepts a lowercase method string (normalizes to uppercase)', () => {
    expect(matchRule('post', '/contacts/search')).not.toBeNull();
  });
});

describe('matchRule: unlisted paths return null', () => {
  it('rejects GET /locations', () => {
    expect(matchRule('GET', '/locations')).toBeNull();
  });

  it('rejects GET /oauth/token', () => {
    expect(matchRule('GET', '/oauth/token')).toBeNull();
  });

  it('rejects GET /some/random/endpoint', () => {
    expect(matchRule('GET', '/some/random/endpoint')).toBeNull();
  });

  it('rejects GET /users/me', () => {
    expect(matchRule('GET', '/users/me')).toBeNull();
  });
});

describe('matchRule: method mismatch returns null', () => {
  it('rejects DELETE /contacts/x (no DELETE rules exist)', () => {
    expect(matchRule('DELETE', '/contacts/x')).toBeNull();
  });

  it('rejects PUT /contacts/search (search is a literal segment, not a contact id)', () => {
    expect(matchRule('PUT', '/contacts/search')).toBeNull();
  });

  it('rejects DELETE /conversations/messages', () => {
    expect(matchRule('DELETE', '/conversations/messages')).toBeNull();
  });
});

describe('matchRule: path traversal does not bypass the allowlist', () => {
  it('rejects GET /contacts/../locations (dots not allowed in id segment)', () => {
    expect(matchRule('GET', '/contacts/../locations')).toBeNull();
  });

  it('rejects GET /contacts/.. outright', () => {
    expect(matchRule('GET', '/contacts/..')).toBeNull();
  });

  it('rejects GET /contacts/%2e%2e/locations (encoded traversal, % not in id charset)', () => {
    expect(matchRule('GET', '/contacts/%2e%2e/locations')).toBeNull();
  });

  it('rejects POST /contacts/search/../../oauth (search rule is $-anchored)', () => {
    expect(matchRule('POST', '/contacts/search/../../oauth')).toBeNull();
  });
});

describe('matchRule: locationId placement per rule', () => {
  it('POST /contacts/search injects location in body', () => {
    expect(matchRule('POST', '/contacts/search')?.locationId).toBe('body');
  });

  it('POST /contacts/ (create) injects location in body', () => {
    expect(matchRule('POST', '/contacts/')?.locationId).toBe('body');
  });

  it('GET /contacts/{id} has no location injection', () => {
    expect(matchRule('GET', `/contacts/${CONTACT_ID}`)?.locationId).toBe('none');
  });

  it('PUT /contacts/{id} has no location injection (HL rejects locationId in body)', () => {
    expect(matchRule('PUT', `/contacts/${CONTACT_ID}`)?.locationId).toBe('none');
  });

  it('GET /conversations/search injects location in query (search rule wins over {id} rule)', () => {
    expect(matchRule('GET', '/conversations/search')?.locationId).toBe('query');
  });

  it('POST /conversations/messages has no location injection (derived from token)', () => {
    expect(matchRule('POST', '/conversations/messages')?.locationId).toBe('none');
  });

  it('GET /calendars/ injects location in query', () => {
    expect(matchRule('GET', '/calendars/')?.locationId).toBe('query');
  });

  it('GET /calendars/{id}/free-slots has no location injection', () => {
    expect(matchRule('GET', `/calendars/${CALENDAR_ID}/free-slots`)?.locationId).toBe('none');
  });
});

describe('matchRule: trailing-slash and case variants (documented actual behavior)', () => {
  it('rejects POST /contacts/search/ (trailing slash only optional on create/list rules)', () => {
    expect(matchRule('POST', '/contacts/search/')).toBeNull();
  });

  it('accepts POST /contacts without trailing slash (create rule slash is optional)', () => {
    expect(matchRule('POST', '/contacts')).not.toBeNull();
  });

  it('accepts GET /calendars without trailing slash (list rule slash is optional)', () => {
    expect(matchRule('GET', '/calendars')).not.toBeNull();
  });

  it('rejects GET /conversations/{id}/messages/ with trailing slash', () => {
    expect(matchRule('GET', `/conversations/${CONVO_ID}/messages/`)).toBeNull();
  });

  it('rejects path case variant /Contacts/search (patterns are case-sensitive)', () => {
    expect(matchRule('POST', '/Contacts/search')).toBeNull();
  });

  it('rejects path case variant /CALENDARS (patterns are case-sensitive)', () => {
    expect(matchRule('GET', '/CALENDARS')).toBeNull();
  });
});
