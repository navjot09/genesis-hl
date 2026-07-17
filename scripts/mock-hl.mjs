#!/usr/bin/env node
/**
 * Mock HighLevel server for local development & integration tests.
 *
 * Emulates exactly the HL surface Genesis touches: the OAuth token endpoint
 * (with SINGLE-USE ROTATING refresh tokens, like real HL) and a few API
 * endpoints that strictly verify the Authorization + per-module Version
 * headers. Point the functions at it with:
 *
 *   HL_API_BASE=http://127.0.0.1:8788
 *   HL_AUTHORIZE_BASE=http://127.0.0.1:8788
 *
 * GET /__state exposes internal counters for test assertions.
 */
import http from 'node:http';

const PORT = process.env.MOCK_HL_PORT ? Number(process.env.MOCK_HL_PORT) : 8788;
const LOCATION_ID = 'loc_mock_1';

// Rotating token state (mirrors real HL: refresh tokens are single-use).
let serial = 1;
let currentAccess = 'at-1';
let currentRefresh = 'rt-1';
let refreshCount = 0;
let invalidGrantCount = 0;

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const readBody = (req) =>
  new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });

/** Verify Authorization + Version headers for API routes. */
function checkAuth(req, res, expectedVersion) {
  const auth = req.headers.authorization ?? '';
  if (auth !== `Bearer ${currentAccess}`) {
    json(res, 401, { error: 'invalid or expired access token', got: auth.slice(0, 24) });
    return false;
  }
  if (req.headers.version !== expectedVersion) {
    json(res, 422, { error: `wrong Version header: got "${req.headers.version}", want "${expectedVersion}"` });
    return false;
  }
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const path = url.pathname;

  // --- OAuth token endpoint (form-urlencoded, like real HL) ---
  if (req.method === 'POST' && path === '/oauth/token') {
    const raw = await readBody(req);
    const p = new URLSearchParams(raw);
    const grant = p.get('grant_type');

    if (grant === 'authorization_code') {
      if (p.get('code') !== 'goodcode') return json(res, 400, { error: 'invalid_code' });
      if (p.get('user_type') !== 'Location') return json(res, 400, { error: 'wrong user_type' });
      if (!p.get('client_id') || !p.get('client_secret') || !p.get('redirect_uri')) {
        return json(res, 400, { error: 'missing client params' });
      }
      return json(res, 200, {
        access_token: currentAccess,
        refresh_token: currentRefresh,
        expires_in: 86399,
        token_type: 'Bearer',
        locationId: LOCATION_ID,
        companyId: 'comp_mock',
        userType: 'Location',
        scope: 'contacts.readonly calendars.readonly conversations.readonly',
      });
    }

    if (grant === 'refresh_token') {
      if (p.get('refresh_token') !== currentRefresh) {
        invalidGrantCount++;
        return json(res, 400, { error: 'invalid_grant', detail: 'refresh token reused or unknown (single-use!)' });
      }
      serial++;
      currentAccess = `at-${serial}`;
      currentRefresh = `rt-${serial}`; // rotate: old refresh token is now dead
      refreshCount++;
      return json(res, 200, {
        access_token: currentAccess,
        refresh_token: currentRefresh,
        expires_in: 86399,
        token_type: 'Bearer',
        userType: 'Location',
        // note: no locationId on refresh — clients must keep the original
      });
    }

    return json(res, 400, { error: 'unsupported grant_type' });
  }

  // --- API endpoints (strict header checks) ---
  if (req.method === 'GET' && /^\/locations\/[\w-]+$/.test(path)) {
    if (!checkAuth(req, res, '2021-07-28')) return;
    return json(res, 200, { location: { id: path.split('/')[2], name: 'Mock Dental Co' } });
  }

  if (req.method === 'POST' && path === '/contacts/search') {
    if (!checkAuth(req, res, '2021-07-28')) return;
    const body = JSON.parse((await readBody(req)) || '{}');
    if (body.locationId !== LOCATION_ID) {
      return json(res, 422, { error: `locationId required in body, got ${body.locationId}` });
    }
    return json(res, 200, {
      contacts: [
        { id: 'c1', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@mock.dev' },
        { id: 'c2', firstName: 'Grace', lastName: 'Hopper', email: 'grace@mock.dev' },
      ],
      total: 2,
    });
  }

  if (req.method === 'GET' && (path === '/calendars/' || path === '/calendars')) {
    if (!checkAuth(req, res, '2021-04-15')) return;
    if (url.searchParams.get('locationId') !== LOCATION_ID) {
      return json(res, 422, { error: 'locationId query param required' });
    }
    return json(res, 200, { calendars: [{ id: 'cal1', name: 'Demo Calendar', locationId: LOCATION_ID }] });
  }

  if (req.method === 'GET' && path === '/conversations/search') {
    if (!checkAuth(req, res, '2021-04-15')) return;
    return json(res, 200, { conversations: [{ id: 'conv1', contactId: 'c1', lastMessageBody: 'hi' }], total: 1 });
  }

  // Anything else would be a proxy allowlist escape — record loudly.
  if (path === '/__state') {
    return json(res, 200, { refreshCount, invalidGrantCount, currentAccess, currentRefresh });
  }
  json(res, 418, { error: `mock-hl: unexpected ${req.method} ${path} — proxy allowlist should have blocked this` });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock-hl listening on http://127.0.0.1:${PORT}`);
});
