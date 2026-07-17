/**
 * Streaming parser for the marker file protocol:
 *
 *   <prose describing the work...>
 *   <file path="index.html">...contents...</file>
 *   <file path="old.js" op="delete"></file>
 *
 * Emits events as tokens stream in, tolerating markers split across chunk
 * boundaries. A file is only finalized (pushed to `files`) when its closing
 * </file> arrives — so a truncated/interrupted stream never yields a partial
 * file, and everything already closed is preserved.
 */

export type ParserEvent =
  | { type: 'prose'; text: string }
  | { type: 'file_open'; path: string; op: 'write' | 'edit' | 'delete' }
  | { type: 'file_delta'; path: string; text: string }
  | { type: 'file_close'; path: string };

export interface ParsedFile {
  path: string;
  op: 'write' | 'edit' | 'delete';
  content: string;
}

const OPEN_TAG = /^<file\s+path="([^"]+)"(?:\s+op="(write|edit|delete)")?\s*>/;
const CLOSE = '</file>';

export class MarkerParser {
  private buffer = '';
  private mode: 'prose' | 'infile' = 'prose';
  private path = '';
  private op: 'write' | 'edit' | 'delete' = 'write';
  private content = '';
  /** Fully-closed files, in order. Safe to use even after a truncated stream. */
  readonly files: ParsedFile[] = [];

  constructor(private readonly emit: (e: ParserEvent) => void) {}

  feed(delta: string): void {
    this.buffer += delta;
    this.process(false);
  }

  /** Call once the stream ends. Any unterminated <file> is intentionally discarded. */
  end(): void {
    this.process(true);
  }

  /**
   * Discard any in-progress (unterminated) file + unparsed buffer, returning to
   * prose mode, while KEEPING all fully-closed files. Used before feeding a
   * continuation stream after an interruption, so the resumed output parses
   * from a clean file boundary.
   */
  resetInProgress(): void {
    this.buffer = '';
    this.mode = 'prose';
    this.path = '';
    this.content = '';
  }

  /** Paths of files fully closed so far. */
  completedPaths(): string[] {
    return this.files.map((f) => f.path);
  }

  private process(final: boolean): void {
    // Loop as long as we can make progress.
    for (;;) {
      if (this.mode === 'prose') {
        const idx = this.buffer.indexOf('<file');
        if (idx === -1) {
          // No open marker; emit prose but hold back a possible partial "<file" suffix.
          const safe = final ? this.buffer.length : safePrefix(this.buffer, '<file');
          this.flushProse(safe);
          return;
        }
        // Emit any prose before the marker.
        if (idx > 0) {
          this.flushProse(idx);
          continue;
        }
        // Buffer starts with "<file" — try to match a complete open tag.
        const m = OPEN_TAG.exec(this.buffer);
        if (!m) {
          // Incomplete tag: wait for more input (unless the stream is over).
          if (final) {
            this.flushProse(this.buffer.length); // malformed trailing tag -> treat as prose
          }
          return;
        }
        this.path = m[1];
        this.op = (m[2] as 'write' | 'edit' | 'delete') || 'write';
        this.content = '';
        this.buffer = this.buffer.slice(m[0].length);
        this.mode = 'infile';
        this.emit({ type: 'file_open', path: this.path, op: this.op });
        continue;
      }

      // mode === 'infile'
      const close = this.buffer.indexOf(CLOSE);
      if (close === -1) {
        // Emit content but hold back a possible partial "</file>" suffix.
        const safe = final ? this.buffer.length : safePrefix(this.buffer, CLOSE);
        this.flushContent(safe);
        // On final with an unterminated file: discard (do NOT push to files).
        return;
      }
      this.flushContent(close);
      this.buffer = this.buffer.slice(close + CLOSE.length);
      this.emit({ type: 'file_close', path: this.path });
      this.files.push({ path: this.path, op: this.op, content: this.content });
      this.mode = 'prose';
      this.path = '';
      this.content = '';
    }
  }

  private flushProse(n: number): void {
    if (n <= 0) return;
    const text = this.buffer.slice(0, n);
    this.buffer = this.buffer.slice(n);
    if (text) this.emit({ type: 'prose', text });
  }

  private flushContent(n: number): void {
    if (n <= 0) return;
    const text = this.buffer.slice(0, n);
    this.buffer = this.buffer.slice(n);
    if (text) {
      this.content += text;
      this.emit({ type: 'file_delta', path: this.path, text });
    }
  }
}

/**
 * Length of `s` that is safe to emit without possibly splitting `marker`: hold
 * back the longest suffix of `s` that is a prefix of `marker`.
 */
function safePrefix(s: string, marker: string): number {
  const max = Math.min(marker.length - 1, s.length);
  for (let k = max; k > 0; k--) {
    if (s.endsWith(marker.slice(0, k))) return s.length - k;
  }
  return s.length;
}
