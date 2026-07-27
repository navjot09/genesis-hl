import { describe, expect, it } from 'vitest';
import type { GenerateParams, LlmStreamResult, LLMProvider } from '../llm/index.js';
import {
  buildContinuationMessages,
  decideResume,
  runGeneration,
  type EngineEvent,
} from './engine.js';

// ---------------------------------------------------------------------------
// FakeProvider: replays a script — each attempt emits deltas then returns a
// result. Records every params object so tests can assert what conversation
// each attempt was given.
// ---------------------------------------------------------------------------
interface ScriptedAttempt {
  deltas: string[];
  result: LlmStreamResult;
}

class FakeProvider implements LLMProvider {
  readonly name = 'fake';
  readonly calls: GenerateParams[] = [];
  private i = 0;
  constructor(private readonly script: ScriptedAttempt[]) {}

  async stream(
    params: GenerateParams,
    onDelta: (text: string) => void,
  ): Promise<LlmStreamResult> {
    const attempt = this.script[this.i++];
    if (!attempt) throw new Error(`FakeProvider: unscripted attempt #${this.i}`);
    this.calls.push(params);
    for (const d of attempt.deltas) onDelta(d);
    return attempt.result;
  }
}

const INPUT = {
  system: 'sys',
  baseMessages: [{ role: 'user' as const, content: 'build an app' }],
  model: 'fake-model',
  maxOutputTokens: 1000,
  maxContinuations: 6,
};

const ok = (text = ''): LlmStreamResult => ({ text, stopReason: 'stop' });
const run = (provider: FakeProvider, input = INPUT) => {
  const events: EngineEvent[] = [];
  return runGeneration(provider, input, (e) => events.push(e)).then((outcome) => ({
    outcome,
    events,
  }));
};

// ---------------------------------------------------------------------------
describe('decideResume (the continuation policy)', () => {
  const none: never[] = [];
  it('resumes after a length cut', () => {
    expect(decideResume({ text: '', stopReason: 'max_tokens' }, none, 0, 6).resume).toBe(true);
  });
  it('resumes after a transient connection error', () => {
    expect(
      decideResume({ text: '', stopReason: 'error', detail: 'TypeError: terminated' }, none, 0, 6)
        .resume,
    ).toBe(true);
  });
  it('does NOT resume a non-transient error (bad API key)', () => {
    expect(
      decideResume({ text: '', stopReason: 'error', detail: 'API key not valid' }, none, 0, 6)
        .resume,
    ).toBe(false);
  });
  it('resumes a RECITATION flag but not a safety block', () => {
    expect(
      decideResume({ text: '', stopReason: 'blocked', detail: 'RECITATION' }, none, 0, 6).resume,
    ).toBe(true);
    expect(
      decideResume({ text: '', stopReason: 'blocked', detail: 'SAFETY' }, none, 0, 6).resume,
    ).toBe(false);
  });
  it('resumes a clean stop ONLY when referenced files are missing', () => {
    const files = [
      { path: 'index.html', op: 'write' as const, content: '<script src="app.js"></script>' },
    ];
    expect(decideResume(ok(), files, 0, 6).resume).toBe(true);
    const complete = [...files, { path: 'app.js', op: 'write' as const, content: '//' }];
    expect(decideResume(ok(), complete, 0, 6).resume).toBe(false);
  });
  it('never resumes past the continuation budget', () => {
    expect(decideResume({ text: '', stopReason: 'max_tokens' }, none, 6, 6).resume).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('runGeneration (the loop)', () => {
  it('clean single attempt: prose + files stream through, ops validated', async () => {
    const provider = new FakeProvider([
      {
        deltas: [
          'Building your app!\n',
          '<file path="index.html">',
          '<h1>Hi</h1>',
          '</file>\n',
          '<file path="app.js">console.log(1)</file>',
        ],
        result: ok(),
      },
    ]);
    const { outcome, events } = await run(provider);

    expect(outcome.attempts).toBe(1);
    expect(outcome.streamFailed).toBe(false);
    expect(outcome.ops.map((o) => o.path)).toEqual(['index.html', 'app.js']);
    expect(outcome.assistantText).toContain('Building your app!');
    // Live events arrived, in order, per file.
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('assistant_delta');
    expect(types).toContain('file_open');
    expect(types.filter((t) => t === 'file_close')).toHaveLength(2);
  });

  it('mid-file drop: attempt 2 gets a clean continuation and the app completes', async () => {
    const provider = new FakeProvider([
      {
        // File A completes; file B is cut mid-content by a network reset.
        deltas: [
          'Here we go\n',
          '<file path="a.js">const a = 1;</file>\n',
          '<file path="b.js">const b = ',
        ],
        result: { text: '', stopReason: 'error', detail: 'TypeError: terminated' },
      },
      {
        deltas: ['Continuing!\n', '<file path="b.js">const b = 2;</file>'],
        result: ok(),
      },
    ]);
    const { outcome, events } = await run(provider);

    expect(outcome.attempts).toBe(2);
    expect(outcome.ops.map((o) => o.path).sort()).toEqual(['a.js', 'b.js']);
    // b.js was restarted fresh — its committed content is complete, not spliced.
    expect(outcome.ops.find((o) => o.path === 'b.js')).toMatchObject({
      content: 'const b = 2;',
    });

    // The continuation conversation replays the COMPLETED file and explains why.
    const attempt2 = provider.calls[1];
    const assistantTurn = attempt2.messages.find((m) => m.role === 'assistant');
    const lastUser = attempt2.messages[attempt2.messages.length - 1];
    expect(assistantTurn?.content).toContain('<file path="a.js">');
    expect(assistantTurn?.content).not.toContain('const b = '); // never the partial
    expect(lastUser.content).toContain('The connection dropped.');
    expect(lastUser.content).toContain('a.js');

    // Continuation intro prose is NOT captured (no jumbled chat message)…
    expect(outcome.assistantText).toContain('Here we go');
    expect(outcome.assistantText).not.toContain('Continuing!');
    // …and not emitted to the live view either.
    const proseText = events
      .filter((e) => e.type === 'assistant_delta')
      .map((e) => (e as { text: string }).text)
      .join('');
    expect(proseText).not.toContain('Continuing!');
  });

  it('max_tokens cut resumes and finishes', async () => {
    const provider = new FakeProvider([
      {
        deltas: ['<file path="a.js">done</file><file path="b.js">half'],
        result: { text: '', stopReason: 'max_tokens' },
      },
      { deltas: ['<file path="b.js">full</file>'], result: ok() },
    ]);
    const { outcome } = await run(provider);
    expect(outcome.attempts).toBe(2);
    expect(outcome.ops.find((o) => o.path === 'b.js')).toMatchObject({ content: 'full' });
    expect(provider.calls[1].messages.at(-1)?.content).toContain('length limit');
  });

  it('clean stop with a missing referenced file triggers a follow-up', async () => {
    const provider = new FakeProvider([
      {
        deltas: ['<file path="index.html"><script src="app.js"></script></file>'],
        result: ok(),
      },
      { deltas: ['<file path="app.js">boot()</file>'], result: ok() },
    ]);
    const { outcome } = await run(provider);
    expect(outcome.attempts).toBe(2);
    expect(outcome.ops.map((o) => o.path).sort()).toEqual(['app.js', 'index.html']);
    expect(provider.calls[1].messages.at(-1)?.content).toContain('app.js');
  });

  it('gives up after the continuation budget, keeping completed files', async () => {
    const dead: ScriptedAttempt = {
      deltas: [],
      result: { text: '', stopReason: 'error', detail: 'read ECONNRESET' },
    };
    const provider = new FakeProvider([
      {
        deltas: ['<file path="a.js">saved</file>'],
        result: { text: '', stopReason: 'error', detail: 'read ECONNRESET' },
      },
      dead,
      dead,
    ]);
    const { outcome } = await run(provider, { ...INPUT, maxContinuations: 2 });
    expect(outcome.attempts).toBe(3); // initial + 2 continuations, then stop
    expect(outcome.streamFailed).toBe(true);
    expect(outcome.ops.map((o) => o.path)).toEqual(['a.js']); // nothing lost
  });

  it('a safety block is terminal — no retry, partial kept', async () => {
    const provider = new FakeProvider([
      {
        deltas: ['<file path="a.js">fine</file>'],
        result: { text: '', stopReason: 'blocked', detail: 'SAFETY' },
      },
      // No second attempt scripted: a retry here would throw "unscripted".
    ]);
    const { outcome } = await run(provider);
    expect(outcome.attempts).toBe(1);
    expect(outcome.streamFailed).toBe(true);
    expect(outcome.ops).toHaveLength(1);
  });

  it('with zero completed files, the continuation replays the base conversation', () => {
    const messages = buildContinuationMessages(INPUT.baseMessages, [], 'The connection dropped.');
    expect(messages).toEqual(INPUT.baseMessages);
  });
});
