// Isolate the "terminated" mid-stream error: stream a long Gemini generation directly.
import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const model = process.env.GEMINI_MODEL || 'gemini-flash-latest';

const prompt =
  'Write a very detailed 2500-word technical essay about building a streaming code generator. Be thorough and long.';

console.log('model:', model);
let chunks = 0;
let chars = 0;
const t0 = Date.now();
try {
  const stream = await ai.models.generateContentStream({
    model,
    contents: prompt,
    config: { maxOutputTokens: 30000 },
  });
  for await (const chunk of stream) {
    const t = chunk.text;
    if (t) {
      chunks++;
      chars += t.length;
      if (chunks % 25 === 0) process.stdout.write(`  [${chunks} chunks, ${chars} chars, ${((Date.now() - t0) / 1000).toFixed(1)}s]\n`);
    }
    const fr = chunk.candidates?.[0]?.finishReason;
    if (fr) console.log('finishReason:', fr);
  }
  console.log(`DONE: ${chunks} chunks, ${chars} chars in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
} catch (e) {
  console.log(`\nERROR after ${chunks} chunks / ${chars} chars / ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log('  message:', e?.message);
  console.log('  cause:', e?.cause?.message || e?.cause);
  console.log('  name:', e?.name);
}
