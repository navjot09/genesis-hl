/** Firebase ID-token verification for onRequest endpoints. */
import type { Request } from 'firebase-functions/v2/https';
import { adminAuth } from './admin.js';

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

export function bearerToken(req: Request): string | null {
  const header = req.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1] : null;
}

/** Verify the Authorization: Bearer <Firebase ID token> header → uid. */
export async function requireFirebaseUser(req: Request): Promise<{ uid: string }> {
  const token = bearerToken(req);
  if (!token) throw new AuthError('Missing Authorization bearer token');
  try {
    const decoded = await adminAuth.verifyIdToken(token);
    return { uid: decoded.uid };
  } catch {
    throw new AuthError('Invalid or expired Firebase ID token');
  }
}
