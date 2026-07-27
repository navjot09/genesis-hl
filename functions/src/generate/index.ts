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
import { z } from 'zod';
import { logger } from 'firebase-functions/v2';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../lib/admin.js';
import { AuthError, requireFirebaseUser } from '../lib/authn.js';
import { GEMINI_API_KEY, GEMINI_MODEL, GEMINI_MODEL_HEAVY, LLM_PROVIDER } from '../config.js';
import { startSse } from '../http/sse.js';
import { createProvider } from '../llm/index.js';
import { buildSystemPrompt } from './systemPrompt.js';
import { buildMessages, loadProjectContext } from './context.js';
import { commitGeneration } from './snapshots.js';
import { runGeneration } from './engine.js';
import { sanitizeChatProse } from './heuristics.js';
import { checkRateLimit } from '../lib/rateLimit.js';
import { AppError, sendError } from '../lib/errors.js';
import { LIMITS, RATE_WINDOWS } from '../config/limits.js';

const GenerateRequest = z.object({
  projectId: z.string().min(1),
  prompt: z.string().trim().min(1).max(4000),
  model: z.enum(['default', 'heavy']).optional(),
  // Idempotency key: retried requests must not duplicate the chat message.
  messageId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,64}$/)
    .optional(),
  // Client-chosen job id: lets the client watch generations/{id} for recovery
  // even if the SSE stream dies before any server response arrives.
  generationId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,64}$/)
    .optional(),
});

export const generate = onRequest(
  {
    cors: true,
    secrets: [GEMINI_API_KEY],
    timeoutSeconds: LIMITS.generateTimeoutSeconds,
    memory: '512MiB',
    concurrency: LIMITS.generateConcurrency,
  },
  async (req, res) => {
    let uid!: string;
    let projectId!: string;
    let prompt!: string;
    let wantHeavy = false;
    let generationId: string | null = null;
    let ctx!: Awaited<ReturnType<typeof loadProjectContext>>;

    // Everything before the stream starts speaks the typed error taxonomy;
    // sendError is the single place errors become HTTP responses.
    try {
      if (req.method !== 'POST') throw new AppError('BAD_REQUEST', 'Use POST');

      try {
        ({ uid } = await requireFirebaseUser(req));
      } catch (err) {
        throw new AppError('UNAUTHORIZED', err instanceof AuthError ? err.message : 'Sign in required');
      }

      const parsed = GenerateRequest.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new AppError('BAD_REQUEST', parsed.error.issues[0]?.message ?? 'Invalid request');
      }
      ({ projectId, prompt } = parsed.data);
      wantHeavy = parsed.data.model === 'heavy';
      generationId = parsed.data.generationId ?? null;
      const messageId = parsed.data.messageId ?? null;

      ctx = await loadProjectContext(projectId);
      // 404 (not 403) for unowned projects: don't confirm existence to non-owners.
      if (!ctx.exists || ctx.ownerUid !== uid) throw new AppError('NOT_FOUND', 'Project not found');

      // Cost control: generation drives LLM spend, so it is quota'd per user.
      const rl = await checkRateLimit(uid, 'generate', RATE_WINDOWS.generate.limit, RATE_WINDOWS.generate.windowMs);
      if (!rl.allowed) {
        throw new AppError(
          'RATE_LIMITED',
          `Generation limit reached (${RATE_WINDOWS.generate.limit}/hour). Please try again later.`,
          { retryAfterSeconds: Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000)) },
        );
      }

      // Persist the user message before streaming (authoritative chat log).
      // With a client messageId this is idempotent (set on a fixed doc id).
      const messagesCol = db.collection('projects').doc(projectId).collection('messages');
      const userMsg = { role: 'user', content: prompt, createdAt: FieldValue.serverTimestamp() };
      if (messageId) await messagesCol.doc(messageId).set(userMsg);
      else await messagesCol.add(userMsg);
    } catch (err) {
      sendError(res, err);
      return;
    }

    // --- Job record: generations/{id} tracks this run's lifecycle. ---------
    // Until now a generation only "existed" as an in-flight HTTP request; this
    // doc makes runs observable (what's streaming? what failed?) and gives
    // clients a durable signal, independent of the SSE connection.
    const jobRef = generationId
      ? db.collection('generations').doc(generationId)
      : db.collection('generations').doc();
    const jobUpdate = (fields: Record<string, unknown>): Promise<unknown> =>
      jobRef.set({ ...fields, updatedAt: FieldValue.serverTimestamp() }, { merge: true }).catch(() => {
        /* observability is best-effort — never fail a run over it */
      });
    await jobUpdate({
      status: 'streaming',
      uid,
      projectId,
      prompt: prompt.slice(0, 200),
      model: wantHeavy ? 'heavy' : 'default',
      startedAt: FieldValue.serverTimestamp(),
    });

    const sse = startSse(res, req);
    // NOTE: a client disconnect does NOT abort generation. The SSE stream is a
    // best-effort live view; the source of truth is the Firestore commit. On
    // networks that reset long-lived streams, the server finishes and commits,
    // and the client recovers the result by watching currentSnapshotId. Token
    // cost of finishing an abandoned run is bounded and accepted — it keeps the
    // "your work is never lost" promise true by construction.

    // The ENGINE does all model-facing work (stream → parse → resume →
    // validate) with no knowledge of HTTP/Firestore; this handler forwards its
    // progress events to the browser and persists the outcome. See engine.ts.
    const provider = createProvider({
      provider: LLM_PROVIDER.value(),
      apiKey: GEMINI_API_KEY.value(),
      model: GEMINI_MODEL.value(),
    });
    // Heartbeat: while streaming, touch the job's updatedAt at most every
    // jobHeartbeatMs. The client's drop-recovery and the stale-job sweeper both
    // read this as "the run is still alive".
    let lastBeat = Date.now();
    const outcome = await runGeneration(
      provider,
      {
        system: buildSystemPrompt(),
        baseMessages: buildMessages(ctx.files, ctx.history, prompt),
        model: wantHeavy ? GEMINI_MODEL_HEAVY.value() : GEMINI_MODEL.value(),
        maxOutputTokens: LIMITS.maxOutputTokens,
        maxContinuations: LIMITS.maxContinuations,
      },
      (event) => {
        if (!sse.closed) sse.send(event);
        if (Date.now() - lastBeat > LIMITS.jobHeartbeatMs) {
          lastBeat = Date.now();
          void jobUpdate({});
        }
      },
    );
    const { ops, validationErrors } = outcome;

    if (ops.length === 0) {
      const message = outcome.streamFailed
        ? `Generation ${outcome.stopReason === 'blocked' ? 'was blocked' : 'failed'}: ${outcome.detail ?? 'unknown'}`
: validationErrors.length
          ? validationErrors.join('; ')
          : 'The model produced no files';
      await jobUpdate({ status: 'failed', error: message, finishedAt: FieldValue.serverTimestamp() });
      sse.send({ type: 'error',
        stage: outcome.streamFailed ? 'stream' : 'validation',
        message,
        detail: outcome.detail,
      });
      sse.end();
      return;
    }

    // The chat message is prose only — strip any file content that leaked in.
    const chatText = sanitizeChatProse(outcome.assistantText, LIMITS.chatProseMaxChars);

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
      await jobUpdate({
        status: 'committed',
        snapshotId: commit.snapshotId,
        fileCount: commit.fileCount,
        finishedAt: FieldValue.serverTimestamp(),
      });
      sse.send({ type: 'snapshot',
        snapshotId: commit.snapshotId,
        fileCount: commit.fileCount,
        files: ops.map((o) => ({ path: o.path, op: o.op })),
      });
      const allWarnings = [...validationErrors, ...commit.warnings];
      if (outcome.streamFailed) {
        // Partial success: the snapshot is saved, but tell the user it was cut short.
        sse.send({ type: 'error',
          stage: 'stream',
          partial: true,
          message: `Stream ended early (${outcome.stopReason}); saved ${ops.length} completed file(s). You can ask me to continue.`,
          detail: outcome.detail,
        });
      } else {
        sse.send({ type: 'done',
          stopReason: outcome.stopReason,
          truncated: outcome.stopReason === 'max_tokens',
          usage: outcome.usage,
          warnings: allWarnings,
        });
      }
    } catch (err) {
      logger.error('Commit failed', { err: String(err) });
      await jobUpdate({ status: 'failed', error: 'commit failed', finishedAt: FieldValue.serverTimestamp() });
      sse.send({ type: 'error', stage: 'commit', message: 'Failed to save generation', detail: String(err) });
    }
    sse.end();
  },
);
