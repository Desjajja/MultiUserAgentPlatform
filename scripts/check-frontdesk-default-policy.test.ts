import path from 'path';

import { describe, expect, it } from 'vitest';

import { checkFrontdeskDefaultPolicy } from './check-frontdesk-default-policy.js';

const repoRoot = path.resolve(__dirname, '..');

describe('check-frontdesk-default-policy', () => {
  it('accepts the committed branch-default frontdesk policy', () => {
    const result = checkFrontdeskDefaultPolicy(repoRoot);

    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.summary).toContain('main/unknown -> frontlane-template-frontdesk');
    expect(result.summary).toContain('dxy-dev -> frontlane-lab-frontdesk');
  });
});
