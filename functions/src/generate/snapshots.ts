/**
 * Transactional commit of a generation: writes an immutable snapshot (full
 * point-in-time copy of all files), updates the mutable working file set, moves
 * the project's currentSnapshotId, and appends the assistant chat message — all
 * in one atomic batch. A generation only reaches here after full validation, so
 * a bad/truncated generation never overwrites a good snapshot.
 */
import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../lib/admin.js';
import { applyOps, type FileOp } from './fileOps.js';
import { computeChanges } from './diffSummary.js';

/** Firestore doc ids can't contain '/', so key file docs by base64url(path). */
export const fileDocId = (path: string): string => Buffer.from(path, 'utf8').toString('base64url');

export interface CommitParams {
  projectId: string;
  prompt: string;
  assistantText: string;
  ops: FileOp[];
  currentFiles: Record<string, string>;
  parentSnapshotId: string | null;
}

export interface CommitResult {
  snapshotId: string;
  fileCount: number;
  warnings: string[];
}

export async function commitGeneration(params: CommitParams): Promise<CommitResult> {
  const { next: nextFiles, warnings } = applyOps(params.currentFiles, params.ops);
  const paths = Object.keys(nextFiles);

  const projRef = db.collection('projects').doc(params.projectId);
  const snapRef = projRef.collection('snapshots').doc();
  const batch = db.batch();

  // 1. Immutable snapshot metadata.
  batch.set(snapRef, {
    parentSnapshotId: params.parentSnapshotId,
    prompt: params.prompt,
    createdAt: FieldValue.serverTimestamp(),
    manifest: paths,
    changed: params.ops.map((o) => ({ path: o.path, op: o.op })),
  });

  // 2. Immutable full copy of every file at this point in time.
  for (const [path, content] of Object.entries(nextFiles)) {
    batch.set(snapRef.collection('files').doc(fileDocId(path)), { path, content });
  }

  // 3. Mutable working set: upsert changed (with the APPLIED content, so edits
  //    write the patched file, not the raw hunks), delete removed.
  for (const op of params.ops) {
    const ref = projRef.collection('files').doc(fileDocId(op.path));
    if (op.op === 'delete') {
      batch.delete(ref);
      continue;
    }
    const content = nextFiles[op.path];
    if (content === undefined) continue; // e.g. a failed edit to a missing file
    batch.set(ref, { path: op.path, content, updatedAt: FieldValue.serverTimestamp() });
  }

  // 4. Move the project pointer.
  batch.set(
    projRef,
    { currentSnapshotId: snapRef.id, updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );

  // 5. Assistant chat message — includes a compact per-file diff for the chat
  //    "changes" cards (added/removed lines).
  const changes = computeChanges(params.ops, params.currentFiles, nextFiles);
  batch.set(projRef.collection('messages').doc(), {
    role: 'assistant',
    content: params.assistantText,
    snapshotId: snapRef.id,
    changes,
    createdAt: FieldValue.serverTimestamp(),
  });

  await batch.commit();
  return { snapshotId: snapRef.id, fileCount: paths.length, warnings };
}
