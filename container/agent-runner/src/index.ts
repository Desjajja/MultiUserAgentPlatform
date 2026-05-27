/**
 * FrontLane Agent Runner v2
 *
 * Runs inside a container. All IO goes through the session DB.
 * No stdin, no stdout markers, no IPC files.
 *
 * Config is read from /workspace/agent/container.json (mounted RO).
 * Only TZ and OneCLI networking vars come from env.
 *
 * Mount structure:
 *   /workspace/
 *     inbound.db        ← host-owned session DB (container reads only)
 *     outbound.db       ← container-owned session DB
 *     .heartbeat        ← container touches for liveness detection
 *     outbox/           ← outbound files
 *     agent/            ← agent group folder (CLAUDE.md, container.json, working files)
 *       container.json  ← per-group config (RO nested mount)
 *     global/           ← shared global memory (RO)
 *   /app/src/           ← shared agent-runner source (RO)
 *   /app/skills/        ← shared skills (RO)
 *   /home/node/.claude/ ← Claude SDK state + skill symlinks (RW)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { loadConfig } from './config.js';
import { buildSystemPromptAddendum } from './destinations.js';
// Providers barrel — each enabled provider self-registers on import.
// Provider skills append imports to providers/index.ts.
import './providers/index.js';
import { createProvider, type ProviderName } from './providers/factory.js';
import { runPollLoop } from './poll-loop.js';

function log(msg: string): void {
  console.error(`[agent-runner] ${msg}`);
}

const CWD = '/workspace/agent';

/**
 * Claude Code SDK auto-loads `/workspace/agent/CLAUDE.md` (with its `@import`
 * chain) and `/workspace/agent/CLAUDE.local.md` into the system prompt at
 * SDK init — that's how Claude-provider runs see all the composed module
 * fragments, skill instructions, and per-group memory.
 *
 * Other providers (OpenAI etc.) have no equivalent affordance. To keep the
 * agent's view consistent across providers, we manually read and expand
 * those same files here, then prepend them to the runtime addendum.
 *
 * Expansion rules:
 *   - lines like `@./relative/path.md` and `@/absolute/path.md` are inlined
 *     by reading the target file and recursing.
 *   - missing files are skipped silently (matches Claude Code's behavior).
 *   - we cap recursion + total size so a malformed import chain can't OOM.
 */
function expandClaudeMd(filePath: string, seen: Set<string>, budget: { remaining: number }): string {
  if (budget.remaining <= 0) return '';
  const resolved = path.resolve(filePath);
  if (seen.has(resolved)) return '';
  if (!fs.existsSync(resolved)) return '';
  seen.add(resolved);

  let raw: string;
  try {
    raw = fs.readFileSync(resolved, 'utf-8');
  } catch {
    return '';
  }

  const baseDir = path.dirname(resolved);
  const lines = raw.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    const match = line.match(/^\s*@(.+\.md)\s*$/);
    if (match) {
      const target = match[1].startsWith('/') ? match[1] : path.join(baseDir, match[1]);
      out.push(expandClaudeMd(target, seen, budget));
      continue;
    }
    out.push(line);
  }
  const joined = out.join('\n');
  const truncated = joined.length > budget.remaining ? joined.slice(0, budget.remaining) : joined;
  budget.remaining -= truncated.length;
  return truncated;
}

/**
 * Reference files that ship for every role — agent compliance baseline.
 * These describe the gateway protocol, business rules, pitfalls, and the
 * field-name dictionary the agent needs no matter what task it's doing.
 */
const SKILL_BASELINE = [
  'ai-gateway.md',
  'endpoint-risk-levels.md',
  'business-rules.md',
  'pitfalls.md',
  'field-semantics.md',
  'api-reference.md',
] as const;

/**
 * Per-role reference whitelist. The agent gets the union across all roles
 * the user holds (from USER_ROLES env, host-resolved at spawn time).
 *
 * Empty role list = no per-role files; baseline only. Useful sane default
 * for unbound users (they only get past `!bind` once, and once bound they
 * spawn a fresh container with proper roles).
 */
const SKILL_BY_ROLE: Record<string, string[]> = {
  boss: ['orders.md', 'policies.md', 'payroll.md', 'approvals.md', 'receipt-approval.md', 'settlement-modes.md'],
  finance: ['receipt-approval.md', 'payroll.md', 'policies.md', 'approvals.md', 'settlement-modes.md'],
  sales: ['orders.md', 'inventory-purchase.md', 'settlement-modes.md'],
  warehouse: ['inventory-purchase.md', 'orders.md'],
  hr: ['payroll.md'],
  // Admin: load everything boss + finance see, since admins frequently
  // troubleshoot across both surfaces.
  admin: ['orders.md', 'policies.md', 'payroll.md', 'approvals.md', 'receipt-approval.md', 'settlement-modes.md', 'inventory-purchase.md'],
};

function selectReferencesForRoles(roles: string[]): Set<string> {
  const out = new Set<string>(SKILL_BASELINE);
  for (const role of roles) {
    const entries = SKILL_BY_ROLE[role.toLowerCase().trim()];
    if (!entries) continue;
    for (const f of entries) out.add(f);
  }
  return out;
}

function inlineSkillFolder(folder: string, budget: { remaining: number }, roles: string[]): string {
  // Best-effort: read SKILL.md plus a curated subset of references/ and inline
  // it as one fenced block. Non-Claude providers have no Read tool, so the
  // skill can only reach the agent through the system prompt.
  //
  // Role-aware: the reference allowlist is the union of (baseline ∪ files
  // mapped to each user role). Empty roles = baseline only. See
  // SKILL_BY_ROLE above for the role→files map.
  if (!fs.existsSync(folder)) return '';
  const skillName = path.basename(folder);
  const parts: string[] = [`# Skill: ${skillName}`];

  const tryRead = (relPath: string) => {
    if (budget.remaining <= 0) return;
    const full = path.join(folder, relPath);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      return;
    }
    if (!stat.isFile()) return;
    let content: string;
    try {
      content = fs.readFileSync(full, 'utf-8');
    } catch {
      return;
    }
    const truncated = content.length > budget.remaining ? content.slice(0, budget.remaining) : content;
    budget.remaining -= truncated.length;
    parts.push(`\n## ${relPath}\n\n${truncated}`);
  };

  tryRead('SKILL.md');
  const refDir = path.join(folder, 'references');
  if (fs.existsSync(refDir)) {
    let entries: string[] = [];
    try {
      entries = fs
        .readdirSync(refDir)
        .filter((f) => f.endsWith('.md'))
        .sort();
    } catch {
      entries = [];
    }
    const include = selectReferencesForRoles(roles);
    for (const entry of entries) {
      if (!include.has(entry)) continue;
      tryRead(path.join('references', entry));
    }
  }
  return parts.join('\n');
}

function buildNonClaudeSystemContext(): string {
  // Cap at ~500KB to fit CLAUDE.md (16KB) + the full xinjiulong-erp skill
  // (~400KB). At ~3 chars/token this lands around 165k tokens — well under
  // gpt-5.4's 200k context, with room for tool I/O and the running transcript.
  const budget = { remaining: 500_000 };
  const sections: string[] = [];
  const claudeMd = path.join(CWD, 'CLAUDE.md');
  const claudeLocalMd = path.join(CWD, 'CLAUDE.local.md');
  const expanded = expandClaudeMd(claudeMd, new Set(), budget);
  if (expanded.trim()) sections.push(expanded);
  const localExpanded = expandClaudeMd(claudeLocalMd, new Set(), budget);
  if (localExpanded.trim()) sections.push(localExpanded);

  // Resolve user roles from host-provided env. Empty list = baseline only.
  // See container-runner.ts → resolveRolesForSession() for the lookup
  // pipeline (latest inbound chat sender → exchange-token → roles).
  const rolesEnv = (process.env.USER_ROLES || '').trim();
  const roles = rolesEnv
    ? rolesEnv
        .split(',')
        .map((r) => r.trim())
        .filter(Boolean)
    : [];

  // Non-Claude providers can't read files at runtime — inline every available
  // skill folder so the agent has all business knowledge in its system prompt.
  const skillsDir = '/app/skills';
  if (fs.existsSync(skillsDir)) {
    let skillNames: string[] = [];
    try {
      skillNames = fs.readdirSync(skillsDir).sort();
    } catch {
      skillNames = [];
    }
    for (const skillName of skillNames) {
      const skillPath = path.join(skillsDir, skillName);
      let isDir = false;
      try {
        isDir = fs.statSync(skillPath).isDirectory();
      } catch {
        isDir = false;
      }
      if (!isDir) continue;
      const skillContent = inlineSkillFolder(skillPath, budget, roles);
      if (skillContent.trim()) sections.push(skillContent);
    }
  }

  if (roles.length > 0) {
    log(`Inlined skill for roles: ${roles.join(',')}`);
  } else {
    log('Inlined skill with baseline only (no USER_ROLES env)');
  }

  return sections.join('\n\n---\n\n');
}

async function main(): Promise<void> {
  const config = loadConfig();
  const providerName = config.provider.toLowerCase() as ProviderName;

  log(`Starting v2 agent-runner (provider: ${providerName})`);

  // Runtime-generated system-prompt addendum: agent identity, memory
  // policy, and the live destinations map. Everything else (capabilities,
  // per-module instructions, per-channel formatting) is loaded by Claude
  // Code from /workspace/agent/CLAUDE.md — the composed entry imports the
  // shared base (/app/CLAUDE.md) and each enabled module's fragment.
  // Per-group memory lives in /workspace/agent/CLAUDE.local.md
  // (auto-loaded) when the selected provider supports it.
  let instructions = buildSystemPromptAddendum(config.assistantName || undefined, config.memoryMode);

  // Non-Claude providers don't auto-read CLAUDE.md/CLAUDE.local.md, so
  // expand them manually and prepend to the runtime addendum.
  if (providerName !== 'claude') {
    const expanded = buildNonClaudeSystemContext();
    if (expanded) {
      instructions = `${expanded}\n\n---\n\n${instructions}`;
      log(`Inlined CLAUDE.md context for ${providerName} provider (${expanded.length} chars)`);
    }
  }

  // Discover additional directories mounted at /workspace/extra/*
  const additionalDirectories: string[] = [];
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        additionalDirectories.push(fullPath);
      }
    }
    if (additionalDirectories.length > 0) {
      log(`Additional directories: ${additionalDirectories.join(', ')}`);
    }
  }

  // MCP server path — bun runs TS directly; no tsc build step in-image.
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'mcp-tools', 'index.ts');

  // Build MCP servers config: frontlane built-in + any from container.json
  const mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> = {
    frontlane: {
      command: 'bun',
      args: ['run', mcpServerPath],
      env: {},
    },
  };

  for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
    mcpServers[name] = serverConfig;
    log(`Additional MCP server: ${name} (${serverConfig.command})`);
  }

  const provider = createProvider(providerName, {
    assistantName: config.assistantName || undefined,
    mcpServers,
    env: { ...process.env },
    additionalDirectories: additionalDirectories.length > 0 ? additionalDirectories : undefined,
  });

  await runPollLoop({
    provider,
    providerName,
    cwd: CWD,
    systemContext: { instructions },
    idleExitMs: config.idleExitMs,
  });
}

main().catch((err) => {
  log(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
