/**
 * Content-addressed snapshot storage (the git model).
 *
 * Instead of writing a full copy of every file into each snapshot, file
 * content lives ONCE under `projects/{id}/blobs/{sha256(content)}` and a
 * snapshot carries a small manifest of `{ path, hash }` entries. Blobs are
 * immutable and never deleted, so every snapshot ever taken remains
 * restorable by construction; unchanged files across generations cost zero
 * additional writes or storage.
 */
import { createHash } from 'node:crypto';

export interface BlobEntry {
  path: string;
  hash: string;
}

/** sha256 hex of the exact content — the blob's identity AND its doc id. */
export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export interface BlobPlan {
  /** Full manifest for the new snapshot: every path with its content hash. */
  entries: BlobEntry[];
  /** Only the blobs that don't already exist under the parent — the delta. */
  toWrite: { hash: string; content: string }[];
}

/**
 * Plan the blob writes for a new snapshot: hash every file, reuse any hash the
 * parent snapshot already references (rename-safe — dedup is by content, not
 * path), and de-duplicate identical content within the new snapshot itself.
 */
export function planBlobs(
  files: Record<string, string>,
  parentEntries: BlobEntry[] | undefined,
): BlobPlan {
  const parentHashes = new Set((parentEntries ?? []).map((e) => e.hash));
  const entries: BlobEntry[] = [];
  const toWrite = new Map<string, string>();
  for (const [path, content] of Object.entries(files)) {
    const hash = hashContent(content);
    entries.push({ path, hash });
    if (!parentHashes.has(hash) && !toWrite.has(hash)) toWrite.set(hash, content);
  }
  return {
    entries,
    toWrite: [...toWrite.entries()].map(([hash, content]) => ({ hash, content })),
  };
}
