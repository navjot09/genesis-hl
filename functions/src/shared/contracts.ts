/**
 * SINGLE SOURCE OF TRUTH for every type that crosses the backend↔frontend
 * boundary. The backend imports it directly; the frontend imports it via the
 * `@contracts` alias (vite + tsconfig) — so a change here that breaks either
 * side fails to COMPILE instead of drifting silently.
 *
 * Keep this file dependency-free (types + pure constants only): it is compiled
 * into both bundles.
 */

export type FileOp = 'write' | 'edit' | 'delete';

// --- SSE wire protocol for /generate ---------------------------------------
// On the wire: `event: <type>` + `data: <payload without type>`. The server
// sends the whole object; startSse() splits it. The client reassembles by
// switching on the event name.

export type SseEvent =
  | { type: 'assistant_delta'; text: string }
  | { type: 'file_open'; path: string; op: FileOp }
  | { type: 'file_delta'; path: string; text: string }
  | { type: 'file_close'; path: string }
  | {
      type: 'snapshot';
      snapshotId: string;
      fileCount: number;
      files: { path: string; op: FileOp }[];
    }
  | {
      type: 'done';
      stopReason: string;
      truncated: boolean;
      usage?: unknown;
      warnings?: string[];
    }
  | {
      type: 'error';
      stage: 'stream' | 'validation' | 'commit' | 'aborted';
      message: string;
      detail?: string;
      partial?: boolean;
    };

/** Event names as they appear on the wire (`event:` line). */
export type SseEventType = SseEvent['type'];

/** Payload for one event type, as carried in the `data:` line (no `type`). */
export type SsePayload<T extends SseEventType> = Omit<Extract<SseEvent, { type: T }>, 'type'>;

// --- Per-file diffs attached to assistant chat messages ---------------------

export type DiffRowKind = '+' | '-' | ' ' | 'gap';

export interface DiffRow {
  t: DiffRowKind;
  text: string;
}

export interface FileChange {
  path: string;
  op: FileOp;
  additions: number;
  deletions: number;
  rows: DiffRow[];
  truncated: boolean;
}
