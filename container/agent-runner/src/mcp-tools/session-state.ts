/**
 * session_state MCP tools — let the agent persist small key/value
 * state across turns / container restarts.
 *
 * Backing store: `session_state` table in outbound.db. Already used by
 * provider continuations + image queue, so a small KV surface here is a
 * natural extension.
 *
 * Use cases:
 * - approval scan fingerprint (don't re-spam the same digest)
 * - per-user preferences the agent picks up in conversation
 * - any short-lived counter the agent wants to remember between turns
 *
 * Constraints:
 * - keys: ASCII alnum + `_:-.`, max 128 chars (so we don't allow random
 *   bytes that would collide with internal keys like `continuation:openai`)
 * - values: max 16KB (this is short-state storage, not a transcript dump)
 * - reserved prefixes (rejected): `continuation:`, `sdk_session_id`,
 *   `image_queue`, anything starting with `_`. These are framework-owned.
 */
import { getOutboundDb } from '../db/connection.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const MAX_VALUE_BYTES = 16 * 1024;
const MAX_KEY_LEN = 128;
const KEY_RE = /^[A-Za-z0-9_:\-.]+$/;
const RESERVED_PREFIXES = ['continuation:', 'sdk_session_id', 'image_queue', '_'];

function log(msg: string): void {
  console.error(`[session-state] ${msg}`);
}

function ok(text: string): CallToolResult {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string): CallToolResult {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

function validateKey(key: string): string | null {
  if (!key || typeof key !== 'string') return 'key 必须是非空字符串';
  if (key.length > MAX_KEY_LEN) return `key 长度超过 ${MAX_KEY_LEN}`;
  if (!KEY_RE.test(key)) return 'key 只能包含字母 / 数字 / 下划线 / 冒号 / 点 / 短横线';
  for (const reserved of RESERVED_PREFIXES) {
    if (key.startsWith(reserved)) {
      return `key 前缀 "${reserved}" 是平台保留，不允许 agent 写入`;
    }
  }
  return null;
}

export const stateGet: McpToolDefinition = {
  tool: {
    name: 'state_get',
    description:
      '读 session_state 里的一个 key（agent 自己的 KV 持久化，跨 turn / 容器重启都在）。返回 { value: string | null }。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        key: { type: 'string', description: 'KV 键名' },
      },
      required: ['key'],
    },
  },
  async handler(args) {
    const key = typeof args.key === 'string' ? args.key.trim() : '';
    const reason = validateKey(key);
    if (reason) return err(reason);
    const row = getOutboundDb()
      .prepare('SELECT value FROM session_state WHERE key = ?')
      .get(key) as { value: string } | undefined;
    log(`state_get ${key} → ${row ? `${row.value.length}b` : 'null'}`);
    return ok(JSON.stringify({ key, value: row?.value ?? null }));
  },
};

export const stateSet: McpToolDefinition = {
  tool: {
    name: 'state_set',
    description:
      '写 session_state 里的一个 key。value 必须是字符串（如果要存对象，自己 JSON.stringify）。最大 16KB。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        key: { type: 'string', description: 'KV 键名' },
        value: { type: 'string', description: '要写入的值（字符串）' },
      },
      required: ['key', 'value'],
    },
  },
  async handler(args) {
    const key = typeof args.key === 'string' ? args.key.trim() : '';
    const reason = validateKey(key);
    if (reason) return err(reason);
    const value = typeof args.value === 'string' ? args.value : '';
    if (Buffer.byteLength(value, 'utf-8') > MAX_VALUE_BYTES) {
      return err(`value 超过 ${MAX_VALUE_BYTES} 字节上限`);
    }
    getOutboundDb()
      .prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
      .run(key, value, new Date().toISOString());
    log(`state_set ${key} ← ${value.length}b`);
    return ok(JSON.stringify({ ok: true, key }));
  },
};

registerTools([stateGet, stateSet]);