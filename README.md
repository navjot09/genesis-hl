# Genesis — AI-Powered HighLevel App Builder

Genesis is a Lovable/Bolt-style AI app builder specialized for **HighLevel marketplace apps**.
A user signs in, connects their HighLevel account via OAuth, creates a project, and describes an app
in chat. An LLM streams a working app to the browser in real time; the generated code calls **real
HighLevel APIs** (Contacts, Conversations, Calendars) through a secure backend proxy, renders live in
a sandboxed preview, and every generation is captured as a restorable snapshot.

- **Frontend:** Vue 3 + TypeScript + ShadCN (shadcn-vue) + Vite + Monaco
- **Backend:** Firebase — Auth + Firestore + **2nd-gen Cloud Functions**
- **LLM:** Google Gemini (`@google/genai`), streamed over SSE, behind a provider-agnostic interface
- **Preview:** sandboxed `srcdoc` iframe rendering the generated app with real HL data via the proxy

---

## Live URLs

- **App (Firebase Hosting):** https://genesis-hl.web.app
- **Cloud Functions base URL:** https://us-central1-genesis-hl.cloudfunctions.net
- **Loom walkthrough (≤5 min):** https://www.loom.com/share/68387436a6634e7ba6aae01dcacc4198

> ⚠️ **Note on the LLM provider.** The brief lists Claude or OpenAI. Genesis runs on **Gemini**
> (the API key that was available) behind a provider-neutral `LLMProvider.stream()` interface.
> Honest scope: adding Claude/OpenAI means implementing that interface **plus** declaring the new
> secret and binding it on the endpoint (Firebase requires static secret declarations) — a small,
> localized change, but not a config-only toggle.

---

## HighLevel setup

1. Create a developer account at **developers.gohighlevel.com**.
2. Create a **marketplace app**: distribution **Sub-account**, visibility **Private** while building.
   Copy the **Client ID** and **Client Secret** (App → Advanced Settings → Auth). **Make the app version
   Live** — a draft app returns "No integration found" during install.
3. Enable the scopes Genesis requests (only these — enabling extras it doesn't request also works, but
   requesting a scope the app *doesn't* have fails the consent):
   `contacts.readonly` `contacts.write` `conversations.readonly` `conversations/message.readonly`
   `conversations/message.write` `calendars.readonly` `calendars/events.readonly`
4. Register the **OAuth Redirect URL** (must match exactly, both are fine to keep):
   - Production: `https://us-central1-genesis-hl.cloudfunctions.net/oauthCallback`
   - Local (emulator): `http://127.0.0.1:5001/demo-genesis/us-central1/oauthCallback`
5. Create a **sandbox test account** (Developer Portal → Testing → Create App Test Account), add a
   **sub-account/location** to it, and seed a few contacts / a conversation / a calendar so the preview
   has real data.
6. **(Optional) Webhooks** — to let generated apps react to live events, register the webhook URL and
   subscribe to events in the marketplace app:
   - Webhook URL: `https://us-central1-genesis-hl.cloudfunctions.net/hlWebhook`
   - Subscribe to e.g. `ContactCreate`, `ContactUpdate`, `InboundMessage`, `AppointmentCreate`.
   HL POSTs each event here; the generated app receives it in the preview via
   `window.__GENESIS__.onWebhook(handler)` (see [Architecture decisions](#architecture-decisions)).

**API notes worth knowing** (all discovered against live HL, baked into the generation prompt):
- Base host `services.leadconnectorhq.com`. **`Version` header differs per module** — Contacts
  `2021-07-28`, Conversations & Calendars `2021-04-15`.
- The `/conversations/{id}/messages` response nests the array: read `data.messages.messages`.
- Refresh tokens are **single-use and rotate** on every refresh.

## Local setup (Firebase emulators)

Runs fully offline against a `demo-genesis` emulator project — no cloud project needed.

```bash
# 1. Install
npm --prefix functions install
npm --prefix frontend install

# 2. Env (see .env.example for every variable)
cp .env.example functions/.env          # non-secret config
#   put GEMINI_API_KEY / HL_CLIENT_SECRET / PREVIEW_TOKEN_SECRET in functions/.secret.local
cp .env.example frontend/.env.local     # VITE_* values

# 3. Emulators (Auth + Firestore + Functions). Requires Java 21+ for Firestore.
firebase emulators:start --only auth,firestore,functions --project demo-genesis
#   -> Emulator UI: http://127.0.0.1:4000

# 4. Frontend dev server (in another terminal)
npm --prefix frontend run dev           # -> http://localhost:5173
```

For real HL OAuth locally, register the emulator callback URL (step 4 above) in your HL app, or expose
it over HTTPS with a tunnel. The mock HL server (`scripts/mock-hl.mjs`) lets you exercise OAuth +
proxy + rotating-token refresh offline — point `HL_API_BASE`/`HL_AUTHORIZE_BASE` at it.

---

## Architecture decisions

- **Provider-neutral LLM seam.** The pipeline depends only on `LLMProvider.stream()`; the Gemini
  adapter fully encapsulates the SDK. Adding Claude/OpenAI = implement the interface + declare its
  secret on the endpoint (see the provider note above for honest scope).
- **Marker file protocol (with eyes open).** The model emits `<file path="…" op="…">…</file>` in a
  plain-text stream, parsed incrementally (unit-tested: attribute drift, malformed-tag recovery,
  chunk-boundary splits) then validated with Zod. Known trade-off: text markers carry the full
  correctness burden and cannot escape their own delimiter — Gemini's newer streamed function calling
  (`streamFunctionCallArguments`) removes that class entirely and is the planned migration (see
  "What I would improve").
- **Fast incremental edits.** Small changes use `op="edit"` with `SEARCH/REPLACE` hunks instead of
  re-emitting whole files — ~10× less output. Hunks apply **strictly**: matches are line-anchored and
  must be unique, so an ambiguous edit fails loudly (surfaced as a warning) rather than silently
  patching the wrong place.
- **The generated app never holds the HL token.** It runs in a sandboxed `srcdoc` iframe (no
  `allow-same-origin`) with a **strict CSP** — network egress is locked to the Genesis proxy origin,
  so even malicious generated JS cannot exfiltrate its token. It calls the proxy (`/hlProxy`) with a
  short-lived, single-location **preview capability token**; the proxy injects the real HL token
  server-side, enforces a strict **endpoint allowlist**, and **rate-limits side-effecting calls**
  (message sends / contact writes) so a bad generation can't spam real customers.
- **2nd-gen Cloud Functions for true SSE.** Streamed directly (not via Hosting rewrites, which buffer),
  raised `timeoutSeconds`, heartbeats. The client consumes it with `fetch` + `ReadableStream` (not
  `EventSource`, which can't send the Firebase auth header).
- **OAuth account-linking CSRF defense.** `oauthCallback` doesn't exchange/link — it bounces `code`+`state`
  to the SPA; a separate authenticated `hlOauthComplete` requires `state.uid === currentUid` **and**
  possession of the code, so a flow started in one session can't be completed in another.
- **Rotating refresh tokens.** HL refresh tokens are single-use; a concurrent double-refresh permanently
  breaks the grant. Refresh is proactive and serialized behind a **per-location Firestore-transaction lock**,
  always persisting the rotated token.
- **Immutable snapshots + mutable working set.** Firestore's 1MB/doc limit means files are one-doc-each
  under `projects/{id}/snapshots/{sid}/files/{fid}`. Snapshots are immutable; **restore is append-only**
  (a new snapshot), so the timeline never branches and restores are themselves undoable.
- **Live HL webhooks, without exposing the database to the preview.** A public `hlWebhook` receiver
  stores each HighLevel event under `webhookEvents/{locationId}`; the generated app reads them through
  the *same* proxy + capability token it already uses (a Genesis-internal `/__events` route, not
  forwarded to HL). The injected runtime exposes `window.__GENESIS__.onWebhook(handler)` — the polling
  loop lives in the bridge, so generated code just registers a handler and the sandboxed iframe never
  touches Firestore directly. (Signature verification of HL's payload is the next hardening step.)
- **Generation survives client disconnects by design.** The SSE stream is a cosmetic live view; the
  server intentionally keeps generating and **commits transactionally** even if the browser drops the
  connection (some networks reset long-lived streams). The client then recovers the result by watching
  the project's snapshot pointer. Upstream interruptions (`max_tokens`, RECITATION, provider resets)
  auto-continue from the last completed file boundary.
- **Emulators-first.** Everything developed against an offline `demo-genesis` project; secrets in Cloud
  Secret Manager, non-secret config in `.env`; the same code deploys unchanged.

## Testing & CI

- **78 unit tests** (vitest) over the correctness-critical pure logic: the streaming marker parser
  (chunk-boundary splits, attribute drift, malformed-tag recovery), the search/replace edit applier
  (line anchoring, uniqueness, whitespace tolerance), the proxy allowlist (traversal, method/paths,
  reserved literals), and the prose heuristics. One `it.skip` documents the known `</file>`-in-content
  limitation the function-calling migration removes.
- **GitHub Actions CI** on every push/PR: ESLint (flat config, Vue + TS) → typecheck → unit tests →
  frontend typecheck + build.
- `npm test` (root) runs the suite; `npm run lint` / `npm run format` cover style.

```bash
npm --prefix functions run test   # unit tests
npm run lint                      # eslint over functions/src + frontend/src
```

## What I would improve

- **Durable generation jobs.** Today the SSE request *is* the job; make generation a background job so a
  dropped client can reconnect and resume, with a queue for concurrency.
- **Migrate the wire format to Gemini's streamed function calling** (`streamFunctionCallArguments`)
  — structured file ops with JSON escaping and per-field streaming would delete the marker parser,
  the prose sanitizer, and the delimiter-collision class entirely, and enable error-feedback retry
  loops for failed edits.
- **Verify HL's webhook signature** on `hlWebhook` (today: known-location gate + ingest rate cap;
  production should validate HL's RSA-signed payload), and add **App Check + email verification** in
  front of the auth surface.
- **Richer, versioned HL API context** for the model (dynamic per-request scoping and a larger, tested
  reference) instead of a curated static prompt — reduces shape-mismatch bugs like the nested messages one.
- **Hardening:** encrypt HL tokens at rest (KMS), a scheduled proactive token-refresh cron, a strict CSP,
  and self-hosting the preview so it never depends on any third-party bundler.
- **Multi-location + collaboration:** support more than one connected HL location per user, and
  real-time multiplayer editing of a project.

## Deployment notes

- **Project:** Firebase `genesis-hl`, **Blaze plan** (required for 2nd-gen functions + outbound calls),
  region **us-central1**, Firestore in a US region.
- **Secrets** live in Cloud Secret Manager (never in source):
  ```bash
  firebase functions:secrets:set GEMINI_API_KEY
  firebase functions:secrets:set HL_CLIENT_SECRET
  firebase functions:secrets:set PREVIEW_TOKEN_SECRET   # openssl rand -hex 32
  ```
- **Non-secret config:** `functions/.env` (base) + `functions/.env.genesis-hl` (prod overrides —
  deployed callback URL + app origin). Frontend prod config in `frontend/.env.production`.
- **Deploy:**
  ```bash
  npm --prefix frontend run build
  firebase deploy --project genesis-hl        # functions + hosting + firestore rules/indexes
  ```
- **Manual step:** after the first deploy, register the printed `…/oauthCallback` URL in the HL
  marketplace app's Redirect URLs.
- No CI/CD wired up; deploys are run from the CLI.

---

## Repository layout

```
/functions          Firebase Cloud Functions (TypeScript, ESM)
  src/oauth/         OAuth start + callback + authenticated complete (CSRF-safe)
  src/hl/            token store (locked rotating refresh) + HL client + API constants
  src/proxy/         preview capability tokens + endpoint allowlist + /hlProxy + /__events feed
  src/webhooks/      hlWebhook receiver — stores HL events per location for generated apps
  src/generate/      SSE endpoint, marker parser, Zod validation, snapshots, edit apply, diffs, restore
  src/llm/           provider-agnostic interface + Gemini adapter
/frontend           Vue 3 + ShadCN SPA (3-panel: chat | Monaco editor | live preview)
scripts/            test harnesses (test-*.sh) + mock HighLevel server (mock-hl.mjs)
firebase.json  .firebaserc  firestore.rules  firestore.indexes.json  .env.example
```
```bash
# Reproduce the key end-to-end tests against the emulator + mock HL:
bash scripts/test-day2.sh     # OAuth + rotating refresh + allowlisted proxy
bash scripts/test-day3.sh     # generation: stream -> files -> snapshot
bash scripts/test-restore.sh  # snapshot restore
```
