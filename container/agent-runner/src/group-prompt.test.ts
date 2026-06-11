import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { closeSessionDb, getInboundDb, initTestSessionDb } from './db/connection.js';
import { buildSystemInstructions, readGroupLocalPrompt } from './group-prompt.js';

let tmpDir: string;

beforeEach(() => {
  initTestSessionDb();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'group-prompt-'));
});

afterEach(() => {
  closeSessionDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function seedDestination(name: string, displayName: string, channelType: string, platformId: string): void {
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES (?, ?, 'channel', ?, ?, NULL)`,
    )
    .run(name, displayName, channelType, platformId);
}

describe('readGroupLocalPrompt', () => {
  it('returns empty string when CLAUDE.local.md is missing', () => {
    expect(readGroupLocalPrompt(tmpDir)).toBe('');
  });

  it('returns trimmed file contents when present', () => {
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.local.md'), '  # 小环\n\nhello  \n');
    expect(readGroupLocalPrompt(tmpDir)).toBe('# 小环\n\nhello');
  });
});

describe('buildSystemInstructions', () => {
  it('returns addendum with identity when local prompt is missing', () => {
    const instructions = buildSystemInstructions({
      cwd: tmpDir,
      provider: 'sdk-openai',
      assistantName: 'FrontLane Lab Desk',
    });

    expect(instructions).toContain('Your name is **FrontLane Lab Desk**');
    expect(instructions).not.toContain('小环');
  });

  it('prepends local prompt and skips assistantName identity when local exists', () => {
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.local.md'), '# 小环\n\n实验室助手');

    const instructions = buildSystemInstructions({
      cwd: tmpDir,
      provider: 'sdk-openai',
      assistantName: 'FrontLane Lab Desk',
      memoryMode: 'erp',
    });

    expect(instructions.indexOf('小环')).toBeLessThan(instructions.indexOf('Memory policy'));
    expect(instructions).toContain('实验室助手');
    expect(instructions).not.toContain('Your name is **FrontLane Lab Desk**');
    expect(instructions).toContain('Memory policy');
    expect(instructions).toContain('erp_memory_get');
  });

  it('does not inject local prompt for claude provider', () => {
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.local.md'), '# 小环');

    const instructions = buildSystemInstructions({
      cwd: tmpDir,
      provider: 'claude',
      assistantName: 'FrontLane Lab Desk',
    });

    expect(instructions).not.toContain('小环');
    expect(instructions).toContain('Your name is **FrontLane Lab Desk**');
  });

  it('still includes destinations section when local prompt exists', () => {
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.local.md'), '# 小环');
    seedDestination('local-cli', 'CLI', 'cli', 'local');

    const instructions = buildSystemInstructions({
      cwd: tmpDir,
      provider: 'sdk-openai',
      assistantName: 'FrontLane Lab Desk',
    });

    expect(instructions).toContain('`local-cli`');
    expect(instructions).toContain('<message to="name">');
  });
});
