/**
 * Search/replace ("diff") edit application for op="edit" file blocks.
 *
 * The model emits, for a small change to an existing file, one or more hunks:
 *
 *   <<<<<<< SEARCH
 *   (exact existing lines)
 *   =======
 *   (replacement lines)
 *   >>>>>>> REPLACE
 *
 * We apply each hunk to the current file content. This keeps small edits tiny
 * and fast (only the changed snippet is generated) instead of re-emitting the
 * whole file. Matching is exact first, then whitespace-tolerant as a fallback.
 */

export interface EditBlock {
  search: string;
  replace: string;
}

export interface ApplyResult {
  result: string;
  applied: number;
  failed: number;
}

const HUNK_RE =
  /<{5,}\s*SEARCH\s*\r?\n([\s\S]*?)\r?\n?={5,}\s*\r?\n([\s\S]*?)\r?\n?>{5,}\s*REPLACE/g;

/** Parse SEARCH/REPLACE hunks from an op="edit" block's content. */
export function parseEditBlocks(content: string): EditBlock[] {
  const blocks: EditBlock[] = [];
  let m: RegExpExecArray | null;
  HUNK_RE.lastIndex = 0;
  while ((m = HUNK_RE.exec(content)) !== null) {
    blocks.push({ search: m[1], replace: m[2] });
  }
  return blocks;
}

/** Right-trim each line — tolerates trailing-whitespace drift between model + file. */
function normalizeTrailing(s: string): string {
  return s
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n');
}

/**
 * Find `search` in `text`, returning [start, end) in ORIGINAL text coordinates.
 * Tries exact match, then a trailing-whitespace-normalized match.
 */
function locate(text: string, search: string): [number, number] | null {
  const exact = text.indexOf(search);
  if (exact !== -1) return [exact, exact + search.length];

  // Whitespace-tolerant: match on normalized text, then map the end back by
  // walking the original text over the same number of normalized chars.
  const normText = normalizeTrailing(text);
  const normSearch = normalizeTrailing(search);
  if (normSearch === '') return null;
  const nIdx = normText.indexOf(normSearch);
  if (nIdx === -1) return null;

  // Map normalized [nIdx, nIdx+len) back to original indices. normalizeTrailing
  // only removes trailing spaces/tabs before newlines, so we can walk in step.
  const mapNormToOrig = (targetNormPos: number): number => {
    let orig = 0;
    let norm = 0;
    while (norm < targetNormPos && orig < text.length) {
      const ch = text[orig];
      const isTrimmedWs =
        (ch === ' ' || ch === '\t') && isTrailingWhitespaceAt(text, orig);
      const isCr = ch === '\r' && text[orig + 1] === '\n';
      if (isTrimmedWs || isCr) {
        orig++; // consumed in original, absent in normalized
      } else {
        orig++;
        norm++;
      }
    }
    return orig;
  };
  const start = mapNormToOrig(nIdx);
  const end = mapNormToOrig(nIdx + normSearch.length);
  return [start, end];
}

/** True if the whitespace char at `i` is trailing (only ws until the next \n/eof). */
function isTrailingWhitespaceAt(text: string, i: number): boolean {
  for (let j = i; j < text.length; j++) {
    const c = text[j];
    if (c === '\n') return true;
    if (c !== ' ' && c !== '\t' && c !== '\r') return false;
  }
  return true;
}

/** Apply all hunks to `original`, in order, first-occurrence each. */
export function applyEditBlocks(original: string, blocks: EditBlock[]): ApplyResult {
  let result = original;
  let applied = 0;
  let failed = 0;
  for (const b of blocks) {
    if (b.search === '') {
      failed++;
      continue;
    }
    const at = locate(result, b.search);
    if (at) {
      result = result.slice(0, at[0]) + b.replace + result.slice(at[1]);
      applied++;
    } else {
      failed++;
    }
  }
  return { result, applied, failed };
}
