/**
 * POST /restoreSnapshot — revert a project to a previous snapshot.
 *
 * Restore is append-only: it copies the target snapshot's files back into the
 * mutable working set AND records a NEW snapshot (parent = current head) whose
 * content equals the target. So the restore itself is a point in history and is
 * undoable, and the timeline never branches.
 */
import { onRequest } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../lib/admin.js';
import { AuthError, requireFirebaseUser } from '../lib/authn.js';
import { fileDocId } from './snapshots.js';

export const restoreSnapshot = onRequest({ cors: true }, async (req, res) => {
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

  const body = (req.body ?? {}) as { projectId?: unknown; snapshotId?: unknown };
  const projectId = typeof body.projectId === 'string' ? body.projectId : '';
  const snapshotId = typeof body.snapshotId === 'string' ? body.snapshotId : '';
  if (!projectId || !snapshotId) {
    res.status(400).json({ error: 'projectId and snapshotId are required' });
    return;
  }

  const projRef = db.collection('projects').doc(projectId);
  const proj = await projRef.get();
  const projData = proj.data() as { ownerUid?: string; currentSnapshotId?: string } | undefined;
  if (!proj.exists || projData?.ownerUid !== uid) {
    res.status(403).json({ error: 'Project not found or not yours' });
    return;
  }

  const targetRef = projRef.collection('snapshots').doc(snapshotId);
  const target = await targetRef.get();
  if (!target.exists) {
    res.status(404).json({ error: 'Snapshot not found' });
    return;
  }

  // Files as they were at the target snapshot.
  const targetFilesSnap = await targetRef.collection('files').get();
  const files: Record<string, string> = {};
  targetFilesSnap.forEach((d) => {
    const x = d.data() as { path: string; content: string };
    files[x.path] = x.content ?? '';
  });

  // Current working files (to know which to delete on restore).
  const workingSnap = await projRef.collection('files').get();
  const currentPaths: string[] = [];
  workingSnap.forEach((d) => currentPaths.push((d.data() as { path: string }).path));

  const targetPrompt = (target.data() as { prompt?: string }).prompt ?? 'a previous version';
  const newSnapRef = projRef.collection('snapshots').doc();
  const batch = db.batch();

  // 1. New immutable snapshot recording the restore.
  batch.set(newSnapRef, {
    parentSnapshotId: projData?.currentSnapshotId ?? null,
    prompt: `Restored: ${targetPrompt.slice(0, 60)}`,
    restoredFrom: snapshotId,
    createdAt: FieldValue.serverTimestamp(),
    manifest: Object.keys(files),
    changed: Object.keys(files).map((p) => ({ path: p, op: 'write' })),
  });
  for (const [path, content] of Object.entries(files)) {
    batch.set(newSnapRef.collection('files').doc(fileDocId(path)), { path, content });
  }

  // 2. Working set becomes the target's files (add/overwrite, delete the rest).
  for (const [path, content] of Object.entries(files)) {
    batch.set(projRef.collection('files').doc(fileDocId(path)), {
      path,
      content,
      updatedAt: FieldValue.serverTimestamp(),
    });
  }
  for (const path of currentPaths) {
    if (!(path in files)) batch.delete(projRef.collection('files').doc(fileDocId(path)));
  }

  // 3. Move the head + a chat note so the restore shows in history.
  batch.set(
    projRef,
    { currentSnapshotId: newSnapRef.id, updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );
  batch.set(projRef.collection('messages').doc(), {
    role: 'assistant',
    content: `Restored the project to an earlier version (${targetPrompt.slice(0, 60)}).`,
    snapshotId: newSnapRef.id,
    createdAt: FieldValue.serverTimestamp(),
  });

  try {
    await batch.commit();
    res.json({ ok: true, snapshotId: newSnapRef.id, fileCount: Object.keys(files).length });
  } catch (err) {
    logger.error('Restore failed', { err: String(err) });
    res.status(500).json({ error: 'Failed to restore snapshot' });
  }
});
