import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/common/config.js';

describe('loadConfig', () => {
  it('applies the documented defaults', () => {
    const c = loadConfig({});
    expect(c).toMatchObject({
      businessTz: 'UTC',
      lookbackSlots: 5,
      providerShardsK: 1,
      providerShardsOverrides: {},
      httpTimeoutMs: 10_000,
      workerTimeoutS: 30,
      fifoVisibilityTimeoutS: 180,
      maxAttempts: 8,
      retryBaseS: 10,
      cbFailureThreshold: 5,
      cbBaseCooldownS: 60,
      cbMaxCooldownS: 900,
      staleAfterS: 360,
      expiryGraceH: 6,
      esmMaxConcurrency: 200,
      resultInlineMaxBytes: 262_144,
      retentionMonths: 13,
    });
  });

  it('is frozen', () => {
    expect(Object.isFrozen(loadConfig({}))).toBe(true);
  });

  it('derives the visibility timeout from WORKER_TIMEOUT_S', () => {
    expect(loadConfig({ WORKER_TIMEOUT_S: '20' }).fifoVisibilityTimeoutS).toBe(120);
  });

  it('parses per-provider shard overrides', () => {
    const c = loadConfig({ PROVIDER_SHARDS_OVERRIDES: '{"acme":4}' });
    expect(c.providerShardsOverrides).toEqual({ acme: 4 });
  });

  it.each([
    [{ PROVIDER_SHARDS_OVERRIDES: 'not json' }, /valid JSON/],
    [{ PROVIDER_SHARDS_OVERRIDES: '{"acme":0}' }, /positive integer/],
    [{ BUSINESS_TZ: 'Mars/Olympus' }, /IANA/],
    [{ MAX_ATTEMPTS: 'abc' }, /MAX_ATTEMPTS/],
    [{ MAX_ATTEMPTS: '0' }, /MAX_ATTEMPTS/],
  ])('rejects invalid input %j', (env, message) => {
    expect(() => loadConfig(env)).toThrow(message);
  });

  describe('timeout invariant HTTP_TIMEOUT < WORKER_TIMEOUT < visibility timeout', () => {
    it('rejects HTTP_TIMEOUT >= WORKER_TIMEOUT', () => {
      expect(() => loadConfig({ HTTP_TIMEOUT_MS: '30000', WORKER_TIMEOUT_S: '30' })).toThrow(
        /HTTP_TIMEOUT_MS/,
      );
    });

    it('rejects WORKER_TIMEOUT >= visibility timeout', () => {
      expect(() => loadConfig({ WORKER_TIMEOUT_S: '30', FIFO_VISIBILITY_TIMEOUT_S: '30' })).toThrow(
        /visibility timeout/,
      );
    });

    it('accepts a strictly increasing chain', () => {
      expect(() =>
        loadConfig({
          HTTP_TIMEOUT_MS: '29999',
          WORKER_TIMEOUT_S: '30',
          FIFO_VISIBILITY_TIMEOUT_S: '31',
        }),
      ).not.toThrow();
    });
  });

  it.each([
    [{ STALE_AFTER_S: '30' }, /STALE_AFTER_S/],
    [{ CB_BASE_COOLDOWN_S: '120', CB_MAX_COOLDOWN_S: '60' }, /CB_BASE_COOLDOWN_S/],
    [{ CB_MAX_COOLDOWN_S: '901' }, /CB_MAX_COOLDOWN_S/],
    [{ RETRY_BASE_S: '901' }, /RETRY_BASE_S/],
  ])('rejects cross-field violation %j', (env, message) => {
    expect(() => loadConfig(env)).toThrow(message);
  });

  it('reports every issue at once', () => {
    try {
      loadConfig({ MAX_ATTEMPTS: 'x', RETRY_BASE_S: 'y' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).issues).toHaveLength(2);
    }
  });
});
