# ADR 0001 — File wire format: marker protocol over Gemini function calling

**Date:** 2026-07-21 · **Status:** Accepted (revisit when Google ships argument
streaming on the developer API)

## Context

Genesis streams generated apps file-by-file into a live editor. Two wire
formats were considered for how the model returns files:

1. **Marker protocol** (current): the model writes
   `<file path="…" op="…">…</file>` blocks in plain text; a streaming parser
   (`generate/markerParser.ts`) extracts prose and files incrementally.
2. **Function calling**: declare `write_file(path, content)` etc.; the model
   emits structured calls — no parsing, JSON escaping for free.

The deciding factor is the live-typing UX: with the marker protocol, file
content streams character-by-character into Monaco.

## Investigation (verified live, 2026-07-21 — see `scripts/probe-fc-streaming.mjs`)

Tested against the real Gemini API with this project's standard API key:

- Plain function calling **works** on a standard key: prose arrives as text
  parts, each file as ONE COMPLETE `functionCall` part. Structured and
  collision-proof — but a file appears all at once (no intra-file streaming).
- Incremental argument streaming (`streamFunctionCallArguments`, which would
  restore live typing) is **not available on the developer API**:
  - `@google/genai` 2.11.0 and latest 2.13.0 both hard-reject the flag in
    API-key mode ("only supported in Gemini Enterprise Agent Platform mode").
  - Bypassing the SDK with raw REST (`v1beta` AND `v1alpha`): HTTP 200, but
    the flag is **silently ignored** — calls still arrive whole. So the
    restriction is server-side, not an SDK limitation.

## Decision

Keep the marker protocol. The parser carries the correctness burden, so it is
hardened and unit-tested (attribute drift, malformed-tag recovery,
chunk-boundary splits, double-consume regression); its one structural
limitation (a file containing the literal `</file>`) is documented as a
skipped test. Switching to function calling today would trade the product's
core live-streaming UX for robustness we have already achieved by testing.

## Consequences / revisit triggers

- The generation engine (`generate/engine.ts`) isolates the format behind an
  event callback, so a format swap is contained in the provider/parsing layer.
- Adopt function calling when EITHER: Google ships argument streaming on the
  developer API, OR the project moves to Vertex AI (where it exists today),
  OR live typing stops being a product requirement.
- A hybrid remains open: structured `edit_file` calls for edits only (edits
  never streamed visibly), enabling an error-feedback retry loop for failed
  hunks.
