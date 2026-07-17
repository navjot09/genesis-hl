/**
 * Compact per-file line diffs for the chat "changes" cards.
 *
 * Produces a unified-style diff with limited context (unchanged runs are
 * collapsed), plus add/del counts. Bounded so a chat message never bloats.
 */
import { diffLines } from 'diff';

export type DiffRowKind = '+' | '-' | ' ' | 'gap';

export interface DiffRow {
  t: DiffRowKind;
  text: string;
}

export interface FileChange {
  path: string;
  op: 'write' | 'edit' | 'delete';
  additions: number;
  deletions: number;
  rows: DiffRow[];
  truncated: boolean;
}

const CONTEXT = 2; // unchanged lines kept around each change
const MAX_ROWS = 80; // hard cap on rows shown per file

function splitLines(value: string): string[] {
  const lines = value.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Build a context-collapsed unified diff between two file versions. */
export function fileDiff(
  path: string,
  op: 'write' | 'edit' | 'delete',
  before: string,
  after: string,
): FileChange {
  // Flatten the jsdiff parts into typed lines.
  const parts = diffLines(before, after);
  const flat: DiffRow[] = [];
  let additions = 0;
  let deletions = 0;
  for (const part of parts) {
    const kind: DiffRowKind = part.added ? '+' : part.removed ? '-' : ' ';
    for (const line of splitLines(part.value)) {
      if (kind === '+') additions++;
      else if (kind === '-') deletions++;
      flat.push({ t: kind, text: line });
    }
  }

  // Collapse long unchanged runs to CONTEXT lines around changes.
  const rows: DiffRow[] = [];
  let i = 0;
  while (i < flat.length) {
    if (flat[i].t !== ' ') {
      rows.push(flat[i]);
      i++;
      continue;
    }
    // Gather the unchanged run [i, j).
    let j = i;
    while (j < flat.length && flat[j].t === ' ') j++;
    const runLen = j - i;
    const atStart = rows.length === 0;
    const atEnd = j >= flat.length;
    const head = atStart ? 0 : CONTEXT; // context after previous change
    const tail = atEnd ? 0 : CONTEXT; // context before next change
    if (runLen <= head + tail) {
      for (let k = i; k < j; k++) rows.push(flat[k]);
    } else {
      for (let k = i; k < i + head; k++) rows.push(flat[k]);
      rows.push({ t: 'gap', text: `⋯ ${runLen - head - tail} unchanged lines` });
      for (let k = j - tail; k < j; k++) rows.push(flat[k]);
    }
    i = j;
  }

  const truncated = rows.length > MAX_ROWS;
  return {
    path,
    op,
    additions,
    deletions,
    rows: truncated ? rows.slice(0, MAX_ROWS) : rows,
    truncated,
  };
}

/** Diffs for every changed op, given the file maps before + after applying. */
export function computeChanges(
  ops: { path: string; op: 'write' | 'edit' | 'delete' }[],
  before: Record<string, string>,
  after: Record<string, string>,
): FileChange[] {
  const changes: FileChange[] = [];
  for (const op of ops.slice(0, 12)) {
    changes.push(fileDiff(op.path, op.op, before[op.path] ?? '', after[op.path] ?? ''));
  }
  return changes;
}
