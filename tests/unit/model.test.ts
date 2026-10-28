import { describe, expect, it } from 'vitest';
import { EXECUTION_STATUSES, isTerminal } from '../../src/core/model.js';

describe('isTerminal', () => {
  it('marks SUCCEEDED and the FAILED_* statuses as terminal', () => {
    expect(EXECUTION_STATUSES.filter(isTerminal)).toEqual([
      'SUCCEEDED',
      'FAILED_NON_RETRYABLE',
      'FAILED_EXHAUSTED',
      'FAILED_EXPIRED',
    ]);
  });
});
