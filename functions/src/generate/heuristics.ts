/**
 * Pure helpers for the generation pipeline — extracted from the endpoint so
 * they can be unit-tested without an HTTP harness.
 */
import type { ParsedFile } from './markerParser.js';

/**
 * The chat message is intro PROSE only. If a reset/continuation caused file
 * content to leak into the prose stream, cut from the first UNAMBIGUOUS leak
 * signature onward. Deliberately conservative: normal prose — bullet lists,
 * inline code mentions, multi-paragraph text — must survive untouched; only
 * clear file-content markers trigger a cut.
 */
export function sanitizeChatProse(text: string): string {
  let s = text.trim();
  const signatures: RegExp[] = [
    /<\/?file[\s>]/, // <file ...> or </file> marker
    /(^|\n)\s*<!DOCTYPE/i, // document start
    /(^|\n)\s*<(html|head|body)\b/i, // top-level document tags
    /(^|\n)\s*[\w.\-/]+\.(js|css|html|json|ts|svg|mjs)"\s*>/i, // tag remnant: styles.css">
  ];
  let cut = s.length;
  for (const p of signatures) {
    const m = p.exec(s);
    if (m) cut = Math.min(cut, m.index === 0 ? 0 : m.index + (m[1] ? m[1].length : 0));
  }
  s = s.slice(0, cut).trim();
  if (s.length > 1500) s = s.slice(0, 1500).trim() + '…';
  return s;
}

/**
 * Local files referenced by an HTML file (script src / link href) that were
 * NOT generated — indicates a broken app (e.g. index.html links ./app.js but
 * app.js is missing). Used to auto-continue and fill the gap.
 */
export function findMissingReferencedFiles(files: ParsedFile[]): string[] {
  const present = new Set(files.filter((f) => f.op !== 'delete').map((f) => f.path));
  const referenced = new Set<string>();
  for (const f of files) {
    if (f.op === 'delete' || !/\.html?$/i.test(f.path)) continue;
    const re = /(?:src|href)\s*=\s*["']([^"']+)["']/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(f.content)) !== null) {
      let ref = m[1].trim();
      if (/^(https?:|data:|blob:|#|mailto:|tel:|\/\/)/i.test(ref)) continue; // external
      ref = ref.replace(/^\.?\//, '').split(/[?#]/)[0]; // normalise ./x, /x, strip query/hash
      if (ref && /\.(js|css)$/i.test(ref) && !present.has(ref)) referenced.add(ref);
    }
  }
  return [...referenced];
}

/** Whether a stream error looks like a transient/connection failure worth resuming. */
export function isTransient(detail?: string): boolean {
  if (!detail) return true; // unknown mid-stream failure → assume resumable
  const d = detail.toLowerCase();
  return [
    'terminated',
    'econnreset',
    'reset',
    'fetch failed',
    'network',
    'socket',
    'timeout',
    'enotfound',
    'eai_again',
    'unavailable',
    'overloaded',
    '503',
    '502',
    '500',
  ].some((s) => d.includes(s));
}
