import { describe, expect, it } from 'vitest';
import { hashContent, planBlobs } from './contentStore.js';

describe('hashContent', () => {
  it('is deterministic and content-sensitive', () => {
    expect(hashContent('hello')).toBe(hashContent('hello'));
    expect(hashContent('hello')).not.toBe(hashContent('hello!'));
    expect(hashContent('hello')).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('planBlobs — the delta that makes snapshots cheap', () => {
  const files = { 'index.html': '<h1>Hi</h1>', 'app.js': 'boot()', 'styles.css': 'body{}' };

  it('first snapshot (no parent): every unique content is written', () => {
    const plan = planBlobs(files, undefined);
    expect(plan.entries).toHaveLength(3);
    expect(plan.toWrite).toHaveLength(3);
  });

  it('unchanged files cost ZERO writes on the next snapshot', () => {
    const first = planBlobs(files, undefined);
    const second = planBlobs({ ...files, 'app.js': 'boot(); fix()' }, first.entries);
    expect(second.entries).toHaveLength(3); // manifest always covers everything
    expect(second.toWrite).toHaveLength(1); // only the edited file is written
    expect(second.toWrite[0].content).toBe('boot(); fix()');
  });

  it('a renamed file reuses its blob (dedup is by content, not path)', () => {
    const first = planBlobs(files, undefined);
    const renamed = { 'index.html': files['index.html'], 'main.js': files['app.js'], 'styles.css': files['styles.css'] };
    const second = planBlobs(renamed, first.entries);
    expect(second.toWrite).toHaveLength(0); // nothing new to store
    expect(second.entries.find((e) => e.path === 'main.js')?.hash).toBe(
      first.entries.find((e) => e.path === 'app.js')?.hash,
    );
  });

  it('identical content in two paths is stored once', () => {
    const plan = planBlobs({ 'a.css': 'body{}', 'b.css': 'body{}' }, undefined);
    expect(plan.entries).toHaveLength(2);
    expect(plan.toWrite).toHaveLength(1);
    expect(plan.entries[0].hash).toBe(plan.entries[1].hash);
  });

  it('a restore-style snapshot (same files as an ancestor) writes nothing', () => {
    const first = planBlobs(files, undefined);
    const again = planBlobs(files, first.entries);
    expect(again.toWrite).toHaveLength(0);
  });
});
