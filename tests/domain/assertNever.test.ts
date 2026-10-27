import { describe, expect, it } from 'vitest';
import { assertNever } from '../../src/domain/assertNever.js';

describe('assertNever', () => {
  it('throws with the unexpected value', () => {
    expect(() => assertNever('surprise' as never)).toThrow('Unexpected value: "surprise"');
  });
});
