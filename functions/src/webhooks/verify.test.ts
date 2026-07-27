import { describe, expect, it } from 'vitest';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { verifyHlSignature } from './verify.js';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const { publicKey: otherPublic } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherPem = otherPublic.export({ type: 'spki', format: 'pem' }).toString();

function sign(body: string): string {
  const s = createSign('RSA-SHA256');
  s.update(body);
  s.end();
  return s.sign(privateKey, 'base64');
}

describe('verifyHlSignature', () => {
  const body = JSON.stringify({ type: 'ContactCreate', locationId: 'loc123' });

  it('accepts a valid signature over the exact raw body', () => {
    expect(verifyHlSignature(body, sign(body), publicPem)).toBe(true);
    expect(verifyHlSignature(Buffer.from(body), sign(body), publicPem)).toBe(true);
  });

  it('rejects a tampered body (even one character)', () => {
    const tampered = body.replace('loc123', 'loc124');
    expect(verifyHlSignature(tampered, sign(body), publicPem)).toBe(false);
  });

  it('rejects a signature from the wrong key', () => {
    expect(verifyHlSignature(body, sign(body), otherPem)).toBe(false);
  });

  it('rejects missing/garbage inputs without crashing', () => {
    expect(verifyHlSignature(body, '', publicPem)).toBe(false);
    expect(verifyHlSignature(body, 'not-base64!!!', publicPem)).toBe(false);
    expect(verifyHlSignature(body, sign(body), 'not a pem')).toBe(false);
  });
});
