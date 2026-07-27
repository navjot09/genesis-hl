/**
 * POST /restoreSnapshot — revert a project to a previous snapshot.
 *
 * Restore is append-only: it copies the target snapshot's files back into the
 * mutable working set AND records a NEW snapshot (parent = current head) whose
 * content equals the target. So the restore itself is a point in history and is
 * undoable, and the timeline never branches.
 */
import { onRequest } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../lib/admin.js';
import { AuthError, requireFirebaseUser } from '../lib/authn.js';
import { AppError, sendError } from '../lib/errors.js';
import { fileDocId, writeBlobs } from './snapshots.js';
import { planBlobs, type BlobEntry } from './contentStore.js';

const RestoreRequest = z.object({
  projectId: z.string().min(1),
  snapshotId: z.string().min(1),
});

export const restoreSnapshot = onRequest({ cors: true }, async (req, res) => {
  try {
    if (req.method !== 'POST') throw new AppError('BAD_REQUEST', 'Use POST');

    let uid: string;
    try {
      ({ uid } = await requireFirebaseUser(req));
    } catch (err) {
      throw new AppError('UNAUTHORIZED', err instanceof AuthError ? err.message : 'Sign in required');
    }

    const parsed = RestoreRequest.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new AppError('BAD_REQUEST', parsed.error.issues[0]?.message ?? 'Invalid request');
    }
    const { projectId, snapshotId } = parsed.data;

    const projRef = db.collection('projects').doc(projectId);
    const targetRef = projRef.collection('snapshots').doc(snapshotId);
    const newSnapRef = projRef.collection('snapshots').doc();

    // --- Pre-transaction: ownership, then resolve the target's contents. ----
    // Snapshots and blobs are IMMUTABLE, so reading them outside the
    // transaction is safe; only the head pointer / working set need txn rigor.
    const projPre = await projRef.get();
    // 404 (not 403) for unowned projects: don't confirm existence to non-owners.
    if (!projPre.exists || (projPre.data() as { ownerUid?: string }).ownerUid !== uid) {
      throw new AppError('NOT_FOUND', 'Project not found');
    }
    const target = await targetRef.get();
    if (!target.exists) throw new AppError('NOT_FOUND', 'Snapshot not found');
    const targetData = target.data() as { prompt?: string; blobs?: BlobEntry[] };
    const targetPrompt = targetData.prompt ?? 'a previous version';

    // Files as they were at the target snapshot: content-addressed manifest
    // (new format) or inline files subcollection (legacy snapshots).
    const files: Record<string, string> = {};
    let entries: BlobEntry[];
    if (Array.isArray(targetData.blobs) && targetData.blobs.length > 0) {
      entries = targetData.blobs;
      const blobRefs = entries.map((e) => projRef.collection('blobs').doc(e.hash));
      const blobDocs = await db.getAll(...blobRefs);
      entries.forEach((e, i) => {
        const content = blobDocs[i].data()?.content as string | undefined;
        if (content === undefined) throw new AppError('INTERNAL', 'Snapshot content missing');
        files[e.path] = content;
      });
    } else {
      const targetFilesSnap = await targetRef.collection('files').get();
      targetFilesSnap.forEach((d) => {
        const x = d.data() as { path: string; content: string };
        files[x.path] = x.content ?? '';
      });
      // Migrate this legacy snapshot's contents into blob storage so the NEW
      // snapshot is manifest-based like everything going forward.
      const plan = planBlobs(files, undefined);
      await writeBlobs(projectId, plan.toWrite);
      entries = plan.entries;
    }

    // --- Transaction: head pointer + working set flip, atomically. ----------
    const outcome = await db.runTransaction(async (tx) => {
      const [proj, workingSnap] = await Promise.all([
        tx.get(projRef),
        tx.get(projRef.collection('files')),
      ]);
      const projData = proj.data() as
        | { ownerUid?: string; currentSnapshotId?: string }
        | undefined;
      if (!proj.exists || projData?.ownerUid !== uid) {
        throw new AppError('NOT_FOUND', 'Project not found');
      }
      const currentPaths = workingSnap.docs.map((d) => (d.data() as { path: string }).path);

      // 1. New immutable snapshot recording the restore — REUSES the target's
      //    content hashes: a restore writes a manifest, never file copies.
      tx.set(newSnapRef, {
        parentSnapshotId: projData?.currentSnapshotId ?? null,
        prompt: `Restored: ${targetPrompt.slice(0, 60)}`,
        restoredFrom: snapshotId,
        createdAt: FieldValue.serverTimestamp(),
        manifest: Object.keys(files),
        blobs: entries,
        changed: Object.keys(files).map((p) => ({ path: p, op: 'write' })),
      });

      // 2. Working set becomes the target's files (add/overwrite, delete the rest).
      for (const [path, content] of Object.entries(files)) {
        tx.set(projRef.collection('files').doc(fileDocId(path)), {
          path,
          content,
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
      for (const path of currentPaths) {
        if (!(path in files)) tx.delete(projRef.collection('files').doc(fileDocId(path)));
      }

      // 3. Move the head + a chat note so the restore shows in history.
      tx.set(
        projRef,
        { currentSnapshotId: newSnapRef.id, updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
      tx.set(projRef.collection('messages').doc(), {
        role: 'assistant',
        content: `Restored the project to an earlier version (${targetPrompt.slice(0, 60)}).`,
        snapshotId: newSnapRef.id,
        createdAt: FieldValue.serverTimestamp(),
      });

      return { fileCount: Object.keys(files).length };
    });

    res.json({ ok: true, snapshotId: newSnapRef.id, fileCount: outcome.fileCount });
  } catch (err) {
    sendError(res, err);
  }
});
