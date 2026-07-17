/**
 * Preview capability tokens.
 *
 * The generated app runs in a sandboxed iframe and must never hold the real HL
 * OAuth token. Instead the workspace mints a short-lived, single-location JWT
 * ("capability token") that only the /hlProxy endpoint accepts. It is useless
 * against HighLevel directly.
 */
import jwt from 'jsonwebtoken';
import { PREVIEW_TOKEN_SECRET } from '../config.js';
import { PREVIEW_TOKEN_TTL_S } from '../hl/constants.js';

const AUDIENCE = 'genesis-preview';

export interface PreviewClaims {
  uid: string;
  locationId: string;
}

export function mintPreviewJwt(claims: PreviewClaims): { token: string; expiresAt: number } {
  const token = jwt.sign(
    { locationId: claims.locationId },
    PREVIEW_TOKEN_SECRET.value(),
    {
      algorithm: 'HS256',
      subject: claims.uid,
      audience: AUDIENCE,
      expiresIn: PREVIEW_TOKEN_TTL_S,
    },
  );
  return { token, expiresAt: Date.now() + PREVIEW_TOKEN_TTL_S * 1000 };
}

/** Returns the claims if `token` is a valid, unexpired preview JWT; else null. */
export function verifyPreviewJwt(token: string): PreviewClaims | null {
  try {
    const decoded = jwt.verify(token, PREVIEW_TOKEN_SECRET.value(), {
      algorithms: ['HS256'],
      audience: AUDIENCE,
    }) as jwt.JwtPayload;
    if (!decoded.sub || typeof decoded.locationId !== 'string') return null;
    return { uid: decoded.sub, locationId: decoded.locationId };
  } catch {
    return null;
  }
}
