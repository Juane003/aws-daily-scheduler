import { describe, expect, it } from 'vitest';
import { defaults } from '../../src/common/config.js';

describe('defaults', () => {
  it('keeps httpTimeout < workerTimeout < visibilityTimeout', () => {
    expect(defaults.httpTimeoutMs).toBeLessThan(defaults.workerTimeoutS * 1000);
    expect(defaults.workerTimeoutS).toBeLessThan(defaults.visibilityTimeoutS);
  });
});
