import { describe, expect, it } from 'vitest';
import { applyOps, validateOps } from './fileOps.js';

const write = (path: string, content = 'x') => ({ path, op: 'write' as const, content });

describe('validateOps — structural constraints on generated output', () => {
  it('accepts ordinary static web files', () => {
    const { ops, errors } = validateOps([
      write('index.html'),
      write('styles/main.css'),
      write('app.js'),
      write('data.json'),
    ]);
    expect(errors).toEqual([]);
    expect(ops).toHaveLength(4);
  });

  it('rejects dotfiles anywhere in the path', () => {
    const { ops, errors } = validateOps([write('.env'), write('conf/.htaccess')]);
    expect(ops).toHaveLength(0);
    expect(errors).toHaveLength(2);
  });

  it('rejects disallowed file types and extensionless files', () => {
    const { ops, errors } = validateOps([
      write('run.sh'),
      write('binary.exe'),
      write('Makefile'),
    ]);
    expect(ops).toHaveLength(0);
    expect(errors).toHaveLength(3);
  });

  it('rejects traversal and absolute paths', () => {
    const { ops } = validateOps([write('../escape.js'), write('/etc/passwd.txt')]);
    expect(ops).toHaveLength(0);
  });

  it('rejects an oversized file', () => {
    const { ops, errors } = validateOps([write('big.js', 'a'.repeat(200_001))]);
    expect(ops).toHaveLength(0);
    expect(errors[0]).toMatch(/big.js/);
  });

  it('last write wins for duplicate paths', () => {
    const { ops } = validateOps([write('a.js', 'first'), write('a.js', 'second')]);
    expect(ops).toHaveLength(1);
    expect(ops[0].content).toBe('second');
  });
});

describe('applyOps', () => {
  it('write/delete update the working set', () => {
    const { next } = applyOps(
      { 'old.js': '1' },
      [write('new.js', '2'), { path: 'old.js', op: 'delete', content: '' }],
    );
    expect(next).toEqual({ 'new.js': '2' });
  });

  it('edit to a missing file is skipped with a warning', () => {
    const { next, warnings } = applyOps({}, [{ path: 'ghost.js', op: 'edit', content: 'junk' }]);
    expect(next).toEqual({});
    expect(warnings[0]).toMatch(/ghost.js/);
  });
});
