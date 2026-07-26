import { describe, it, expect } from 'vitest';
import { parseEditBlocks, applyEditBlocks } from './editApply.js';

const hunk = (search: string, replace: string) =>
  `<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>> REPLACE`;

describe('parseEditBlocks', () => {
  it('parses a single SEARCH/REPLACE hunk', () => {
    expect(parseEditBlocks(hunk('old line', 'new line'))).toEqual([
      { search: 'old line', replace: 'new line' },
    ]);
  });

  it('parses multiple hunks in order', () => {
    const content = hunk('a', 'A') + '\n' + hunk('b', 'B');
    expect(parseEditBlocks(content)).toEqual([
      { search: 'a', replace: 'A' },
      { search: 'b', replace: 'B' },
    ]);
  });

  it('returns [] when content has no hunks', () => {
    expect(parseEditBlocks('just some prose, no markers here')).toEqual([]);
  });
});

describe('applyEditBlocks — basic application', () => {
  it('replaces a unique exact match and leaves the rest untouched', () => {
    const src = 'const a = 1;\nconst b = 2;\nconst c = 3;\n';
    const r = applyEditBlocks(src, [{ search: 'const b = 2;', replace: 'const b = 20;' }]);
    expect(r.result).toBe('const a = 1;\nconst b = 20;\nconst c = 3;\n');
    expect(r.applied).toBe(1);
    expect(r.failed).toBe(0);
  });

  it('fails a hunk with an empty search', () => {
    const src = 'hello\nworld\n';
    const r = applyEditBlocks(src, [{ search: '', replace: 'injected' }]);
    expect(r.result).toBe(src);
    expect(r.applied).toBe(0);
    expect(r.failed).toBe(1);
  });
});

describe('applyEditBlocks — uniqueness', () => {
  it('fails (does not silently patch first occurrence) when search matches more than once', () => {
    const src = 'if (x) {\n  log();\n}\nif (y) {\n  log();\n}\n';
    const r = applyEditBlocks(src, [{ search: '  log();', replace: '  trace();' }]);
    expect(r.applied).toBe(0);
    expect(r.failed).toBe(1);
    expect(r.result).toBe(src);
  });
});

describe('applyEditBlocks — line anchoring', () => {
  it('does not match mid-word: "count = 1;" must not match inside "account = 1;"', () => {
    const src = 'account = 1;\ncount = 1;\n';
    const r = applyEditBlocks(src, [{ search: 'count = 1;', replace: 'count = 2;' }]);
    expect(r.result).toBe('account = 1;\ncount = 2;\n');
    expect(r.applied).toBe(1);
    expect(r.failed).toBe(0);
  });

  it('never splices mid-line on a leading-indent mismatch (no 6-space corruption)', () => {
    const src = 'function f() {\n    return 1;\n}\n';
    const r = applyEditBlocks(src, [{ search: '  return 1;', replace: '    return 2;' }]);
    // Acceptable outcomes: whole-line whitespace-tolerant match, or a clean failure.
    // Never a mid-line splice leaving a 6-space-indented line.
    expect(r.result).not.toContain('      return 2;');
    expect([src, 'function f() {\n    return 2;\n}\n']).toContain(r.result);
    if (r.result === src) {
      expect(r.applied).toBe(0);
      expect(r.failed).toBe(1);
    } else {
      expect(r.applied).toBe(1);
      expect(r.failed).toBe(0);
    }
  });
});

describe('applyEditBlocks — whitespace tolerance', () => {
  it('matches when file lines carry trailing whitespace the search lacks', () => {
    const src = 'const a = 1;  \nconst b = 2;\n';
    const r = applyEditBlocks(src, [
      { search: 'const a = 1;\nconst b = 2;', replace: 'const a = 9;\nconst b = 2;' },
    ]);
    expect(r.result).toBe('const a = 9;\nconst b = 2;\n');
    expect(r.applied).toBe(1);
    expect(r.failed).toBe(0);
  });

  it('matches when search lines carry trailing whitespace the file lacks', () => {
    const src = 'let x = 1;\nlet y = 2;\n';
    const r = applyEditBlocks(src, [{ search: 'let x = 1;  ', replace: 'let x = 3;' }]);
    expect(r.result).toBe('let x = 3;\nlet y = 2;\n');
    expect(r.applied).toBe(1);
    expect(r.failed).toBe(0);
  });
});

describe('applyEditBlocks — sequential hunks', () => {
  it('applies two hunks touching different parts of the file', () => {
    const src = 'const a = 1;\nconst b = 2;\nconst c = 3;\n';
    const r = applyEditBlocks(src, [
      { search: 'const a = 1;', replace: 'const a = 10;' },
      { search: 'const c = 3;', replace: 'const c = 30;' },
    ]);
    expect(r.result).toBe('const a = 10;\nconst b = 2;\nconst c = 30;\n');
    expect(r.applied).toBe(2);
    expect(r.failed).toBe(0);
  });

  it('lets a later hunk match text produced by an earlier replacement', () => {
    const src = 'let total = start;\n';
    const r = applyEditBlocks(src, [
      { search: 'let total = start;', replace: 'let total = begin;' },
      { search: 'let total = begin;', replace: 'let total = begin + 1;' },
    ]);
    expect(r.result).toBe('let total = begin + 1;\n');
    expect(r.applied).toBe(2);
    expect(r.failed).toBe(0);
  });
});

describe('applyEditBlocks — counts', () => {
  it('reports accurate applied/failed counts for a mixed batch', () => {
    const src = 'alpha\nbeta\n';
    const r = applyEditBlocks(src, [
      { search: 'alpha', replace: 'ALPHA' },
      { search: 'gamma', replace: 'GAMMA' },
      { search: 'beta', replace: 'BETA' },
    ]);
    expect(r.result).toBe('ALPHA\nBETA\n');
    expect(r.applied).toBe(2);
    expect(r.failed).toBe(1);
  });
});
