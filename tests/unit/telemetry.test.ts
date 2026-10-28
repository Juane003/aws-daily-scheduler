import { describe, expect, it } from 'vitest';
import { JsonLogger } from '../../src/common/telemetry.js';

describe('JsonLogger', () => {
  const fixed = new Date('2026-01-02T03:04:05.000Z');

  it('writes one JSON line per event with job context', () => {
    const lines: string[] = [];
    const logger = new JsonLogger(
      'svc',
      (l) => lines.push(l),
      () => fixed,
    );

    logger.log('info', 'job claimed', { jobId: '1#2026-01-02', attempt: 0 });

    expect(lines).toHaveLength(1);
    expect(lines[0]?.endsWith('\n')).toBe(true);
    expect(JSON.parse(lines[0] ?? '')).toEqual({
      jobId: '1#2026-01-02',
      attempt: 0,
      timestamp: '2026-01-02T03:04:05.000Z',
      level: 'info',
      service: 'svc',
      message: 'job claimed',
    });
  });

  it('serializes errors and does not let fields override reserved keys', () => {
    const lines: string[] = [];
    const logger = new JsonLogger(
      'svc',
      (l) => lines.push(l),
      () => fixed,
    );

    logger.log('error', 'boom', { level: 'debug', err: new TypeError('bad') });

    expect(JSON.parse(lines[0] ?? '')).toMatchObject({
      level: 'error',
      message: 'boom',
      err: { name: 'TypeError', message: 'bad' },
    });
  });
});
