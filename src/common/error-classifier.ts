/**
 * Error classification (CLAUDE.md §6.4). Pure: the Worker passes either the HTTP response it got
 * or the error the HTTP port threw, and acts on the returned class.
 */

export type Classification =
  | { kind: 'SUCCESS' }
  | {
      kind: 'RETRYABLE';
      /** Short machine-readable cause, stored in `executions.last_error_type`. */
      errorType: string;
      /** Seconds requested by `Retry-After` (429 and 503 only). Not capped here. */
      retryAfterS?: number;
    }
  | {
      kind: 'NON_RETRYABLE';
      errorType: string;
      /** 401/403: the Worker must raise the credentials alarm. */
      credentialAlarm: boolean;
    };

export interface HttpOutcome {
  status: number;
  /** Header names are matched case-insensitively. */
  headers?: Readonly<Record<string, string | undefined>>;
}

const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const RETRY_AFTER_STATUSES = new Set([429, 503]);

const NETWORK_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'EPIPE']);
const TIMEOUT_NAMES = new Set(['AbortError', 'TimeoutError']);

/** e.g. `Sun, 06 Nov 1994 08:49:37 GMT` (RFC 9110 §5.6.7). */
const IMF_FIXDATE = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * Throttling reported by the Lambda / API Gateway in front of the internal API. API Gateway and
 * Lambda report it through `x-amzn-ErrorType`; an SDK-based client throws it as `error.name`.
 * Exact header values to verify against the internal API (see docs/15-preguntas-abiertas.md).
 */
const THROTTLING_TYPES = [
  'TooManyRequestsException',
  'ThrottlingException',
  'LimitExceededException',
];

export function classifyResponse(response: HttpOutcome, now: Date = new Date()): Classification {
  const { status } = response;
  if (status >= 200 && status < 300) return { kind: 'SUCCESS' };

  if (isThrottling(header(response, 'x-amzn-errortype'))) {
    return withRetryAfter({ kind: 'RETRYABLE', errorType: 'THROTTLED' }, response, now);
  }

  if (RETRYABLE_STATUSES.has(status)) {
    return withRetryAfter({ kind: 'RETRYABLE', errorType: `HTTP_${status}` }, response, now);
  }

  if (status >= 400 && status < 500) {
    return {
      kind: 'NON_RETRYABLE',
      errorType: `HTTP_${status}`,
      credentialAlarm: status === 401 || status === 403,
    };
  }

  // Anything else (1xx, 3xx, 5xx outside the list): unknown, so retry bounded by maxAttempts.
  return { kind: 'RETRYABLE', errorType: `HTTP_${status}` };
}

/**
 * Classifies an error thrown while calling the API (no HTTP response). Uses `error.code` and
 * `error.name`, never the message. Follows `cause`, because `fetch` wraps socket errors in
 * `TypeError('fetch failed', { cause })`.
 */
export function classifyError(error: unknown): Classification {
  for (let current = error, depth = 0; isObject(current) && depth < 5; depth++) {
    const { code, name } = current;
    if (typeof name === 'string' && TIMEOUT_NAMES.has(name)) {
      return { kind: 'RETRYABLE', errorType: 'TIMEOUT' };
    }
    if (typeof name === 'string' && isThrottling(name)) {
      return { kind: 'RETRYABLE', errorType: 'THROTTLED' };
    }
    if (typeof code === 'string' && (NETWORK_CODES.has(code) || code.startsWith('UND_ERR_'))) {
      return { kind: 'RETRYABLE', errorType: `NETWORK_${code}` };
    }
    current = current.cause;
  }
  return { kind: 'RETRYABLE', errorType: 'UNKNOWN' };
}

/**
 * `Retry-After` is either delta-seconds or an HTTP-date (RFC 9110 §10.2.3). Returns seconds from
 * `now`, never negative, or `undefined` if the header is missing or malformed.
 */
export function parseRetryAfter(value: string | undefined, now: Date): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  // Only IMF-fixdate: Date.parse alone would accept things like "-5" or "1.5" as dates.
  if (!IMF_FIXDATE.test(trimmed)) return undefined;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, Math.ceil((at - now.getTime()) / 1000));
}

function withRetryAfter(
  classification: Extract<Classification, { kind: 'RETRYABLE' }>,
  response: HttpOutcome,
  now: Date,
): Classification {
  if (!RETRY_AFTER_STATUSES.has(response.status)) return classification;
  const retryAfterS = parseRetryAfter(header(response, 'retry-after'), now);
  return retryAfterS === undefined ? classification : { ...classification, retryAfterS };
}

function header(response: HttpOutcome, name: string): string | undefined {
  for (const [key, value] of Object.entries(response.headers ?? {})) {
    if (key.toLowerCase() === name) return value;
  }
  return undefined;
}

function isThrottling(value: string | undefined): boolean {
  return value !== undefined && THROTTLING_TYPES.some((t) => value.includes(t));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
