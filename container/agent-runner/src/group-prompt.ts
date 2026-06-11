import fs from 'fs';
import path from 'path';

import type { MemoryMode } from './config.js';
import { buildSystemPromptAddendum } from './destinations.js';

export function readGroupLocalPrompt(cwd: string): string {
  const file = path.join(cwd, 'CLAUDE.local.md');
  if (!fs.existsSync(file)) return '';
  return fs.readFileSync(file, 'utf8').trim();
}

export function buildSystemInstructions(opts: {
  cwd: string;
  provider: string;
  assistantName?: string;
  memoryMode?: MemoryMode;
}): string {
  const injectLocal = opts.provider !== 'claude';
  const local = injectLocal ? readGroupLocalPrompt(opts.cwd) : '';
  const addendum = buildSystemPromptAddendum(local ? undefined : opts.assistantName, opts.memoryMode);
  return [local, addendum].filter(Boolean).join('\n\n');
}
