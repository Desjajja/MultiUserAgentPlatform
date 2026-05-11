import { describe, expect, it } from 'bun:test';

import { confidenceAdvisory } from './classify-intent.js';

describe('confidenceAdvisory', () => {
  it('treats out-of-range confidence as invalid', () => {
    expect(confidenceAdvisory(Number.NaN, 2)).toMatch(/invalid/i);
    expect(confidenceAdvisory(-0.1, 2)).toMatch(/invalid/i);
    expect(confidenceAdvisory(1.1, 2)).toMatch(/invalid/i);
  });

  it('refuses to delegate when no candidates are identified', () => {
    expect(confidenceAdvisory(0.95, 0)).toMatch(/no candidate/i);
  });

  it('asks for clarification below 0.70 confidence', () => {
    expect(confidenceAdvisory(0.5, 1)).toMatch(/ask_user_question/);
    expect(confidenceAdvisory(0.69, 1)).toMatch(/ask_user_question/);
  });

  it('asks for clarification when multiple plausible workers at moderate confidence', () => {
    expect(confidenceAdvisory(0.65, 3)).toMatch(/ask_user_question/);
  });

  it('asks for a user-side confirmation at moderate-high confidence', () => {
    const advisory = confidenceAdvisory(0.8, 1);
    expect(advisory.toLowerCase()).toContain('delegate');
    expect(advisory.toLowerCase()).toContain('confirmation');
  });

  it('allows direct delegation at ≥ 0.85', () => {
    const advisory = confidenceAdvisory(0.9, 1);
    expect(advisory.toLowerCase()).toContain('delegate directly');
  });

  it('boundary: exactly 0.70 still triggers the "moderate" branch, not clarify', () => {
    const advisory = confidenceAdvisory(0.7, 1);
    // 0.70 is NOT < 0.70, so it falls into the moderate bucket.
    expect(advisory.toLowerCase()).toContain('moderate');
  });

  it('boundary: exactly 0.85 falls into the "high" bucket', () => {
    expect(confidenceAdvisory(0.85, 1).toLowerCase()).toContain('delegate directly');
  });
});
