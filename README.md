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

- **Provider-agnostic LLM layer.** One `LLMProvider.stream()` interface; Gemini adapter by default,
  Claude/OpenAI swappable via `LLM_PROVIDER`. Satisfies the spec's intent while running on the key we had.
- **Marker file protocol over JSON tool-use.** The model emits `<file path="…" op="…">…</file>` in a
  plain-text stream, parsed incrementally for live Monaco display + file-boundary SSE events, then
  validated with Zod. JSON structured output escapes file bodies (unreadable while streaming) and can
  lose partial output on truncation.
- **Fast incremental edits.** Small changes use `op="edit"` with `SEARCH/REPLACE` hunks (applied
  server-side, whitespace-tolerant) instead of re-emitting whole files — ~10× less output and much
  faster; full `op="write"` only for new files or large rewrites.
- **The generated app never holds the HL token.** It runs in a sandboxed `srcdoc` iframe (no
  `allow-same-origin`, so it can't touch the Firebase session) and calls a same-app proxy (`/hlProxy`)
  authenticated by a short-lived, single-location **preview capability token**; the proxy injects the
  real token server-side and enforces a strict **endpoint allowlist**.
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
- **Automatic continuation on interruption.** Generation keeps every completed `<file>` and resumes from
  a clean boundary on a mid-stream drop / `max_tokens` / RECITATION — partial results are always
  preserved in a snapshot with a clear message. (Discovered the local network resets Gemini streams at
  ~15s; deployed GCP functions don't.)
- **Emulators-first.** Everything developed against an offline `demo-genesis` project; secrets in Cloud
  Secret Manager, non-secret config in `.env`; the same code deploys unchanged.

## What I would improve

- **Durable generation jobs.** Today the SSE request *is* the job; make generation a background job so a
  dropped client can reconnect and resume, with a queue for concurrency.
- **Rate limiting + abuse controls** on the generation and proxy endpoints (per-user quotas, token
  budgets), and **verifying HL's webhook signature** on the `hlWebhook` receiver (today it accepts and
  stores; production should validate HL's RSA-signed payload and drop unrecognised locations).
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
