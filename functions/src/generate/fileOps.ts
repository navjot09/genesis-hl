/**
 * Validation + application of parsed file operations.
 *
 * The model's output is untrusted structurally: validate every op (safe relative
 * path, size caps, allowed op) BEFORE anything is written to Firestore.
 */
import { z } from 'zod';
import type { ParsedFile } from './markerParser.js';
import { applyEditBlocks, parseEditBlocks } from './editApply.js';

const MAX_FILE_BYTES = 200_000;
const MAX_TOTAL_BYTES = 1_500_000;
const MAX_FILES = 40;

const FileOpSchema = z.object({
  path: z
    .string()
    .min(1)
    .max(200)
    .refine((p) => !p.startsWith('/'), 'path must be relative')
    .refine((p) => !p.includes('..'), 'path must not contain ".."')
    .refine((p) => !/^[a-zA-Z]:/.test(p), 'no drive-letter paths')
    .refine((p) => !p.includes('\0'), 'no null bytes')
    .refine((p) => /^[A-Za-z0-9._\-/]+$/.test(p), 'path has invalid characters'),
  op: z.enum(['write', 'edit', 'delete']),
  content: z.string().max(MAX_FILE_BYTES),
});

export type FileOp = z.infer<typeof FileOpSchema>;

export interface ValidationResult {
  ops: FileOp[];
  errors: string[];
}

/** Validate parsed files; drop invalid ones, collecting human-readable errors. */
export function validateOps(parsed: ParsedFile[]): ValidationResult {
  const ops: FileOp[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  let total = 0;

  for (const f of parsed) {
    const res = FileOpSchema.safeParse(f);
    if (!res.success) {
      errors.push(`${f.path || '(no path)'}: ${res.error.issues[0]?.message ?? 'invalid'}`);
      continue;
    }
    const op = res.data;
    // Last write wins for a duplicated path.
    if (seen.has(op.path)) {
      const i = ops.findIndex((o) => o.path === op.path);
      if (i >= 0) ops.splice(i, 1);
    }
    seen.add(op.path);
    total += op.content.length;
    ops.push(op);
  }

  if (ops.length > MAX_FILES) {
    errors.push(`too many files (${ops.length} > ${MAX_FILES})`);
    return { ops: ops.slice(0, MAX_FILES), errors };
  }
  if (total > MAX_TOTAL_BYTES) {
    errors.push(`total content ${total} exceeds cap ${MAX_TOTAL_BYTES}`);
  }
  return { ops, errors };
}

export interface ApplyOpsResult {
  next: Record<string, string>;
  /** Human-readable notes about edits that couldn't be fully applied. */
  warnings: string[];
}

/**
 * Apply ops to a working file map (path -> content). Pure.
 *   write  -> set full content
 *   edit   -> apply SEARCH/REPLACE hunks to existing content
 *   delete -> remove
 */
export function applyOps(current: Record<string, string>, ops: FileOp[]): ApplyOpsResult {
  const next = { ...current };
  const warnings: string[] = [];
  for (const op of ops) {
    if (op.op === 'delete') {
      delete next[op.path];
    } else if (op.op === 'edit') {
      const original = next[op.path];
      if (original === undefined) {
        warnings.push(`Skipped edit to ${op.path}: the file doesn't exist yet`);
        continue;
      }
      const blocks = parseEditBlocks(op.content);
      if (blocks.length === 0) {
        warnings.push(`Skipped edit to ${op.path}: no valid SEARCH/REPLACE blocks`);
        continue;
      }
      const { result, applied, failed } = applyEditBlocks(original, blocks);
      next[op.path] = result;
      if (failed > 0) {
        warnings.push(`${op.path}: applied ${applied} edit(s), ${failed} did not match and were skipped`);
      }
    } else {
      next[op.path] = op.content;
    }
  }
  return { next, warnings };
}
