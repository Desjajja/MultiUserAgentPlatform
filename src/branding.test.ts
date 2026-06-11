import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_FRONTDESK_FOLDER,
  LEGACY_FRONTDESK_FOLDER,
  LEGACY_FRONTDESK_FOLDER_V2,
  resolveFrontdeskFolderFromGroups,
} from './branding.js';

const tempRoots: string[] = [];

function makeGroupsDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frontlane-branding-'));
  tempRoots.push(dir);
  return dir;
}

function mkdirp(target: string): void {
  fs.mkdirSync(target, { recursive: true });
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolveFrontdeskFolderFromGroups', () => {
  it('keeps ENTERPRISE_FRONTDESK_FOLDER higher precedence than branch defaults', () => {
    const groupsDir = makeGroupsDir();

    const folder = resolveFrontdeskFolderFromGroups(groupsDir, ' custom-frontdesk ', {
      currentBranch: 'dxy-dev',
    });

    expect(folder).toBe('custom-frontdesk');
  });

  it('uses the lab frontdesk as the implicit dxy-dev runtime default', () => {
    const groupsDir = makeGroupsDir();

    const folder = resolveFrontdeskFolderFromGroups(groupsDir, undefined, {
      currentBranch: 'dxy-dev',
    });

    expect(folder).toBe('frontlane-lab-frontdesk');
  });

  it('keeps main and unknown branches on the template default', () => {
    const groupsDir = makeGroupsDir();

    expect(
      resolveFrontdeskFolderFromGroups(groupsDir, undefined, {
        currentBranch: 'main',
      }),
    ).toBe(DEFAULT_FRONTDESK_FOLDER);

    expect(
      resolveFrontdeskFolderFromGroups(groupsDir, undefined, {
        currentBranch: null,
      }),
    ).toBe(DEFAULT_FRONTDESK_FOLDER);
  });

  it('preserves legacy filesystem fallback for unknown branches', () => {
    const groupsDir = makeGroupsDir();
    mkdirp(path.join(groupsDir, LEGACY_FRONTDESK_FOLDER_V2));

    expect(
      resolveFrontdeskFolderFromGroups(groupsDir, undefined, {
        currentBranch: 'feature/runtime-check',
      }),
    ).toBe(LEGACY_FRONTDESK_FOLDER_V2);

    fs.rmSync(path.join(groupsDir, LEGACY_FRONTDESK_FOLDER_V2), { recursive: true, force: true });
    mkdirp(path.join(groupsDir, LEGACY_FRONTDESK_FOLDER));

    expect(
      resolveFrontdeskFolderFromGroups(groupsDir, undefined, {
        currentBranch: 'feature/runtime-check',
      }),
    ).toBe(LEGACY_FRONTDESK_FOLDER);
  });
});
