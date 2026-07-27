/**
 * Zod-backed Firestore converter: reads are PARSED, not cast. A schema change
 * or corrupt doc surfaces as a loud error at the read site instead of a silent
 * `as`-cast lie that fails somewhere downstream.
 */
import type {
  DocumentData,
  FirestoreDataConverter,
  QueryDocumentSnapshot,
} from 'firebase-admin/firestore';
import { z } from 'zod';

export function zodConverter<T extends DocumentData>(
  schema: z.ZodType<T>,
): FirestoreDataConverter<T> {
  return {
    toFirestore: (data: T) => data,
    fromFirestore: (snap: QueryDocumentSnapshot) => schema.parse(snap.data()),
  };
}

/** users/{uid} — profile + SAFE HighLevel connection metadata (never tokens). */
export const UserDocSchema = z
  .object({
    hl: z
      .object({
        connected: z.boolean().optional(),
        locationId: z.string().optional(),
        locationName: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type UserDoc = z.infer<typeof UserDocSchema>;
