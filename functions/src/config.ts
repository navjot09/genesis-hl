/**
 * Centralised configuration for Cloud Functions.
 *
 * Secrets (defineSecret) are backed by Cloud Secret Manager in production and by
 * functions/.secret.local in the emulator. Read them with `.value()` INSIDE a
 * handler (never at module load) and bind them via the function's `secrets: [...]`.
 *
 * Non-secret params (defineString) are read from functions/.env (+ .env.<project>).
 */
import { defineSecret, defineString } from 'firebase-functions/params';

// --- Secrets ---------------------------------------------------------------
export const GEMINI_API_KEY = defineSecret('GEMINI_API_KEY');
export const HL_CLIENT_SECRET = defineSecret('HL_CLIENT_SECRET');
/** HS256 key used to sign short-lived "preview capability" tokens for the iframe. */
export const PREVIEW_TOKEN_SECRET = defineSecret('PREVIEW_TOKEN_SECRET');

// --- Non-secret config -----------------------------------------------------
export const LLM_PROVIDER = defineString('LLM_PROVIDER', { default: 'gemini' });
export const GEMINI_MODEL = defineString('GEMINI_MODEL', { default: 'gemini-flash-latest' });
export const GEMINI_MODEL_HEAVY = defineString('GEMINI_MODEL_HEAVY', { default: 'gemini-pro-latest' });

export const HL_CLIENT_ID = defineString('HL_CLIENT_ID', { default: '' });
export const HL_REDIRECT_URI = defineString('HL_REDIRECT_URI', { default: '' });
export const HL_SCOPES = defineString('HL_SCOPES', { default: '' });

/**
 * HighLevel service hosts. Overridable so the full OAuth + proxy pipeline can be
 * integration-tested against a local mock server before real credentials exist.
 */
export const HL_API_BASE = defineString('HL_API_BASE', {
  default: 'https://services.leadconnectorhq.com',
});
export const HL_AUTHORIZE_BASE = defineString('HL_AUTHORIZE_BASE', {
  default: 'https://marketplace.leadconnectorhq.com',
});

/** SPA origin — used to redirect back after OAuth and as the allowed CORS origin. */
export const APP_BASE_URL = defineString('APP_BASE_URL', { default: 'http://127.0.0.1:5173' });

// --- Constants -------------------------------------------------------------
export const DEFAULT_REGION = 'us-central1';
