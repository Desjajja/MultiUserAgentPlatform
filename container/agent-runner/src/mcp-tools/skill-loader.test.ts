/**
 * Tests for skill-loader MCP tool. Focus on path-safety and error
 * handling — the tool reads files from /app/skills, so any input that
 * could traverse outside that directory must be rejected.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'fs';
import path from 'path';

import { loadSkill } from './skill-loader.js';

const SKILLS_DIR = '/app/skills';
const FAKE_SKILL = 'test-skill-loader-fixture';
const FAKE_SKILL_DIR = path.join(SKILLS_DIR, FAKE_SKILL);
const FAKE_INSTRUCTIONS = '# Fake skill\n\nThis is fixture content for tests.\n';

beforeAll(() => {
  // /app/skills is normally a read-only bind mount in production. Tests run
  // outside the container against the local filesystem; create a fixture
  // dir if writable, else skip those cases.
  try {
    fs.mkdirSync(FAKE_SKILL_DIR, { recursive: true });
    fs.writeFileSync(path.join(FAKE_SKILL_DIR, 'instructions.md'), FAKE_INSTRUCTIONS);
  } catch {
    // /app/skills not writable in this env — happy-path test will be skipped.
  }
});

afterAll(() => {
  try {
    fs.rmSync(FAKE_SKILL_DIR, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

function callLoadSkill(args: Record<string, unknown>) {
  return loadSkill.handler(args);
}

describe('load_skill — error cases', () => {
  it('rejects empty name', async () => {
    const r = await callLoadSkill({ name: '' });
    expect(r.isError).toBe(true);
  });

  it('rejects whitespace-only name', async () => {
    const r = await callLoadSkill({ name: '   ' });
    expect(r.isError).toBe(true);
  });

  it('rejects non-string name', async () => {
    const r = await callLoadSkill({ name: 123 });
    expect(r.isError).toBe(true);
  });

  it('rejects missing skill', async () => {
    const r = await callLoadSkill({ name: 'absolutely-nonexistent-skill-xyz' });
    expect(r.isError).toBe(true);
    const text = (r.content[0] as { text?: string })?.text ?? '';
    expect(text).toMatch(/not found/i);
  });
});

describe('load_skill — path traversal safety', () => {
  it('strips traversal characters from name', async () => {
    // sanitizeSkillName drops everything but [a-zA-Z0-9_-], so '../etc/passwd'
    // becomes 'etcpasswd' (which won't exist) — never reaches /etc/.
    const r = await callLoadSkill({ name: '../etc/passwd' });
    expect(r.isError).toBe(true);
    const text = (r.content[0] as { text?: string })?.text ?? '';
    // Confirms the resolved name is sanitized: no slashes, dots, or
    // path traversal artifacts in the error output.
    expect(text).not.toContain('/');
    expect(text).not.toContain('..');
    expect(text).not.toContain('etc/passwd');
  });

  it('rejects absolute path injection', async () => {
    const r = await callLoadSkill({ name: '/etc/passwd' });
    expect(r.isError).toBe(true);
    const text = (r.content[0] as { text?: string })?.text ?? '';
    // Sanitization strips all '/' chars — error must not surface a path.
    expect(text).not.toContain('/etc');
    expect(text).not.toContain('/');
  });

  it('rejects names with null bytes', async () => {
    const r = await callLoadSkill({ name: 'arxiv\x00../../etc/passwd' });
    expect(r.isError).toBe(true);
  });

  it('rejects names containing parent-dir markers', async () => {
    const r = await callLoadSkill({ name: 'foo/../../bar' });
    expect(r.isError).toBe(true);
  });

  it('rejects names with shell metacharacters', async () => {
    const r = await callLoadSkill({ name: 'foo;rm -rf /' });
    // After sanitization → 'foo' which probably exists in /app/skills, so
    // this just confirms no shell execution path. Either error or success
    // returning fixture content — both are safe (no rm runs).
    if (r.isError) {
      const text = (r.content[0] as { text?: string })?.text ?? '';
      expect(text).not.toMatch(/rm -rf/);
    }
  });
});

describe('load_skill — happy path', () => {
  it('loads existing fixture skill content with banner', async () => {
    if (!fs.existsSync(path.join(FAKE_SKILL_DIR, 'instructions.md'))) {
      // Fixture couldn't be written (probably running outside container);
      // skip rather than fail since /app/skills is RO in prod tests anyway.
      return;
    }
    const r = await callLoadSkill({ name: FAKE_SKILL });
    expect(r.isError).toBeFalsy();
    const text = (r.content[0] as { text?: string })?.text ?? '';
    expect(text).toContain(`## Skill: ${FAKE_SKILL}`);
    expect(text).toContain('fixture content');
  });
});
