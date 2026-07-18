import { describe, expect, it } from 'vitest';
import { parseId } from './parseId.js';

describe('parseId', () => {
  it('parses a valid integer string', () => {
    expect(parseId('42')).toBe(42);
  });

  it('returns undefined for a non-numeric string', () => {
    expect(parseId('abc')).toBeUndefined();
  });

  it('returns undefined for a float string', () => {
    expect(parseId('1.5')).toBeUndefined();
  });

  it('returns undefined for an empty string', () => {
    expect(parseId('')).toBeUndefined();
  });
});
