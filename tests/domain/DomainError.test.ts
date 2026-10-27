import { describe, expect, it } from 'vitest';
import { DomainError } from '../../src/domain/errors/DomainError.js';

class SampleError extends DomainError {
  constructor() {
    super('sample');
  }
}

describe('DomainError', () => {
  it('uses the subclass name', () => {
    const error = new SampleError();
    expect(error).toBeInstanceOf(DomainError);
    expect(error.name).toBe('SampleError');
  });
});
