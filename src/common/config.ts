/**
 * Parameters (CLAUDE.md §7). Reference implementation: a single `defaults` object that every
 * component receives through its constructor; tests override what they need
 * (`{ ...defaults, maxAttempts: 2 }`). In production these values would come from environment
 * variables defined in the IaC; that is documented, not implemented.
 */
export interface Config {
  /** IANA time zone that defines the business day (open question P1). */
  businessTz: string;
  lookbackSlots: number;
  providerShards: number;
  httpTimeoutMs: number;
  workerTimeoutS: number;
  visibilityTimeoutS: number;
  maxAttempts: number;
  retryBaseS: number;
  /** Maximum SQS `DelaySeconds`; caps retry delays and breaker defers. */
  maxDelayS: number;
  cbFailureThreshold: number;
  cbBaseCooldownS: number;
  cbMaxCooldownS: number;
  staleAfterS: number;
  expiryGraceH: number;
  enqueuedStaleH: number;
  reconcileMaxRequeue: number;
  resultInlineMaxBytes: number;
}

export const defaults: Readonly<Config> = Object.freeze({
  businessTz: 'UTC',
  lookbackSlots: 5,
  providerShards: 1,
  httpTimeoutMs: 10_000,
  workerTimeoutS: 30,
  visibilityTimeoutS: 180,
  maxAttempts: 8,
  retryBaseS: 10,
  maxDelayS: 900,
  cbFailureThreshold: 5,
  cbBaseCooldownS: 60,
  cbMaxCooldownS: 900,
  staleAfterS: 360,
  expiryGraceH: 6,
  enqueuedStaleH: 3,
  reconcileMaxRequeue: 10_000,
  resultInlineMaxBytes: 262_144,
});
