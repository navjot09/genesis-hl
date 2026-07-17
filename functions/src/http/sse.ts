/**
 * Server-Sent Events helper for 2nd-gen (Cloud Run) HTTP functions.
 *
 * Critical for un-buffered streaming:
 *   - Content-Type: text/event-stream, Cache-Control: no-cache, no-transform
 *   - X-Accel-Buffering: no  (defeats nginx-style proxy buffering)
 *   - NO Content-Length and NO gzip on this route (both force buffering)
 *   - Call the SSE endpoint at the DIRECT function URL, never a Hosting rewrite.
 *
 * Event protocol used by Genesis (see the generation pipeline):
 *   token        { text }                     incremental model output
 *   file_open    { path, op }                 a <file> block started
 *   file_close   { path }                     a <file> block finished
 *   snapshot     { snapshotId }               generation committed
 *   done         { ... }                      stream finished cleanly
 *   error        { stage, message, detail? }  something failed (partial preserved)
 */
import type { Response } from 'express';

export type SseEvent =
  | 'token'
  | 'assistant_delta'
  | 'file_open'
  | 'file_delta'
  | 'file_close'
  | 'snapshot'
  | 'done'
  | 'error';

export interface SseController {
  /** Emit a named event with a JSON payload. */
  send(event: SseEvent, data: unknown): void;
  /** Emit an SSE comment (used for heartbeats / keep-alive). */
  comment(text: string): void;
  /** Whether the client has disconnected. */
  readonly closed: boolean;
  /** Stop the heartbeat and end the response. */
  end(): void;
}

export function startSse(res: Response, req?: { on(ev: 'close', cb: () => void): void }): SseController {
  res.status(200);
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  let closed = false;
  req?.on('close', () => {
    closed = true;
  });

  const raw = (chunk: string) => {
    if (closed) return;
    res.write(chunk);
    // compression/express add res.flush(); force a socket flush when available.
    const flush = (res as unknown as { flush?: () => void }).flush;
    if (typeof flush === 'function') flush.call(res);
  };

  // Heartbeat every 15s so proxies keep the connection open and we notice drops.
  const heartbeat = setInterval(() => raw(': ping\n\n'), 15000);

  return {
    send(event, data) {
      raw(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    comment(text) {
      raw(`: ${text}\n\n`);
    },
    get closed() {
      return closed;
    },
    end() {
      clearInterval(heartbeat);
      if (!closed) res.end();
      closed = true;
    },
  };
}
