/**
 * Bypass the SDK entirely: raw REST call to the Gemini Developer API with
 * toolConfig.functionCallingConfig.streamFunctionCallArguments = true.
 * Answers definitively whether the API (not just the SDK) supports it on an
 * ordinary API key: rejects the field / ignores it / streams partialArgs.
 */
import { readFileSync } from 'node:fs';

const secrets = readFileSync('functions/.secret.local', 'utf8');
const apiKey = secrets.match(/^GEMINI_API_KEY=(.+)$/m)?.[1]?.trim();
const MODEL = process.env.MODEL || 'gemini-flash-latest';
const API = process.env.API_VERSION || 'v1beta';

const body = {
  contents: [
    {
      role: 'user',
      parts: [
        {
          text: 'Say one short intro sentence, then use write_file to create index.html (tiny page with an <h1>) and app.js (a console.log). One call per file.',
        },
      ],
    },
  ],
  tools: [
    {
      functionDeclarations: [
        {
          name: 'write_file',
          description: 'Create or fully overwrite one file of the app.',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              content: { type: 'string' },
            },
            required: ['path', 'content'],
          },
        },
      ],
    },
  ],
  toolConfig: {
    functionCallingConfig: {
      streamFunctionCallArguments: true,
    },
  },
  generationConfig: { maxOutputTokens: 2000 },
};

const url = `https://generativelanguage.googleapis.com/${API}/models/${MODEL}:streamGenerateContent?alt=sse&key=${apiKey}`;
console.log(`POST ${API}/models/${MODEL}:streamGenerateContent (raw REST, flag ON)`);
const res = await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
console.log('HTTP', res.status);

if (!res.ok) {
  const err = await res.text();
  console.log('ERROR BODY:', err.slice(0, 800));
  process.exit(0);
}

const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = '';
let sawPartial = false;
let complete = 0;
for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  let idx;
  while ((idx = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line.startsWith('data:')) continue;
    const chunk = JSON.parse(line.slice(5));
    for (const p of chunk.candidates?.[0]?.content?.parts ?? []) {
      if (p.text) console.log('TEXT:', JSON.stringify(p.text.slice(0, 50)));
      if (p.functionCall) {
        const fc = p.functionCall;
        if (fc.partialArgs || fc.willContinue !== undefined) {
          sawPartial = true;
          console.log(
            'FC-PARTIAL:',
            fc.name,
            'willContinue=', fc.willContinue,
            JSON.stringify(fc.partialArgs)?.slice(0, 120),
          );
        } else {
          complete++;
          console.log(
            'FC-COMPLETE:',
            fc.name,
            'path=', fc.args?.path,
            'content.len=', String(fc.args?.content ?? '').length,
          );
        }
      }
    }
  }
}
console.log(`\nVERDICT: API accepted the flag; partialArgs seen=${sawPartial}; complete calls=${complete}`);
if (!sawPartial && complete > 0) {
  console.log('=> The API silently IGNORES the flag on this key/API version: calls still arrive whole.');
}
