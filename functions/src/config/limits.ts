/**
 * Every tuning knob in one place, each with its rationale. Values here are
 * POLICY — reviewable at a glance — not implementation detail scattered
 * across call sites.
 */
export const LIMITS = {
  /** LLM-spend cap: generations per user per hour. */
  generationsPerHour: 20,
  /** Blast-radius cap for side-effecting HL calls (sends/writes) per user/min. */
  hlWritesPerMinute: 15,
  /** Webhook events stored per location per minute (HL emits far fewer). */
  webhookIngestPerMinute: 120,

  /** Max output tokens per Gemini attempt (continuations extend the total). */
  maxOutputTokens: 32_000,
  /** Resume attempts after interruptions before giving up. */
  maxContinuations: 6,
  /** A silent LLM stream (no chunks for this long) is treated as dropped. */
  llmStallMs: 60_000,
  /** Cap on the sanitized chat intro persisted per generation. */
  chatProseMaxChars: 1_500,

  /** Per-file content cap (Firestore doc limit is 1MB; stay well under). */
  maxFileBytes: 200_000,
  /** Whole-project content cap per generation. */
  maxTotalBytes: 1_500_000,
  /** File-count cap per generation. */
  maxFiles: 40,

  /** Touch the job record at most this often while streaming (heartbeat). */
  jobHeartbeatMs: 20_000,
  /** Sweeper marks 'streaming' jobs failed after this much heartbeat silence. */
  jobSweepStaleMs: 15 * 60 * 1000,

  /** Wall-clock ceiling for one generation request (seconds). */
  generateTimeoutSeconds: 600,
  /** Concurrent streams per instance — LLM streams are long-lived; keep low. */
  generateConcurrency: 4,
} as const;

/** One rate-limit window definition per guarded action. */
export const RATE_WINDOWS = {
  generate: { limit: LIMITS.generationsPerHour, windowMs: 60 * 60 * 1000 },
  hlWrite: { limit: LIMITS.hlWritesPerMinute, windowMs: 60 * 1000 },
  webhookIngest: { limit: LIMITS.webhookIngestPerMinute, windowMs: 60 * 1000 },
} as const;
