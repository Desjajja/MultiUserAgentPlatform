import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

export const PLATFORM_BRAND = 'FrontLane';
export const PLATFORM_NAME = 'FrontLane Agent Platform';
export const PLATFORM_PROTOCOL_NAMESPACE = 'frontlane';
export const MCP_SERVER_NAME = 'frontlane';

export const DEFAULT_FRONTDESK_NAME = 'FrontLane Template Desk';
export const DEFAULT_FRONTDESK_FOLDER = 'frontlane-template-frontdesk';
export const LAB_FRONTDESK_NAME = 'FrontLane Lab Desk';
export const LAB_FRONTDESK_FOLDER = 'frontlane-lab-frontdesk';
export const LEGACY_FRONTDESK_FOLDER = 'enterprise-frontdesk';
export const LEGACY_FRONTDESK_FOLDER_V2 = 'frontlane-frontdesk';

export const DEFAULT_WORKER_FOLDER_PREFIX = 'frontlane';
export const LEGACY_WORKER_FOLDER_PREFIX = 'enterprise';

interface ResolveFrontdeskOptions {
  currentBranch?: string | null;
}

export function resolveCurrentGitBranch(cwd = process.cwd()): string | null {
  try {
    const branch = execFileSync('git', ['branch', '--show-current'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

    return branch.length > 0 ? branch : null;
  } catch {
    return null;
  }
}

export function resolveBranchDefaultFrontdesk(branch: string | null | undefined): string | null {
  if (branch === 'dxy-dev') return LAB_FRONTDESK_FOLDER;
  return null;
}

export function resolveFrontdeskFolderFromGroups(
  groupsDir: string,
  configured: string | undefined,
  options: ResolveFrontdeskOptions = {},
): string {
  const value = configured?.trim();
  if (value) return value;

  const currentBranch = Object.hasOwn(options, 'currentBranch') ? options.currentBranch : resolveCurrentGitBranch();
  const branchDefault = resolveBranchDefaultFrontdesk(currentBranch);
  if (branchDefault) return branchDefault;

  const preferred = path.join(groupsDir, DEFAULT_FRONTDESK_FOLDER);
  if (fs.existsSync(preferred)) return DEFAULT_FRONTDESK_FOLDER;

  const legacyV2 = path.join(groupsDir, LEGACY_FRONTDESK_FOLDER_V2);
  if (fs.existsSync(legacyV2)) return LEGACY_FRONTDESK_FOLDER_V2;

  const legacy = path.join(groupsDir, LEGACY_FRONTDESK_FOLDER);
  if (fs.existsSync(legacy)) return LEGACY_FRONTDESK_FOLDER;

  return DEFAULT_FRONTDESK_FOLDER;
}

export function buildWorkerFolder(localName: string): string {
  return `${DEFAULT_WORKER_FOLDER_PREFIX}-${localName}`;
}

export function buildLegacyWorkerFolder(localName: string): string {
  return `${LEGACY_WORKER_FOLDER_PREFIX}-${localName}`;
}
