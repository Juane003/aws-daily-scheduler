import { describe, expect, it } from 'vitest';
import {
  classifyError,
  classifyResponse,
  parseRetryAfter,
} from '../../src/common/error-classifier.js';

const now = new Date('2026-03-01T12:00:00.000Z');

describe('classifyResponse', () => {
  it.each([200, 201, 204, 299])('%i is SUCCESS', (status) => {
    expect(classifyResponse({ status }, now)).toEqual({ kind: 'SUCCESS' });
  });

  it.each([408, 425, 429, 500, 502, 503, 504])('%i is RETRYABLE', (status) => {
    expect(classifyResponse({ status }, now)).toEqual({
      kind: 'RETRYABLE',
      errorType: `HTTP_${status}`,
    });
  });

  it.each([400, 404, 409, 422, 410, 418])('%i is NON_RETRYABLE without alarm', (status) => {
    expect(classifyResponse({ status }, now)).toEqual({
      kind: 'NON_RETRYABLE',
      errorType: `HTTP_${status}`,
      credentialAlarm: false,
    });
  });

  it.each([401, 403])('%i is NON_RETRYABLE and raises the credentials alarm', (status) => {
    expect(classifyResponse({ status }, now)).toEqual({
      kind: 'NON_RETRYABLE',
      errorType: `HTTP_${status}`,
      credentialAlarm: true,
    });
  });

  it.each([429, 503])('%i honours Retry-After in seconds', (status) => {
    expect(classifyResponse({ status, headers: { 'Retry-After': '120' } }, now)).toEqual({
      kind: 'RETRYABLE',
      errorType: `HTTP_${status}`,
      retryAfterS: 120,
    });
  });

  it('honours Retry-After as an HTTP-date', () => {
    const headers = { 'retry-after': 'Sun, 01 Mar 2026 12:01:30 GMT' };
    expect(classifyResponse({ status: 503, headers }, now)).toMatchObject({ retryAfterS: 90 });
  });

  it.each([408, 500, 502, 504])('%i ignores Retry-After', (status) => {
    const result = classifyResponse({ status, headers: { 'Retry-After': '120' } }, now);
    expect(result).not.toHaveProperty('retryAfterS');
  });

  it('ignores a malformed Retry-After', () => {
    const result = classifyResponse({ status: 429, headers: { 'Retry-After': 'soon' } }, now);
    expect(result).toEqual({ kind: 'RETRYABLE', errorType: 'HTTP_429' });
  });

  it('treats Lambda / API Gateway throttling as RETRYABLE whatever the status', () => {
    const headers = { 'x-amzn-ErrorType': 'TooManyRequestsException:http://internal/' };
    expect(classifyResponse({ status: 400, headers }, now)).toEqual({
      kind: 'RETRYABLE',
      errorType: 'THROTTLED',
    });
    expect(
      classifyResponse(
        { status: 429, headers: { 'X-Amzn-ErrorType': 'ThrottlingException', 'Retry-After': '5' } },
        now,
      ),
    ).toEqual({ kind: 'RETRYABLE', errorType: 'THROTTLED', retryAfterS: 5 });
  });

  it.each([100, 304, 501, 505])('unknown status %i is RETRYABLE (bounded by maxAttempts)', (s) => {
    expect(classifyResponse({ status: s }, now)).toEqual({
      kind: 'RETRYABLE',
      errorType: `HTTP_${s}`,
    });
  });
});

describe('classifyError', () => {
  const withCode = (code: string): Error => Object.assign(new Error('socket'), { code });

  it.each(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'EPIPE'])(
    'error.code %s is RETRYABLE',
    (code) => {
      expect(classifyError(withCode(code))).toEqual({
        kind: 'RETRYABLE',
        errorType: `NETWORK_${code}`,
      });
    },
  );

  it('any undici UND_ERR_* code is RETRYABLE', () => {
    expect(classifyError(withCode('UND_ERR_SOCKET'))).toEqual({
      kind: 'RETRYABLE',
      errorType: 'NETWORK_UND_ERR_SOCKET',
    });
  });

  it('uses error.code, not the message', () => {
    const misleading = new Error('ECONNRESET happened');
    expect(classifyError(misleading)).toEqual({ kind: 'RETRYABLE', errorType: 'UNKNOWN' });
  });

  it.each(['AbortError', 'TimeoutError'])('error.name %s is a RETRYABLE timeout', (name) => {
    expect(classifyError(new DOMException('aborted', name))).toEqual({
      kind: 'RETRYABLE',
      errorType: 'TIMEOUT',
    });
  });

  it('recognises AbortSignal.timeout()', () => {
    const signal = AbortSignal.timeout(0);
    return new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => {
        expect(classifyError(signal.reason)).toMatchObject({ errorType: 'TIMEOUT' });
        resolve();
      });
    });
  });

  it('follows cause, as fetch wraps socket errors in TypeError("fetch failed")', () => {
    const error = new TypeError('fetch failed', { cause: withCode('UND_ERR_CONNECT_TIMEOUT') });
    expect(classifyError(error)).toEqual({
      kind: 'RETRYABLE',
      errorType: 'NETWORK_UND_ERR_CONNECT_TIMEOUT',
    });
  });

  it('treats a thrown throttling exception as RETRYABLE', () => {
    const error = Object.assign(new Error('Rate exceeded'), { name: 'TooManyRequestsException' });
    expect(classifyError(error)).toEqual({ kind: 'RETRYABLE', errorType: 'THROTTLED' });
  });

  it.each([new Error('boom'), 'a string', 42, null, undefined, { code: 123 }])(
    'unknown error %o is RETRYABLE',
    (error) => {
      expect(classifyError(error)).toEqual({ kind: 'RETRYABLE', errorType: 'UNKNOWN' });
    },
  );

  it('does not loop forever on a cyclic cause chain', () => {
    const a: { cause?: unknown } = {};
    a.cause = a;
    expect(classifyError(a)).toEqual({ kind: 'RETRYABLE', errorType: 'UNKNOWN' });
  });
});

describe('parseRetryAfter', () => {
  it('parses delta-seconds with surrounding whitespace', () => {
    expect(parseRetryAfter(' 30 ', now)).toBe(30);
  });

  it('clamps a past HTTP-date to 0', () => {
    expect(parseRetryAfter('Sun, 01 Mar 2026 11:00:00 GMT', now)).toBe(0);
  });

  it('rejects negative or fractional numbers and missing values', () => {
    expect(parseRetryAfter('-5', now)).toBeUndefined();
    expect(parseRetryAfter('1.5', now)).toBeUndefined();
    expect(parseRetryAfter(undefined, now)).toBeUndefined();
  });
});
