import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  DEFAULT_FRONTDESK_FOLDER,
  DEFAULT_FRONTDESK_NAME,
  LAB_FRONTDESK_FOLDER,
  LAB_FRONTDESK_NAME,
  resolveBranchDefaultFrontdesk,
} from '../src/branding.js';

export interface FrontdeskDefaultPolicyCheckResult {
  ok: boolean;
  failures: string[];
  summary: string;
}

const EXPECTED_TEMPLATE_FOLDER = 'frontlane-template-frontdesk';
const EXPECTED_TEMPLATE_NAME = 'FrontLane Template Desk';
const EXPECTED_LAB_FOLDER = 'frontlane-lab-frontdesk';
const EXPECTED_LAB_NAME = 'FrontLane Lab Desk';

function firstDefaultFrontdeskUsesTemplateConstants(source: string): boolean {
  return /const\s+DEFAULT_FRONTDESKS\s*:[\s\S]*?=\s*\[\s*{\s*folder:\s*DEFAULT_FRONTDESK_FOLDER,\s*name:\s*DEFAULT_FRONTDESK_NAME,/m.test(
    source,
  );
}

export function checkFrontdeskDefaultPolicy(repoRoot: string): FrontdeskDefaultPolicyCheckResult {
  const failures: string[] = [];

  if (DEFAULT_FRONTDESK_FOLDER !== EXPECTED_TEMPLATE_FOLDER) {
    failures.push(`DEFAULT_FRONTDESK_FOLDER must remain ${EXPECTED_TEMPLATE_FOLDER}`);
  }
  if (DEFAULT_FRONTDESK_NAME !== EXPECTED_TEMPLATE_NAME) {
    failures.push(`DEFAULT_FRONTDESK_NAME must remain ${EXPECTED_TEMPLATE_NAME}`);
  }
  if (LAB_FRONTDESK_FOLDER !== EXPECTED_LAB_FOLDER) {
    failures.push(`LAB_FRONTDESK_FOLDER must remain ${EXPECTED_LAB_FOLDER}`);
  }
  if (LAB_FRONTDESK_NAME !== EXPECTED_LAB_NAME) {
    failures.push(`LAB_FRONTDESK_NAME must remain ${EXPECTED_LAB_NAME}`);
  }
  if (resolveBranchDefaultFrontdesk('dxy-dev') !== EXPECTED_LAB_FOLDER) {
    failures.push('dxy-dev branch must default to frontlane-lab-frontdesk');
  }
  if (resolveBranchDefaultFrontdesk('main') !== null) {
    failures.push('main branch must not override the template frontdesk fallback');
  }
  if (resolveBranchDefaultFrontdesk(null) !== null) {
    failures.push('unknown branch must not override the template frontdesk fallback');
  }

  const initScriptPath = path.join(repoRoot, 'scripts', 'init-enterprise-topology.ts');
  const initScript = fs.readFileSync(initScriptPath, 'utf-8');
  if (!firstDefaultFrontdeskUsesTemplateConstants(initScript)) {
    failures.push('DEFAULT_FRONTDESKS[0] must use DEFAULT_FRONTDESK_FOLDER and DEFAULT_FRONTDESK_NAME');
  }

  return {
    ok: failures.length === 0,
    failures,
    summary: 'frontdesk defaults: main/unknown -> frontlane-template-frontdesk; dxy-dev -> frontlane-lab-frontdesk; env override wins',
  };
}

function defaultRepoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const result = checkFrontdeskDefaultPolicy(defaultRepoRoot());
  console.log(result.summary);
  if (!result.ok) {
    for (const failure of result.failures) console.error(`frontdesk-policy: ${failure}`);
    process.exit(1);
  }
}
