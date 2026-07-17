/**
 * HighLevel webhook receiver.
 *
 * HL POSTs marketplace events (ContactCreate, InboundMessage, AppointmentCreate, …)
 * to this public endpoint. We store each event in Firestore scoped to its
 * locationId; generated apps read them back through the proxy's /__events route
 * (see proxy/index.ts) using their capability token, so a preview can react to
 * live events without any direct database access.
 *
 * NOTE: production should verify HL's webhook signature (RSA public key). For
 * this build we accept + store and cap payload size; signature verification is
 * called out in the README's "What I would improve".
 */
import { onRequest } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../lib/admin.js';

/** Best-effort extraction of the location id from a variety of HL payload shapes. */
function extractLocationId(body: Record<string, unknown>): string | null {
  const candidates = [body.locationId, body.location_id, (body.location as { id?: string })?.id];
  for (const c of candidates) if (typeof c === 'string' && c) return c;
  return null;
}

export const hlWebhook = onRequest({ cors: false, timeoutSeconds: 30 }, async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).send('Use POST');
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const locationId = extractLocationId(body);
  const type = typeof body.type === 'string' ? body.type : 'Unknown';

  // Always 200 quickly so HL doesn't retry; ignore events we can't route.
  if (!locationId) {
    res.status(200).json({ ok: true, ignored: 'no locationId' });
    return;
  }

  try {
    // Keep the stored payload bounded.
    const raw = JSON.stringify(body);
    const data = raw.length > 12_000 ? { truncated: true } : body;

    await db
      .collection('webhookEvents')
      .doc(locationId)
      .collection('events')
      .add({
        type,
        locationId,
        data,
        receivedAt: FieldValue.serverTimestamp(),
      });
    res.status(200).json({ ok: true });
  } catch (err) {
    logger.error('Failed to store webhook event', { err: String(err), type, locationId });
    // Still 200 — a storage error shouldn't make HL hammer us with retries.
    res.status(200).json({ ok: false });
  }
});
