/**
 * HighLevel webhook signature verification.
 *
 * HL signs each webhook delivery: header `x-wh-signature` carries a base64
 * RSA-SHA256 signature over the RAW request body, verifiable with HighLevel's
 * published webhook public key (Developer docs → Webhooks). With the key
 * configured, forged events are rejected outright — the known-location gate
 * then only guards routing, not authenticity.
 */
import { createVerify } from 'node:crypto';

export function verifyHlSignature(
  rawBody: Buffer | string,
  signatureB64: string,
  publicKeyPem: string,
): boolean {
  if (!signatureB64 || !publicKeyPem) return false;
  try {
    const verifier = createVerify('RSA-SHA256');
    verifier.update(rawBody);
    verifier.end();
    return verifier.verify(publicKeyPem, signatureB64, 'base64');
  } catch {
    return false; // malformed key/signature is a failed verification, not a crash
  }
}
