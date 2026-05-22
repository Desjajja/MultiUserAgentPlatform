/**
 * load_skill MCP tool — companion to the `progressiveDisclosure` mode in
 * src/claude-md-compose.ts (host side).
 *
 * When progressive disclosure is enabled, the composed CLAUDE.md only lists
 * skill names + descriptions (a "skill index"). To use a skill, the agent
 * calls `load_skill(name)`; this tool reads
 * `/app/skills/<name>/instructions.md` from the read-only bind mount and
 * returns the full content as a tool result. The instructions then land in
 * the conversation transcript (append-only), so subsequent turns benefit
 * from prompt-prefix cache as long as `instructions` remains stable.
 *
 * Always registered — when progressive disclosure is OFF, the agent simply
 * never has reason to call it (the instructions are already inlined into
 * the system prompt by the host compose step).
 */
import fs from 'fs';
import path from 'path';

import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const SKILLS_DIR = '/app/skills';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

function sanitizeSkillName(name: string): string {
  // Skill directory names are alphanumeric + `-` + `_` per existing convention.
  // Strip everything else defensively to prevent traversal even though we
  // also bound with path.resolve checks below.
  return name.replace(/[^a-zA-Z0-9_-]/g, '');
}

export const loadSkill: McpToolDefinition = {
  tool: {
    name: 'load_skill',
    description:
      "Load a skill's full instructions on demand. Call this BEFORE attempting to use any skill listed in the 'Available Skills' index of your system prompt. The skill's instructions.md will be returned as a tool result and become part of the conversation history — you can then follow it to complete the task. If you call this for a skill that is already loaded in this conversation, it will simply return the content again (idempotent). If the name is not in the index, an error is returned.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          description: "Skill name exactly as listed in the index (e.g. 'arxiv', 'chassis-move', 'win_remote_control').",
        },
      },
      required: ['name'],
    },
  },
  async handler(args) {
    const raw = args.name;
    if (typeof raw !== 'string' || !raw.trim()) {
      return err("'name' is required and must be a non-empty string");
    }
    const skillName = sanitizeSkillName(raw.trim());
    if (!skillName) {
      return err(`invalid skill name: ${JSON.stringify(raw)}`);
    }
    const skillDir = path.join(SKILLS_DIR, skillName);
    const resolvedSkillDir = path.resolve(skillDir);
    // Defense in depth: confirm the resolved path is still under SKILLS_DIR.
    if (!resolvedSkillDir.startsWith(SKILLS_DIR + path.sep) && resolvedSkillDir !== SKILLS_DIR) {
      return err(`refusing to load skill outside ${SKILLS_DIR}: ${skillName}`);
    }
    const instructionsPath = path.join(resolvedSkillDir, 'instructions.md');
    if (!fs.existsSync(instructionsPath)) {
      return err(`skill not found or missing instructions.md: ${skillName}`);
    }
    let content: string;
    try {
      content = fs.readFileSync(instructionsPath, 'utf8');
    } catch (e) {
      return err(`failed to read skill ${skillName}: ${e instanceof Error ? e.message : String(e)}`);
    }
    log(`load_skill: ${skillName} (${content.length} bytes)`);
    // Prefix the returned content with a small banner so the agent (and any
    // future log reader) can clearly see where the skill content begins.
    const banner = `## Skill: ${skillName}\n\n`;
    return ok(banner + content);
  },
};

registerTools([loadSkill]);
