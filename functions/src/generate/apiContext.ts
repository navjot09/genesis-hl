/**
 * HighLevel API reference injected into the generation system prompt.
 *
 * Describes ONLY the endpoints the Genesis proxy allowlists, and how the
 * generated app must call them (through the proxy, never HighLevel directly,
 * never sending locationId — the proxy injects it).
 */
export const HL_API_CONTEXT = `## Calling HighLevel data (VERY IMPORTANT)

The generated app runs in a sandboxed preview and MUST NOT call HighLevel directly
(CORS + security). Instead it calls the **Genesis proxy**, which injects the user's
auth token and location server-side. The preview runtime provides a global:

    window.__GENESIS__ = { proxyUrl: string, token: string }

Make every data request like this (note: DO NOT send locationId — the proxy adds it):

    const { proxyUrl, token } = window.__GENESIS__;
    const res = await fetch(proxyUrl + '/contacts/search', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ pageLimit: 20 }),
    });
    const data = await res.json(); // { contacts: [...], total: number }

Always handle loading, empty, and error states. If window.__GENESIS__ is undefined
(app opened outside the preview), show a friendly "Connect HighLevel in Genesis" message.

## Realtime HighLevel events (optional — use when the app should react live)

The runtime also provides \`window.__GENESIS__.onWebhook(handler)\` — a live feed of
HighLevel webhook events for this location (e.g. a contact created, an inbound
message, an appointment booked). Use it to auto-refresh a list or show a toast
when something happens, instead of only loading data once.

    const G = window.__GENESIS__;
    if (G && G.onWebhook) {
      const unsubscribe = G.onWebhook((event) => {
        // event = { type: string, data: object, receivedAt: ISO string }
        if (event.type === 'ContactCreate') {
          reloadContacts();           // e.g. re-run your /contacts/search
        }
      });
      // call unsubscribe() on teardown if you need to stop listening
    }

Common event \`type\` values: "ContactCreate", "ContactUpdate", "ContactDelete",
"InboundMessage", "OutboundMessage", "AppointmentCreate", "AppointmentUpdate".
\`event.data\` is the raw HighLevel payload for that event. Always feature-detect
\`G.onWebhook\` (it's only present when HighLevel is connected).

## Allowlisted endpoints (these are the ONLY ones available through the proxy)

CONTACTS
- POST /contacts/search   body: { pageLimit?: number(≤100), page?: number, query?: string }
    -> { contacts: [{ id, firstName, lastName, contactName, email, phone, tags, dateAdded, ... }], total }
- GET  /contacts/{id}     -> { contact: {...} }
- POST /contacts/         body: { firstName, lastName, email, phone, ... }  -> { contact }   (create)
- PUT  /contacts/{id}     body: { firstName?, ... }  -> { contact }   (update)

CONVERSATIONS
- GET  /conversations/search  -> { conversations: [{ id, contactId, contactName, fullName, email, phone,
      lastMessageBody, lastMessageType, lastMessageDirection, unreadCount, type }], total }
- GET  /conversations/{id}    -> a FLAT conversation object: { id, contactId, locationId, lastMessageBody,
      lastMessageType, unreadCount, ... } (no wrapper key)
- GET  /conversations/{id}/messages  query: { limit? }
      -> { messages: { messages: [{ id, body, direction, messageType (e.g. "TYPE_SMS"), dateAdded (ISO), status,
           contactId }], nextPage, lastMessageId } }
      ⚠️ IMPORTANT: the messages array is NESTED. Read \`data.messages.messages\` (an array) — NOT \`data.messages\`
      (which is an object). Always guard: \`(data.messages?.messages || [])\`.
- POST /conversations/messages  body: { type: 'SMS'|'Email', contactId, message, subject? } -> { conversationId, messageId }

CALENDARS
- GET  /calendars/                     -> { calendars: [{ id, name, description, isActive }] }
- GET  /calendars/events               query: { startTime: epochMillis(string), endTime: epochMillis(string), calendarId }  -> { events: [{ id, title, startTime(ISO), endTime(ISO), contactId, appointmentStatus }] }
- GET  /calendars/{calendarId}/free-slots  query: { startDate: epochMillis, endDate: epochMillis }  -> date-keyed map { "YYYY-MM-DD": { slots: ["ISO", ...] } }

Notes:
- To list appointments you must first GET /calendars/ to get a calendarId, then call
  /calendars/events with startTime/endTime as epoch-millisecond STRINGS and that calendarId.
- All times returned in event/slot bodies are ISO-8601 strings.
- Never include locationId in any request; the proxy injects it and rejects mismatches.`;
