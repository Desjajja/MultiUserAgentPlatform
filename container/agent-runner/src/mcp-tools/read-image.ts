/**
 * read_image MCP tool — lets the agent fetch an inbox image into its context.
 *
 * Why exposed via MCP:
 * - OpenAI-compatible runners don't have the Claude SDK's built-in Read tool
 * - We want the agent to read images on-demand (large images would otherwise
 *   eat the entire prompt every turn)
 *
 * Identity: the path argument is constrained to /workspace/inbox/<msgId>/<name>
 * paths under the session root. We refuse anything that escapes via .. or
 * symlinks, mirroring the inbound-side write defenses.
 *
 * Output: returns a JSON envelope describing the file plus a base64
 * payload. Provider runners that support multi-modal input can inline this
 * into the next user turn; runners that don't get a metadata blurb the
 * agent can pass to downstream OCR / vision tools later.
 */
import fs from 'fs';
import path from 'path';

import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const INBOX_ROOT = '/workspace/inbox';
const MAX_BYTES = 8 * 1024 * 1024; // 8MB — keeps a single base64 inline under ~11MB

function log(msg: string): void {
  console.error(`[read-image] ${msg}`);
}

function ok(text: string): CallToolResult {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string): CallToolResult {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

function mimeFromExt(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.bmp') return 'image/bmp';
  return 'application/octet-stream';
}

function resolveSafe(input: string): string | null {
  // Accept both absolute "/workspace/inbox/..." and bare relative entries.
  // realpath catches symlink shenanigans; we then verify containment.
  const candidate = path.isAbsolute(input) ? input : path.join(INBOX_ROOT, input);
  let real: string;
  try {
    real = fs.realpathSync(candidate);
  } catch {
    return null;
  }
  let rootReal: string;
  try {
    rootReal = fs.realpathSync(INBOX_ROOT);
  } catch {
    return null;
  }
  const rel = path.relative(rootReal, real);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return real;
}

export const readImage: McpToolDefinition = {
  tool: {
    name: 'read_image',
    description:
      '读取一张用户发到当前会话的图片。参数 path 用 inbound 消息里 attachments[].localPath 的值（一般形如 inbox/<msgId>/image-1-xxxxx.jpg）。' +
      '返回 mimeType / size / base64 数据。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description:
            "图片在 inbox/ 下的路径。可以是绝对路径 '/workspace/inbox/<msgId>/<filename>'，也可以是相对路径 '<msgId>/<filename>'。",
        },
      },
      required: ['path'],
    },
  },
  async handler(args) {
    const rawPath = typeof args.path === 'string' ? args.path.trim() : '';
    if (!rawPath) return err('path 不能为空');

    const safe = resolveSafe(rawPath);
    if (!safe) {
      return err(`路径不在 ${INBOX_ROOT}/ 下或不存在`);
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(safe);
    } catch (e) {
      return err(`无法读取文件：${e instanceof Error ? e.message : String(e)}`);
    }
    if (!stat.isFile()) {
      return err('目标不是文件');
    }
    if (stat.size > MAX_BYTES) {
      return err(`文件过大（${stat.size}b），超过 ${MAX_BYTES}b 上限`);
    }
    let buf: Buffer;
    try {
      buf = fs.readFileSync(safe);
    } catch (e) {
      return err(`读取失败：${e instanceof Error ? e.message : String(e)}`);
    }
    const mime = mimeFromExt(safe);
    log(`served ${safe} (${stat.size}b, ${mime})`);
    return ok(
      JSON.stringify({
        path: safe,
        mimeType: mime,
        size: stat.size,
        base64: buf.toString('base64'),
      }),
    );
  },
};

registerTools([readImage]);
