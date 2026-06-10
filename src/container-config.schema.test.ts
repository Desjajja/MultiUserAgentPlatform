import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CONTAINER_SCHEMA_PATH,
  generateContainerSchema,
} from './container-config-schema-generate.js';
import {
  createContainerConfigValidator,
  validateAllContainerConfigs,
} from './container-config-schema.js';

const tmpState: { root: string } = { root: '' };

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    get GROUPS_DIR(): string {
      return path.join(tmpState.root, 'groups');
    },
  };
});

const { readContainerConfig, writeContainerConfig } = await import('./container-config.js');

beforeEach(() => {
  tmpState.root = fs.mkdtempSync(path.join(os.tmpdir(), 'frontlane-container-schema-'));
  fs.mkdirSync(path.join(tmpState.root, 'groups'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpState.root, { recursive: true, force: true });
});

describe('container.json schema', () => {
  it('matches the committed generated schema file', () => {
    const committed = JSON.parse(fs.readFileSync(CONTAINER_SCHEMA_PATH, 'utf8'));
    const generated = generateContainerSchema();
    expect(generated).toEqual(committed);
  });

  it('validates the lab frontdesk fixture', () => {
    const fixture = path.join(process.cwd(), 'groups', 'frontlane-lab-frontdesk', 'container.json');
    const validator = createContainerConfigValidator();
    expect(validator.validateFile(fixture)).toEqual([]);
  });

  it('rejects unknown top-level keys', () => {
    const validator = createContainerConfigValidator();
    const errors = validator.validateValue({
      provider: 'mock',
      typoField: true,
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('validates all checked-in group configs', () => {
    expect(validateAllContainerConfigs()).toEqual([]);
  });
});

describe('container-config idleExitMs', () => {
  it('round-trips idleExitMs through read/write', () => {
    writeContainerConfig('g-idle', {
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: 'all',
      idleExitMs: 120_000,
    });

    expect(readContainerConfig('g-idle').idleExitMs).toBe(120_000);
  });

  it('drops invalid idleExitMs values', () => {
    const groupDir = path.join(tmpState.root, 'groups', 'g-bad-idle');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(
      path.join(groupDir, 'container.json'),
      JSON.stringify({ idleExitMs: -5 }),
    );

    expect(readContainerConfig('g-bad-idle').idleExitMs).toBeUndefined();
  });
});
