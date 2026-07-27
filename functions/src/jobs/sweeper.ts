/**
 * Stale-generation sweeper.
 *
 * A function instance that dies mid-run (OOM, redeploy, crash) leaves its job
 * record 'streaming' forever — lying to observability and to any client
 * watching it. Every 15 minutes, jobs whose heartbeat (updatedAt) has been
 * silent far longer than any live run could manage are marked failed.
 */
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions/v2';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { db } from '../lib/admin.js';
import { LIMITS } from '../config/limits.js';

export const sweepStaleGenerations = onSchedule('every 15 minutes', async () => {
  const cutoff = Timestamp.fromMillis(Date.now() - LIMITS.jobSweepStaleMs);
  const stale = await db
    .collection('generations')
    .where('status', '==', 'streaming')
    .where('updatedAt', '<', cutoff)
    .limit(100)
    .get();
  if (stale.empty) return;

  const batch = db.batch();
  stale.forEach((doc) => {
    batch.set(
      doc.ref,
      {
        status: 'failed',
        error: 'instance lost (heartbeat went silent)',
        finishedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  });
  await batch.commit();
  logger.warn('Swept stale generation jobs', { count: stale.size });
});
