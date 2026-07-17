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
import { MarkerParser, type ParsedFile } from './markerParser.js';
import { validateOps } from './fileOps.js';
import { commitGeneration } from './snapshots.js';

/**
 * The chat message is intro PROSE only. If a reset/continuation caused any file
 * content to leak into the prose stream (e.g. a `css">` tag remnant or raw code
 * from a discarded attempt — the file itself is re-created cleanly by the
 * continuation), strip everything from the first leak signature onward so the
 * chat never shows stray code. A normal intro sentence matches none of these.
 */
function sanitizeChatProse(text: string): string {
  let s = text.trim();
  const signatures: RegExp[] = [
    /<\/?file[\s>]/, // <file ...> or </file>
    /\n[ \t]*\n[ \t]*\n/, // 3+ newlines: the intro is over — a leak usually follows
    /(^|\n)\s*\*[ /]/, // JSDoc / comment fragment:  " * foo"  or  " */"
    /(^|\n)\s*[A-Za-z]{1,6}">/, // tag remnant: css">  js">  html">
    /(^|\n)\s*\.?\/?[\w.\-/]*\.(js|css|html|json|ts|svg|mjs)"?\s*>/i, // filename remnant: styles.css">  ./app.js">
    /(^|\n)\s*<!DOCTYPE/i,
    /(^|\n)\s*<(html|head|body|div|section|main|script|style|nav|header|ul|form)\b/i,
    /(^|\n)\s*\/\*/, // CSS/JS block comment starting a line
    /(^|\n)\s*:root\b/,
    /(^|\n)\s*(const|let|var|function|import|export|async)\s/,
  ];
  let cut = s.length;
  for (const p of signatures) {
    const m = p.exec(s);
    if (m) cut = Math.min(cut, m.index === 0 ? 0 : m.index + (m[1] ? m[1].length : 0));
  }
  s = s.slice(0, cut).trim();
  if (s.length > 1500) s = s.slice(0, 1500).trim() + '…';
  return s;
}

/**
 * Local files referenced by an HTML file (script src / link href / img src)
 * that were NOT generated — indicates a broken app (e.g. index.html links
 * ./app.js but app.js is missing). Used to auto-continue and fill the gap.
 */
function findMissingReferencedFiles(files: ParsedFile[]): string[] {
  const present = new Set(files.filter((f) => f.op !== 'delete').map((f) => f.path));
  const referenced = new Set<string>();
  for (const f of files) {
    if (f.op === 'delete' || !/\.html?$/i.test(f.path)) continue;
    const re = /(?:src|href)\s*=\s*["']([^"']+)["']/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(f.content)) !== null) {
      let ref = m[1].trim();
      if (/^(https?:|data:|blob:|#|mailto:|tel:|\/\/)/i.test(ref)) continue; // external
      ref = ref.replace(/^\.?\//, '').split(/[?#]/)[0]; // normalise ./x, /x, strip query/hash
      if (ref && /\.(js|css)$/i.test(ref) && !present.has(ref)) referenced.add(ref);
    }
  }
  return [...referenced];
}

/** Whether a stream error looks like a transient/connection failure worth resuming. */
function isTransient(detail?: string): boolean {
  if (!detail) return true; // unknown mid-stream failure → assume resumable
  const d = detail.toLowerCase();
  return [
    'terminated',
    'econnreset',
    'reset',
    'fetch failed',
    'network',
    'socket',
    'timeout',
    'enotfound',
    'eai_again',
    'unavailable',
    'overloaded',
    '503',
    '502',
    '500',
  ].some((s) => d.includes(s));
}

export const generate = onRequest(
  { cors: true, secrets: [GEMINI_API_KEY], timeoutSeconds: 3600, memory: '512MiB' },
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

    const body = (req.body ?? {}) as { projectId?: unknown; prompt?: unknown; model?: unknown };
    const projectId = typeof body.projectId === 'string' ? body.projectId : '';
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!projectId || !prompt) {
      res.status(400).json({ error: 'projectId and prompt are required' });
      return;
    }

    const ctx = await loadProjectContext(projectId);
    if (!ctx.exists || ctx.ownerUid !== uid) {
      res.status(403).json({ error: 'Project not found or not yours' });
      return;
    }

    // Persist the user message before streaming (authoritative chat log).
    await db
      .collection('projects')
      .doc(projectId)
      .collection('messages')
      .add({ role: 'user', content: prompt, createdAt: FieldValue.serverTimestamp() });

    const sse = startSse(res, req);
    const abort = new AbortController();
    req.on('close', () => abort.abort());

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
      geminiApiKey: GEMINI_API_KEY.value(),
      geminiModel: GEMINI_MODEL.value(),
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
          { system, messages, model, maxOutputTokens: 32000, signal: abort.signal },
          (delta) => {
            rawSoFar += delta;
            parser.feed(delta);
          },
        );
      } catch (err) {
        logger.error('LLM stream threw', { err: String(err) });
        result = { text: rawSoFar, stopReason: 'error', detail: String(err) };
      }

      if (sse.closed || result.stopReason === 'aborted') break;

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

    if (result.stopReason === 'aborted' || sse.closed) {
      sse.send('error', { stage: 'aborted', message: 'Generation cancelled' });
      sse.end();
      return;
    }

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
