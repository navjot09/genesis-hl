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
  const changes = computeChanges(params.ops, params.currentFiles, nextFiles);

  // Transaction, not a blind batch: the parent pointer is re-read INSIDE the
  // transaction so two overlapping generations cannot both claim the same
  // parent (which would silently fork the snapshot chain and desync the
  // working set). Last committer parents onto the actual latest snapshot.
  await db.runTransaction(async (tx) => {
    const proj = await tx.get(projRef);
    const freshParent =
      (proj.data()?.currentSnapshotId as string | undefined) ?? params.parentSnapshotId;

    // 1. Immutable snapshot metadata.
    tx.set(snapRef, {
      parentSnapshotId: freshParent,
      prompt: params.prompt,
      createdAt: FieldValue.serverTimestamp(),
      manifest: paths,
      changed: params.ops.map((o) => ({ path: o.path, op: o.op })),
    });

    // 2. Immutable full copy of every file at this point in time.
    for (const [path, content] of Object.entries(nextFiles)) {
      tx.set(snapRef.collection('files').doc(fileDocId(path)), { path, content });
    }

    // 3. Mutable working set: upsert changed (with the APPLIED content, so edits
    //    write the patched file, not the raw hunks), delete removed.
    for (const op of params.ops) {
      const ref = projRef.collection('files').doc(fileDocId(op.path));
      if (op.op === 'delete') {
        tx.delete(ref);
        continue;
      }
      const content = nextFiles[op.path];
      if (content === undefined) continue; // e.g. a failed edit to a missing file
      tx.set(ref, { path: op.path, content, updatedAt: FieldValue.serverTimestamp() });
    }

    // 4. Move the project pointer.
    tx.set(
      projRef,
      { currentSnapshotId: snapRef.id, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );

    // 5. Assistant chat message — includes a compact per-file diff for the chat
    //    "changes" cards (added/removed lines).
    tx.set(projRef.collection('messages').doc(), {
      role: 'assistant',
      content: params.assistantText,
      snapshotId: snapRef.id,
      changes,
      createdAt: FieldValue.serverTimestamp(),
    });
  });

  return { snapshotId: snapRef.id, fileCount: paths.length, warnings };
}
