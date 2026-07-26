import { describe, expect, it } from 'vitest';
import { findMissingReferencedFiles, isTransient, sanitizeChatProse } from './heuristics.js';

describe('sanitizeChatProse', () => {
  it('keeps normal single-sentence intros', () => {
    const s = "I'll build a contact manager with search and a detail pane.";
    expect(sanitizeChatProse(s)).toBe(s);
  });

  it('keeps bullet lists — the standard way models summarize work', () => {
    const s = 'I built:\n* A navbar\n* A contact form\n* Search';
    expect(sanitizeChatProse(s)).toBe(s);
  });

  it('keeps prose that mentions code keywords', () => {
    const s = 'const is used for the config values, and the app polls every 5s.';
    expect(sanitizeChatProse(s)).toBe(s);
  });

  it('keeps multi-paragraph prose (blank lines are not a leak signal)', () => {
    const s = 'First paragraph.\n\n\nSecond paragraph after a gap.';
    expect(sanitizeChatProse(s)).toBe(s);
  });

  it('cuts at a leaked <file> marker', () => {
    expect(sanitizeChatProse('Here you go!\n<file path="a.js">let x=1')).toBe('Here you go!');
  });

  it('cuts at a leaked closing tag', () => {
    expect(sanitizeChatProse('Done.\n</file> trailing junk')).toBe('Done.');
  });

  it('cuts at a leaked document start', () => {
    expect(sanitizeChatProse('Building now.\n<!DOCTYPE html><html>')).toBe('Building now.');
  });

  it('cuts at a filename tag remnant like styles.css">', () => {
    expect(sanitizeChatProse('Updated styling.\nstyles.css">\nbody { margin: 0 }')).toBe(
      'Updated styling.',
    );
  });

  it('caps runaway prose at ~1500 chars', () => {
    const out = sanitizeChatProse('a'.repeat(5000));
    expect(out.length).toBeLessThanOrEqual(1501);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('findMissingReferencedFiles', () => {
  const html = (body: string) => ({ path: 'index.html', op: 'write' as const, content: body });

  it('reports local js/css referenced but not generated', () => {
    const files = [html('<script src="./app.js"></script><link href="styles.css">')];
    expect(findMissingReferencedFiles(files).sort()).toEqual(['app.js', 'styles.css']);
  });

  it('does not report files that were generated', () => {
    const files = [
      html('<script src="app.js"></script>'),
      { path: 'app.js', op: 'write' as const, content: '// ok' },
    ];
    expect(findMissingReferencedFiles(files)).toEqual([]);
  });

  it('ignores external, data and anchor references', () => {
    const files = [
      html('<script src="https://cdn.x/y.js"></script><a href="#top">t</a><img src="data:image/png;base64,x">'),
    ];
    expect(findMissingReferencedFiles(files)).toEqual([]);
  });

  it('treats a deleted file as missing if still referenced', () => {
    const files = [
      html('<script src="app.js"></script>'),
      { path: 'app.js', op: 'delete' as const, content: '' },
    ];
    expect(findMissingReferencedFiles(files)).toEqual(['app.js']);
  });
});

describe('isTransient', () => {
  it('treats connection resets and 5xx as resumable', () => {
    expect(isTransient('TypeError: terminated')).toBe(true);
    expect(isTransient('read ECONNRESET')).toBe(true);
    expect(isTransient('HTTP 503 Service Unavailable')).toBe(true);
  });

  it('treats unknown mid-stream failures as resumable by default', () => {
    expect(isTransient(undefined)).toBe(true);
  });

  it('does not resume on clearly non-transient errors', () => {
    expect(isTransient('API key not valid')).toBe(false);
    expect(isTransient('permission denied')).toBe(false);
  });
});
