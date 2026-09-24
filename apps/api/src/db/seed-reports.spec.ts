import { describe, expect, it } from 'vitest';
import { stillNeeded } from './seed-reports';

/**
 * A seed that adds rows every time it runs is not a seed. `SEED_REPORTS` says how many demo
 * reports the register should hold, so the second start of the day issues nothing.
 */
describe('demo report seeding', () => {
  it('fills an empty register up to the target', () => {
    expect(stillNeeded(0, 40)).toBe(40);
  });

  it('issues nothing once the target is already met', () => {
    expect(stillNeeded(40, 40)).toBe(0);
  });

  it('tops up a partly filled register rather than starting again', () => {
    expect(stillNeeded(12, 40)).toBe(28);
  });

  it('never asks for a negative number when the register is fuller than the target', () => {
    // Exactly the case that grew the development database: 520 reports, target 40.
    expect(stillNeeded(520, 40)).toBe(0);
  });

  it('does nothing at all when the target is zero', () => {
    expect(stillNeeded(0, 0)).toBe(0);
  });
});
