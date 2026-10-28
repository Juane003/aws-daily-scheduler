import { z } from 'zod';

/**
 * Runtime configuration, read from environment variables (CLAUDE.md §7).
 * Reference implementation: values are validated at startup so that a bad
 * deployment fails fast instead of misbehaving at 3 AM.
 */

const positiveInt = (defaultValue: number) =>
  z.coerce.number().int().positive().default(defaultValue);

const isValidTimeZone = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

const shardOverridesSchema = z
  .string()
  .optional()
  .transform((raw, ctx): Record<string, number> => {
    if (raw === undefined || raw.trim() === '') return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'PROVIDER_SHARDS_OVERRIDES must be valid JSON' });
      return z.NEVER;
    }
    const result = z.record(z.string(), z.number().int().positive()).safeParse(parsed);
    if (!result.success) {
      ctx.addIssue({
        code: 'custom',
        message: 'PROVIDER_SHARDS_OVERRIDES must map providerId to a positive integer',
      });
      return z.NEVER;
    }
    return result.data;
  });

const envSchema = z.object({
  BUSINESS_TZ: z
    .string()
    .default('UTC')
    .refine(isValidTimeZone, { message: 'BUSINESS_TZ must be a valid IANA time zone' }),
  LOOKBACK_SLOTS: z.coerce.number().int().min(0).max(60).default(5),
  PROVIDER_SHARDS_K: positiveInt(1),
  PROVIDER_SHARDS_OVERRIDES: shardOverridesSchema,
  HTTP_TIMEOUT_MS: positiveInt(10_000),
  WORKER_TIMEOUT_S: positiveInt(30),
  // Defaults to 6 × WORKER_TIMEOUT_S when not set explicitly.
  FIFO_VISIBILITY_TIMEOUT_S: z.coerce.number().int().positive().optional(),
  MAX_ATTEMPTS: positiveInt(8),
  RETRY_BASE_S: positiveInt(10),
  CB_FAILURE_THRESHOLD: positiveInt(5),
  CB_BASE_COOLDOWN_S: positiveInt(60),
  CB_MAX_COOLDOWN_S: positiveInt(900),
  STALE_AFTER_S: positiveInt(360),
  EXPIRY_GRACE_H: z.coerce.number().int().min(0).default(6),
  ENQUEUED_STALE_S: positiveInt(3 * 60 * 60),
  RECONCILE_MAX_REQUEUE: positiveInt(10_000),
  ESM_MAX_CONCURRENCY: z.coerce.number().int().min(2).max(1000).default(200),
  RESULT_INLINE_MAX_BYTES: positiveInt(262_144),
  RETENTION_MONTHS: positiveInt(13),
});

export interface Config {
  businessTz: string;
  lookbackSlots: number;
  providerShardsK: number;
  providerShardsOverrides: Readonly<Record<string, number>>;
  httpTimeoutMs: number;
  workerTimeoutS: number;
  fifoVisibilityTimeoutS: number;
  maxAttempts: number;
  retryBaseS: number;
  cbFailureThreshold: number;
  cbBaseCooldownS: number;
  cbMaxCooldownS: number;
  staleAfterS: number;
  expiryGraceH: number;
  enqueuedStaleS: number;
  reconcileMaxRequeue: number;
  esmMaxConcurrency: number;
  resultInlineMaxBytes: number;
  retentionMonths: number;
}

export class ConfigError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid configuration:\n- ${issues.join('\n- ')}`);
    this.name = 'ConfigError';
  }
}

/** Maximum delay supported by SQS DelaySeconds; retries and cooldowns are capped to it. */
export const SQS_MAX_DELAY_S = 900;

export function loadConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  const e = parsed.data;

  const config: Config = {
    businessTz: e.BUSINESS_TZ,
    lookbackSlots: e.LOOKBACK_SLOTS,
    providerShardsK: e.PROVIDER_SHARDS_K,
    providerShardsOverrides: e.PROVIDER_SHARDS_OVERRIDES,
    httpTimeoutMs: e.HTTP_TIMEOUT_MS,
    workerTimeoutS: e.WORKER_TIMEOUT_S,
    fifoVisibilityTimeoutS: e.FIFO_VISIBILITY_TIMEOUT_S ?? 6 * e.WORKER_TIMEOUT_S,
    maxAttempts: e.MAX_ATTEMPTS,
    retryBaseS: e.RETRY_BASE_S,
    cbFailureThreshold: e.CB_FAILURE_THRESHOLD,
    cbBaseCooldownS: e.CB_BASE_COOLDOWN_S,
    cbMaxCooldownS: e.CB_MAX_COOLDOWN_S,
    staleAfterS: e.STALE_AFTER_S,
    expiryGraceH: e.EXPIRY_GRACE_H,
    enqueuedStaleS: e.ENQUEUED_STALE_S,
    reconcileMaxRequeue: e.RECONCILE_MAX_REQUEUE,
    esmMaxConcurrency: e.ESM_MAX_CONCURRENCY,
    resultInlineMaxBytes: e.RESULT_INLINE_MAX_BYTES,
    retentionMonths: e.RETENTION_MONTHS,
  };

  const issues = validateInvariants(config);
  if (issues.length > 0) throw new ConfigError(issues);
  return Object.freeze(config);
}

/** Cross-field invariants that a per-variable schema cannot express. */
export function validateInvariants(c: Config): string[] {
  const issues: string[] = [];
  const workerTimeoutMs = c.workerTimeoutS * 1000;
  if (c.httpTimeoutMs >= workerTimeoutMs) {
    issues.push(
      `HTTP_TIMEOUT_MS (${c.httpTimeoutMs}) must be < WORKER_TIMEOUT_S (${c.workerTimeoutS}s)`,
    );
  }
  if (c.workerTimeoutS >= c.fifoVisibilityTimeoutS) {
    issues.push(
      `WORKER_TIMEOUT_S (${c.workerTimeoutS}) must be < FIFO visibility timeout (${c.fifoVisibilityTimeoutS}s)`,
    );
  }
  if (c.staleAfterS <= c.workerTimeoutS) {
    issues.push(
      `STALE_AFTER_S (${c.staleAfterS}) must be > WORKER_TIMEOUT_S (${c.workerTimeoutS}); otherwise a live Worker can be reclaimed`,
    );
  }
  if (c.cbBaseCooldownS > c.cbMaxCooldownS) {
    issues.push(
      `CB_BASE_COOLDOWN_S (${c.cbBaseCooldownS}) must be <= CB_MAX_COOLDOWN_S (${c.cbMaxCooldownS})`,
    );
  }
  if (c.cbMaxCooldownS > SQS_MAX_DELAY_S) {
    issues.push(
      `CB_MAX_COOLDOWN_S (${c.cbMaxCooldownS}) must be <= ${SQS_MAX_DELAY_S} (SQS max delay)`,
    );
  }
  if (c.retryBaseS > SQS_MAX_DELAY_S) {
    issues.push(`RETRY_BASE_S (${c.retryBaseS}) must be <= ${SQS_MAX_DELAY_S} (SQS max delay)`);
  }
  return issues;
}
