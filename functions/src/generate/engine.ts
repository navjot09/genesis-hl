/**
 * The generation ENGINE — the model-facing core of Genesis, with zero
 * knowledge of HTTP, SSE, or Firestore.
 *
 * It streams the LLM, parses file blocks, decides when to resume after an
 * interruption, and validates the result. Progress is reported through a
 * plain callback (`emit`) — the HTTP handler forwards those events to the
 * browser; tests capture them in an array. The final, validated result is the
 * RETURN VALUE.
 *
 * Because the only dependencies are an LLMProvider and a callback, the whole
 * continuation logic is unit-testable with a scripted fake provider:
 * "the stream died mid-file on attempt 1 — prove attempt 2 resumes from a
 * clean boundary and nothing is lost."
 */
import type { LlmMessage, LLMProvider, LlmStreamResult } from '../llm/index.js';
import type { SseEvent } from '../shared/contracts.js';
import { MarkerParser, type ParsedFile } from './markerParser.js';
import { validateOps, type FileOp } from './fileOps.js';
import { findMissingReferencedFiles, isTransient } from './heuristics.js';

/** Live-progress events the engine emits (a subset of the wire contract). */
export type EngineEvent = Extract<
  SseEvent,
  { type: 'assistant_delta' | 'file_open' | 'file_delta' | 'file_close' }
>;

export interface EngineInput {
  system: string;
  /** Base conversation: history + current files + the user's request. */
  baseMessages: LlmMessage[];
  model: string;
  maxOutputTokens: number;
  maxContinuations: number;
}

export interface EngineOutcome {
  /** Validated file operations (empty if the run produced nothing usable). */
  ops: FileOp[];
  validationErrors: string[];
  /** Raw intro prose captured from the FIRST attempt (unsanitized). */
  assistantText: string;
  stopReason: LlmStreamResult['stopReason'];
  detail?: string;
  usage?: LlmStreamResult['usage'];
  /** Total attempts made (1 = no continuation needed). */
  attempts: number;
  /** True when the final attempt ended in error/blocked (partial result). */
  streamFailed: boolean;
}

export type ResumeDecision = { resume: false } | { resume: true; reason: string };

/**
 * The continuation policy, as a PURE function: given how an attempt ended and
 * what has been parsed so far, decide whether to try again and why. Kept
 * separate from the loop so every branch is table-testable.
 */
export function decideResume(
  result: LlmStreamResult,
  files: ParsedFile[],
  continuationsUsed: number,
  maxContinuations: number,
): ResumeDecision {
  if (continuationsUsed >= maxContinuations) return { resume: false };

  if (result.stopReason === 'max_tokens') {
    return { resume: true, reason: 'It stopped at the length limit.' };
  }
  if (result.stopReason === 'error' && isTransient(result.detail)) {
    return { resume: true, reason: 'The connection dropped.' };
  }
  if (result.stopReason === 'blocked') {
    // RECITATION/OTHER are non-deterministic content flags — regenerating the
    // remaining files usually clears them. Genuine safety blocks are final.
    const d = (result.detail ?? '').toUpperCase();
    if (d.includes('RECITATION') || d.includes('OTHER')) {
      return { resume: true, reason: 'The response was flagged; continue.' };
    }
    return { resume: false };
  }
  if (result.stopReason === 'stop') {
    // Clean finish — but did it reference local files it forgot to output?
    const missing = findMissingReferencedFiles(files);
    if (missing.length) {
      return {
        resume: true,
        reason: `index.html references files you did not include: ${missing.join(', ')}.`,
      };
    }
  }
  return { resume: false };
}

/**
 * Build the conversation for a continuation attempt. The completed files are
 * replayed as a clean assistant turn (NEVER the raw partial stream — orphaned
 * half-blocks make the model continue mid-content and leak code into prose).
 */
export function buildContinuationMessages(
  baseMessages: LlmMessage[],
  files: ParsedFile[],
  reason: string,
): LlmMessage[] {
  const done = files.map((f) => f.path);
  if (done.length === 0) return baseMessages;

  const completedBlocks = files
    .map((f) =>
      f.op === 'delete'
        ? `<file path="${f.path}" op="delete"></file>`
        : `<file path="${f.path}">\n${f.content}\n</file>`,
    )
    .join('\n\n');
  const instruction =
    `${reason} The complete files above are already saved (${done.join(', ')}). ` +
    `Now output the REMAINING/missing files as complete <file path="...">...</file> blocks. ` +
    `Start any unfinished file OVER as a fresh complete block — do NOT continue mid-file. ` +
    `Do NOT repeat a file shown above. No prose, no markdown fences.`;

  return [
    ...baseMessages,
    { role: 'assistant', content: completedBlocks },
    { role: 'user', content: instruction },
  ];
}

/**
 * Run one full generation: stream → parse → (resume as needed) → validate.
 * Never throws for model/stream problems — failures are described in the
 * returned outcome so the caller decides how to present them.
 */
export async function runGeneration(
  provider: LLMProvider,
  input: EngineInput,
  emit: (event: EngineEvent) => void,
): Promise<EngineOutcome> {
  let assistantText = '';
  // Keep ONLY the first attempt's intro prose. Continuations each re-emit
  // their own intro; concatenating them produces a jumbled chat message.
  let captureProse = true;

  const parser = new MarkerParser((e) => {
    switch (e.type) {
      case 'prose':
        if (captureProse) {
          assistantText += e.text;
          emit({ type: 'assistant_delta', text: e.text });
        }
        break;
      case 'file_open':
        emit({ type: 'file_open', path: e.path, op: e.op });
        break;
      case 'file_delta':
        emit({ type: 'file_delta', path: e.path, text: e.text });
        break;
      case 'file_close':
        emit({ type: 'file_close', path: e.path });
        break;
    }
  });

  let result: LlmStreamResult | undefined;
  let rawSoFar = '';
  let messages = input.baseMessages;
  let attempt = 0;

  for (;;) {
    try {
      result = await provider.stream(
        {
          system: input.system,
          messages,
          model: input.model,
          maxOutputTokens: input.maxOutputTokens,
        },
        (delta) => {
          rawSoFar += delta;
          parser.feed(delta);
        },
      );
    } catch (err) {
      // A well-behaved provider reports errors in its result; this is the
      // belt-and-braces path for one that throws anyway.
      result = { text: rawSoFar, stopReason: 'error', detail: String(err) };
    }
    attempt++;

    if (result.stopReason === 'aborted') break;

    const decision = decideResume(result, parser.files, attempt - 1, input.maxContinuations);
    if (!decision.resume) break;

    // Resume: drop the interrupted file, keep completed ones, ask for the rest.
    captureProse = false;
    parser.resetInProgress();
    messages = buildContinuationMessages(input.baseMessages, parser.files, decision.reason);
  }
  parser.end();
  if (!result) result = { text: rawSoFar, stopReason: 'error', detail: 'no result' };

  const { ops, errors } = validateOps(parser.files);
  return {
    ops,
    validationErrors: errors,
    assistantText,
    stopReason: result.stopReason,
    detail: result.detail,
    usage: result.usage,
    attempts: attempt,
    streamFailed: result.stopReason === 'error' || result.stopReason === 'blocked',
  };
}
