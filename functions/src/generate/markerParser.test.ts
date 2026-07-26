import { describe, it, expect } from 'vitest';
import { MarkerParser, type ParserEvent } from './markerParser.js';

/** Run the parser over the input (optionally char-by-char), collecting events. */
function parse(input: string, opts: { charByChar?: boolean } = {}) {
  const events: ParserEvent[] = [];
  const parser = new MarkerParser((e) => events.push(e));
  if (opts.charByChar) {
    for (const ch of input) parser.feed(ch);
  } else {
    parser.feed(input);
  }
  parser.end();
  return { parser, events };
}

function proseText(events: ParserEvent[]): string {
  return events
    .filter((e): e is Extract<ParserEvent, { type: 'prose' }> => e.type === 'prose')
    .map((e) => e.text)
    .join('');
}

function deltaText(events: ParserEvent[], path: string): string {
  return events
    .filter(
      (e): e is Extract<ParserEvent, { type: 'file_delta' }> =>
        e.type === 'file_delta' && e.path === path,
    )
    .map((e) => e.text)
    .join('');
}

describe('MarkerParser basics', () => {
  it('captures file content exactly and fires file_open/file_delta/file_close', () => {
    const content = 'const x = 1;\nconsole.log(x);\n';
    const { parser, events } = parse(`<file path="a.js">${content}</file>`);

    expect(events.some((e) => e.type === 'file_open' && e.path === 'a.js' && e.op === 'write')).toBe(true);
    expect(deltaText(events, 'a.js')).toBe(content);
    expect(events.some((e) => e.type === 'file_close' && e.path === 'a.js')).toBe(true);
    expect(parser.files).toEqual([{ path: 'a.js', op: 'write', content }]);
  });

  it('emits prose before and after a file as prose events', () => {
    const { parser, events } = parse('before \n<file path="a.js">body</file>\n after');
    expect(proseText(events)).toBe('before \n\n after');
    expect(parser.files).toEqual([{ path: 'a.js', op: 'write', content: 'body' }]);
  });

  it('parses multiple files in one stream independently', () => {
    const { parser } = parse(
      'intro\n<file path="a.js">aaa</file>\nmiddle\n<file path="b.css">bbb</file>\noutro',
    );
    expect(parser.files).toEqual([
      { path: 'a.js', op: 'write', content: 'aaa' },
      { path: 'b.css', op: 'write', content: 'bbb' },
    ]);
  });

  it('parses op="edit"', () => {
    const { parser } = parse('<file path="a.js" op="edit">patched</file>');
    expect(parser.files).toEqual([{ path: 'a.js', op: 'edit', content: 'patched' }]);
  });

  it('parses op="delete" with an empty body', () => {
    const { parser } = parse('<file path="old.js" op="delete"></file>');
    expect(parser.files).toEqual([{ path: 'old.js', op: 'delete', content: '' }]);
  });
});

describe('streaming boundary safety', () => {
  it('char-by-char feeding yields identical files to one big feed', () => {
    const input =
      'prose before\n<file path="a.js">let a = "<";\n</file>\nbetween\n' +
      '<file path="b.js" op="edit">b</file>\n<file path="c.js" op="delete"></file>\ntail';
    const whole = parse(input);
    const chars = parse(input, { charByChar: true });
    expect(chars.parser.files).toEqual(whole.parser.files);
    expect(chars.parser.files).toEqual([
      { path: 'a.js', op: 'write', content: 'let a = "<";\n' },
      { path: 'b.js', op: 'edit', content: 'b' },
      { path: 'c.js', op: 'delete', content: '' },
    ]);
    expect(proseText(chars.events)).toBe(proseText(whole.events));
    expect(deltaText(chars.events, 'a.js')).toBe(deltaText(whole.events, 'a.js'));
  });
});

describe('attribute robustness (desired behavior)', () => {
  it('parses a single-quoted path attribute', () => {
    const { parser } = parse("<file path='a.js'>hi</file>");
    expect(parser.files).toEqual([{ path: 'a.js', op: 'write', content: 'hi' }]);
  });

  it('parses reversed attribute order (op before path)', () => {
    const { parser } = parse('<file op="delete" path="old.js"></file>');
    expect(parser.files).toEqual([{ path: 'old.js', op: 'delete', content: '' }]);
  });
});

describe('malformed-tag recovery (desired behavior)', () => {
  it('a malformed tag does not swallow a later valid file', () => {
    const { parser } = parse(
      'oops\n<file path=broken>\nsome text\n<file path="good.js">ok</file>\n',
    );
    expect(parser.files).toContainEqual({ path: 'good.js', op: 'write', content: 'ok' });
  });
});

describe('known limitations', () => {
  // requires escaping protocol / function-calling migration
  it.skip('file content containing a literal </file> truncates', () => {
    const content = 'const tag = "</file>";\ndone();\n';
    const { parser } = parse(`<file path="a.js">${content}</file>`);
    expect(parser.files).toEqual([{ path: 'a.js', op: 'write', content }]);
  });
});

describe('completedPaths and resetInProgress', () => {
  it('completedPaths lists only fully-closed files, in order', () => {
    const parser = new MarkerParser(() => {});
    parser.feed('<file path="a.js">aaa');
    parser.feed('</file>');
    expect(parser.completedPaths()).toEqual(['a.js']);
    parser.feed('<file path="b.js">bb');
    expect(parser.completedPaths()).toEqual(['a.js']); // half-open file not counted
    parser.feed('b</file>');
    expect(parser.completedPaths()).toEqual(['a.js', 'b.js']);
  });

  it('resetInProgress drops a half-open file but keeps closed ones', () => {
    const parser = new MarkerParser(() => {});
    parser.feed('<file path="a.js">aaa');
    parser.feed('</file>');
    parser.feed('<file path="half.js">partial cont'); // file is now open, never closed
    parser.resetInProgress();
    // Continuation stream resumes from a clean file boundary.
    parser.feed('<file path="c.js">ccc');
    parser.feed('</file>');
    parser.end();
    expect(parser.files).toEqual([
      { path: 'a.js', op: 'write', content: 'aaa' },
      { path: 'c.js', op: 'write', content: 'ccc' },
    ]);
    expect(parser.completedPaths()).toEqual(['a.js', 'c.js']);
  });
});
