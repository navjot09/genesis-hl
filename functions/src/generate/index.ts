/**
 * POST /generate — the streaming generation endpoint.
 *
 * Flow: verify Firebase user → verify project ownership → persist the user
 * message → assemble bounded context → stream the LLM, forwarding prose/file
 * events over SSE while an incremental parser accumulates file ops → validate
 * ALL ops → commit atomically (working files + immutable snapshot + assistant
 * message). Streaming is cosmetic; the source of truth is committed once, only
 * on a validated result. A truncated stream keeps every fully-closed file.
 */
import { onRequest } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../lib/admin.js';
import { AuthError, requireFirebaseUser } from '../lib/authn.js';
import { GEMINI_API_KEY, GEMINI_MODEL, GEMINI_MODEL_HEAVY, LLM_PROVIDER } from '../config.js';
import { startSse } from '../http/sse.js';
import { createProvider } from '../llm/index.js';
import { buildSystemPrompt } from './systemPrompt.js';
import { buildMessages, loadProjectContext } from './context.js';
import { MarkerParser } from './markerParser.js';
import { validateOps } from './fileOps.js';
import { commitGeneration } from './snapshots.js';
import { findMissingReferencedFiles, isTransient, sanitizeChatProse } from './heuristics.js';
import { checkRateLimit } from '../lib/rateLimit.js';

export const generate = onRequest(
  { cors: true, secrets: [GEMINI_API_KEY], timeoutSeconds: 600, memory: '512MiB', concurrency: 4 },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Use POST' });
      return;
    }

    let uid: string;
    try {
      ({ uid } = await requireFirebaseUser(req));
    } catch (err) {
      res.status(401).json({ error: err instanceof AuthError ? err.message : 'Unauthorized' });
      return;
    }

    const body = (req.body ?? {}) as {
      projectId?: unknown;
      prompt?: unknown;
      model?: unknown;
      messageId?: unknown;
    };
    const projectId = typeof body.projectId === 'string' ? body.projectId : '';
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    // Client-supplied idempotency key: a retried request must not duplicate the
    // user message in the chat log (which would also pollute future prompts).
    const messageId =
      typeof body.messageId === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(body.messageId)
        ? body.messageId
        : null;
    if (!projectId || !prompt) {
      res.status(400).json({ error: 'projectId and prompt are required' });
      return;
    }

    const ctx = await loadProjectContext(projectId);
    if (!ctx.exists || ctx.ownerUid !== uid) {
      res.status(403).json({ error: 'Project not found or not yours' });
      return;
    }

    // Cost control: generation drives LLM spend, so it is quota'd per user.
    const rl = await checkRateLimit(uid, 'generate', 20, 60 * 60 * 1000);
    if (!rl.allowed) {
      res.status(429).json({
        error: 'Generation limit reached (20/hour). Please try again later.',
        retryAfterSeconds: Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000)),
      });
      return;
    }

    // Persist the user message before streaming (authoritative chat log).
    // With a client messageId this is idempotent (set on a fixed doc id).
    const messagesCol = db.collection('projects').doc(projectId).collection('messages');
    const userMsg = { role: 'user', content: prompt, createdAt: FieldValue.serverTimestamp() };
    if (messageId) await messagesCol.doc(messageId).set(userMsg);
    else await messagesCol.add(userMsg);

    const sse = startSse(res, req);
    // NOTE: a client disconnect does NOT abort generation. The SSE stream is a
    // best-effort live view; the source of truth is the Firestore commit. On
    // networks that reset long-lived streams, the server finishes and commits,
    // and the client recovers the result by watching currentSnapshotId. Token
    // cost of finishing an abandoned run is bounded and accepted — it keeps the
    // "your work is never lost" promise true by construction.

    let assistantText = '';
    // Keep ONLY the first attempt's intro prose. Continuations (after a network
    // reset) each re-emit their own intro; concatenating them produces a jumbled
    // chat message, so we stop capturing prose once we resume.
    let captureProse = true;
    const parser = new MarkerParser((e) => {
      if (sse.closed) return;
      switch (e.type) {
        case 'prose':
          if (captureProse) {
            assistantText += e.text;
            sse.send('assistant_delta', { text: e.text });
          }
          break;
        case 'file_open':
          sse.send('file_open', { path: e.path, op: e.op });
          break;
        case 'file_delta':
          sse.send('file_delta', { path: e.path, text: e.text });
          break;
        case 'file_close':
          sse.send('file_close', { path: e.path });
          break;
      }
    });

    const provider = createProvider({
      provider: LLM_PROVIDER.value(),
      apiKey: GEMINI_API_KEY.value(),
      model: GEMINI_MODEL.value(),
    });
    const model = body.model === 'heavy' ? GEMINI_MODEL_HEAVY.value() : GEMINI_MODEL.value();
    const system = buildSystemPrompt();
    const baseMessages = buildMessages(ctx.files, ctx.history, prompt);

    // Stream with automatic continuation: a mid-stream connection drop (common
    // on some networks) or a max_tokens cut is resumed from the last completed
    // <file> boundary, so long multi-file generations finish reliably.
    const MAX_CONTINUATIONS = 6;
    let result: Awaited<ReturnType<typeof provider.stream>> | undefined;
    let rawSoFar = '';
    let messages = baseMessages;

    for (let attempt = 0; ; attempt++) {
      try {
        result = await provider.stream(
          { system, messages, model, maxOutputTokens: 32000 },
          (delta) => {
            rawSoFar += delta;
            parser.feed(delta);
          },
        );
      } catch (err) {
        logger.error('LLM stream threw', { err: String(err) });
        result = { text: rawSoFar, stopReason: 'error', detail: String(err) };
      }

      if (result.stopReason === 'aborted') break;

      // Decide whether to resume, and why (drives the continuation instruction).
      let resumeReason: string | null = null;
      if (result.stopReason === 'max_tokens') {
        resumeReason = 'It stopped at the length limit.';
      } else if (result.stopReason === 'error' && isTransient(result.detail)) {
        resumeReason = 'The connection dropped.';
      } else if (result.stopReason === 'blocked') {
        // RECITATION/OTHER are non-deterministic content flags — regenerating the
        // remaining files usually clears them. Genuine safety blocks are not retried.
        const d = (result.detail ?? '').toUpperCase();
        if (d.includes('RECITATION') || d.includes('OTHER')) resumeReason = 'The response was flagged; continue.';
      } else if (result.stopReason === 'stop') {
        // Clean finish — but did it reference local files it forgot to output?
        const missing = findMissingReferencedFiles(parser.files);
        if (missing.length) resumeReason = `index.html references files you did not include: ${missing.join(', ')}.`;
      }
      if (!resumeReason || attempt >= MAX_CONTINUATIONS) break;

      // Resume: drop the interrupted file, keep completed ones, ask for the rest.
      // Stop capturing prose so continuation intros don't pile into the chat message.
      captureProse = false;
      parser.resetInProgress();
      const done = parser.completedPaths();
      // CRITICAL: build the continuation context from the parser's CLEAN completed
      // files only — NEVER the raw partial stream. `rawSoFar` concatenates orphaned
      // half-written blocks across retries, which makes the model continue mid-content;
      // that continuation arrives without a recognizable <file> marker and leaks into
      // prose. Reconstructed complete blocks guarantee the model resumes cleanly.
      const completedBlocks = parser.files
        .map((f) =>
          f.op === 'delete'
            ? `<file path="${f.path}" op="delete"></file>`
            : `<file path="${f.path}">\n${f.content}\n</file>`,
        )
        .join('\n\n');
      const resumeInstruction =
        `${resumeReason} The complete files above are already saved${done.length ? ` (${done.join(', ')})` : ''}. ` +
        `Now output the REMAINING/missing files as complete <file path="...">...</file> blocks. ` +
        `Start any unfinished file OVER as a fresh complete block — do NOT continue mid-file. ` +
        `Do NOT repeat a file shown above. No prose, no markdown fences.`;
      messages = done.length
        ? [...baseMessages, { role: 'assistant', content: completedBlocks }, { role: 'user', content: resumeInstruction }]
        : baseMessages;
    }
    parser.end();
    if (!result) result = { text: rawSoFar, stopReason: 'error', detail: 'no result' };


    // Validate everything the parser fully closed before touching Firestore.
    // (An interrupted stream still yields every completed <file> block.)
    const { ops, errors } = validateOps(parser.files);
    const streamFailed = result.stopReason === 'error' || result.stopReason === 'blocked';

    if (ops.length === 0) {
      const message = streamFailed
        ? `Generation ${result.stopReason === 'blocked' ? 'was blocked' : 'failed'}: ${result.detail ?? 'unknown'}`
        : errors.length
          ? errors.join('; ')
          : 'The model produced no files';
      sse.send('error', {
        stage: streamFailed ? 'stream' : 'validation',
        message,
        detail: result.detail,
      });
      sse.end();
      return;
    }

    // The chat message is prose only — strip any file content that leaked in.
    const chatText = sanitizeChatProse(assistantText);

    // We have at least one valid, fully-closed file → commit it (partial or full).
    try {
      const commit = await commitGeneration({
        projectId,
        prompt,
        assistantText: chatText || `Updated ${ops.length} file(s).`,
        ops,
        currentFiles: ctx.files,
        parentSnapshotId: ctx.currentSnapshotId,
      });
      sse.send('snapshot', {
        snapshotId: commit.snapshotId,
        fileCount: commit.fileCount,
        files: ops.map((o) => ({ path: o.path, op: o.op })),
      });
      const allWarnings = [...errors, ...commit.warnings];
      if (streamFailed) {
        // Partial success: the snapshot is saved, but tell the user it was cut short.
        sse.send('error', {
          stage: 'stream',
          partial: true,
          message: `Stream ended early (${result.stopReason}); saved ${ops.length} completed file(s). You can ask me to continue.`,
          detail: result.detail,
        });
      } else {
        sse.send('done', {
          stopReason: result.stopReason,
          truncated: result.stopReason === 'max_tokens',
          usage: result.usage,
          warnings: allWarnings,
        });
      }
    } catch (err) {
      logger.error('Commit failed', { err: String(err) });
      sse.send('error', { stage: 'commit', message: 'Failed to save generation', detail: String(err) });
    }
    sse.end();
  },
);
