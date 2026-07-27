/**
 * Transactional commit of a generation: records an immutable snapshot as a
 * MANIFEST over content-addressed blobs (full contents stored once under
 * projects/{id}/blobs/{hash} — see contentStore.ts), updates the mutable
 * working file set, moves the project's currentSnapshotId, and appends the
 * assistant chat message. Blob writes happen BEFORE the transaction (they are
 * idempotent and content-addressed, so a crash can never leave a manifest
 * pointing at missing content); everything else commits atomically.
 */
import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../lib/admin.js';
import { applyOps, type FileOp } from './fileOps.js';
import { computeChanges } from './diffSummary.js';
import { lintGeneratedFile } from './lintGenerated.js';
import { planBlobs, type BlobEntry } from './contentStore.js';

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

  // Accident lint over the FINAL content of every changed file (post-edit):
  // patterns that silently die in the sandboxed preview become visible
  // warnings in the chat instead of a mysteriously broken app.
  for (const op of params.ops) {
    if (op.op === 'delete') continue;
    const content = nextFiles[op.path];
    if (content === undefined) continue;
    for (const w of lintGeneratedFile(op.path, content)) {
      warnings.push(`${w.path}: ${w.message}`);
    }
  }

  const projRef = db.collection('projects').doc(params.projectId);
  const snapRef = projRef.collection('snapshots').doc();
  const changes = computeChanges(params.ops, params.currentFiles, nextFiles);

  // Content-addressed storage: hash every file, then write ONLY the blobs the
  // parent snapshot doesn't already reference. Unchanged files cost nothing;
  // a one-line edit writes ~1 blob instead of a full project copy.
  const parentEntries = await loadBlobEntries(params.projectId, params.parentSnapshotId);
  const plan = planBlobs(nextFiles, parentEntries);
  await writeBlobs(params.projectId, plan.toWrite);

  // Transaction, not a blind batch: the parent pointer is re-read INSIDE the
  // transaction so two overlapping generations cannot both claim the same
  // parent (which would silently fork the snapshot chain and desync the
  // working set). Last committer parents onto the actual latest snapshot.
  await db.runTransaction(async (tx) => {
    const proj = await tx.get(projRef);
    const freshParent =
      (proj.data()?.currentSnapshotId as string | undefined) ?? params.parentSnapshotId;

    // 1. Immutable snapshot: metadata + the content-addressed manifest.
    tx.set(snapRef, {
      parentSnapshotId: freshParent,
      prompt: params.prompt,
      createdAt: FieldValue.serverTimestamp(),
      manifest: paths,
      blobs: plan.entries,
      changed: params.ops.map((o) => ({ path: o.path, op: o.op })),
    });

    // 2. Mutable working set: upsert changed (with the APPLIED content, so edits
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

    // 3. Move the project pointer.
    tx.set(
      projRef,
      { currentSnapshotId: snapRef.id, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );

    // 4. Assistant chat message — includes a compact per-file diff for the chat
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

/** Blob entries referenced by a snapshot (undefined for legacy snapshots). */
export async function loadBlobEntries(
  projectId: string,
  snapshotId: string | null,
): Promise<BlobEntry[] | undefined> {
  if (!snapshotId) return undefined;
  const snap = await db
    .collection('projects')
    .doc(projectId)
    .collection('snapshots')
    .doc(snapshotId)
    .get();
  const entries = snap.data()?.blobs as BlobEntry[] | undefined;
  return Array.isArray(entries) ? entries : undefined;
}

/**
 * Write blobs idempotently. create() + tolerate ALREADY_EXISTS: a blob's id is
 * its content hash, so an existing doc is by definition identical — skipping
 * it preserves createdAt and saves the write.
 */
export async function writeBlobs(
  projectId: string,
  blobs: { hash: string; content: string }[],
): Promise<void> {
  const col = db.collection('projects').doc(projectId).collection('blobs');
  await Promise.all(
    blobs.map(async (b) => {
      try {
        await col.doc(b.hash).create({ content: b.content, createdAt: FieldValue.serverTimestamp() });
      } catch (err) {
        const code = (err as { code?: number }).code;
        if (code !== 6) throw err; // 6 = ALREADY_EXISTS — identical content, fine
      }
    }),
  );
}
