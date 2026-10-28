import { describe, expect, it } from 'vitest';
import {
  deduplicationId,
  groupId,
  jobIdOf,
  nextMessage,
  parseJobMessage,
  type JobMessage,
} from '../../src/common/message.js';

const valid: JobMessage = {
  jobId: '42#2026-03-01',
  registryId: '42',
  providerId: 'prov-7',
  runDate: '2026-03-01',
  attempt: 0,
  seq: 0,
  firstEnqueuedAt: '2026-03-01T00:07:00.000Z',
  reason: 'DISPATCH',
};

describe('parseJobMessage', () => {
  it('accepts a valid message as object or JSON string', () => {
    expect(parseJobMessage(valid)).toEqual({ ok: true, message: valid });
    expect(parseJobMessage(JSON.stringify(valid))).toEqual({ ok: true, message: valid });
  });

  it('accepts a message without reason', () => {
    expect(parseJobMessage({ ...valid, reason: undefined }).ok).toBe(true);
  });

  it('rejects invalid JSON with INVALID_MESSAGE', () => {
    const result = parseJobMessage('{not json');
    expect(result).toMatchObject({ ok: false, reason: 'INVALID_MESSAGE' });
  });

  it.each<[string, Record<string, unknown>]>([
    ['jobId not matching registryId#runDate', { jobId: '43#2026-03-01' }],
    ['non-numeric registryId', { registryId: 'abc', jobId: 'abc#2026-03-01' }],
    ['empty providerId', { providerId: '' }],
    ['malformed runDate', { runDate: '2026-3-1', jobId: '42#2026-3-1' }],
    ['impossible runDate', { runDate: '2026-02-30', jobId: '42#2026-02-30' }],
    ['negative attempt', { attempt: -1 }],
    ['fractional seq', { seq: 1.5 }],
    ['non-ISO firstEnqueuedAt', { firstEnqueuedAt: 'yesterday' }],
    ['unknown reason', { reason: 'MANUAL' }],
    ['missing field', { attempt: undefined }],
  ])('rejects %s', (_label, patch) => {
    const result = parseJobMessage({ ...valid, ...patch });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('INVALID_MESSAGE');
      expect(result.error.length).toBeGreaterThan(0);
    }
  });

  it.each([null, 42, [], 'null'])('rejects non-object input %o', (raw) => {
    expect(parseJobMessage(raw).ok).toBe(false);
  });
});

describe('ids', () => {
  it('jobId is registryId#runDate', () => {
    expect(jobIdOf('42', '2026-03-01')).toBe('42#2026-03-01');
  });

  it('deduplication id is jobId#seq', () => {
    expect(deduplicationId(valid)).toBe('42#2026-03-01#0');
    expect(deduplicationId({ ...valid, seq: 3 })).toBe('42#2026-03-01#3');
  });
});

describe('groupId', () => {
  it('is the providerId when shards = 1', () => {
    expect(groupId('prov-7', '42', 1)).toBe('prov-7');
  });

  it('is providerId#shard, stable per registry and within 0..k-1', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const g = groupId('prov-7', String(i), 4);
      expect(g).toBe(groupId('prov-7', String(i), 4));
      expect(g).toMatch(/^prov-7#[0-3]$/);
      seen.add(g);
    }
    expect(seen.size).toBe(4);
  });

  it('rejects invalid shard counts', () => {
    expect(() => groupId('p', '1', 0)).toThrow(RangeError);
    expect(() => groupId('p', '1', 1.5)).toThrow(RangeError);
  });
});

describe('nextMessage', () => {
  it('a breaker defer bumps seq but not attempt', () => {
    expect(nextMessage(valid, 'CIRCUIT_DEFER')).toEqual({
      ...valid,
      seq: 1,
      attempt: 0,
      reason: 'CIRCUIT_DEFER',
    });
  });

  it('a retry bumps seq and sets the new attempt count', () => {
    expect(nextMessage({ ...valid, seq: 2, attempt: 1 }, 'RETRY', 2)).toMatchObject({
      seq: 3,
      attempt: 2,
      reason: 'RETRY',
    });
  });

  it('does not mutate the original message', () => {
    const original = { ...valid };
    nextMessage(original, 'RETRY', 1);
    expect(original).toEqual(valid);
  });
});
