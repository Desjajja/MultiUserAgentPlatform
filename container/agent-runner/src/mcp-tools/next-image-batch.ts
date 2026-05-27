/**
 * next_image_batch MCP tool — pull the next N queued images into the next turn.
 *
 * When the user dumps a stack of barcode / receipt photos at once, the host
 * inlines only the first MAX_IMAGES_PER_TURN into the current user message
 * and parks the rest in `session_state.image_queue`. This tool drops a
 * sentinel file at `/workspace/.queue_continuation` so the next poll-loop
 * iteration synthesizes a wake-up turn that pulls the queue head.
 *
 * Why not just write to inbound.db: the host is the sole writer on that
 * file (DELETE journal mode, no cross-process write coordination). A
 * sentinel file dodges the locking problem entirely.
 *
 * After calling this tool the agent's turn ends naturally — the next
 * poll cycle inside the same container picks up the sentinel and runs
 * a fresh in-memory turn with the next image batch attached.
 */
import fs from 'fs';

import { getImageQueue } from '../db/session-state.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const SENTINEL_PATH = '/workspace/.queue_continuation';

function log(msg: string): void {
  console.error(`[next-image-batch] ${msg}`);
}

function ok(text: string): CallToolResult {
  return { content: [{ type: 'text' as const, text }] };
}

export const nextImageBatch: McpToolDefinition = {
  tool: {
    name: 'next_image_batch',
    description:
      '从图片队列里取下一批图片到下一个 turn 来看。' +
      '**调完此工具：本 turn 必须就此结束**，新 turn 启动时图片队列头会自动 inline 给你（你能直接看到像素）。' +
      '只在你刚处理完上一批、且 `<image_queue pending="N">` 里 N>0 时调；如果队列空（pending=0 或没有这个标签）就不要调。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        note: {
          type: 'string',
          description: '可选。给新 turn 的自己留一句话，比如 "继续扫第 4-6 箱条码"。',
        },
      },
      required: [],
    },
  },
  async handler(args) {
    const queue = getImageQueue();
    if (queue.length === 0) {
      return ok(
        JSON.stringify({
          remaining: 0,
          message: '队列为空，没有更多图片。继续完成你正在做的事吧（提交出库 / 入库 / 报销等）。',
        }),
      );
    }
    const note = typeof args.note === 'string' ? args.note.trim() : '';
    const remaining = queue.length;
    try {
      fs.writeFileSync(
        SENTINEL_PATH,
        JSON.stringify({ note, requestedAt: new Date().toISOString(), remaining }),
        'utf-8',
      );
    } catch (e) {
      return ok(
        JSON.stringify({
          remaining,
          warning: `无法写 queue 哨兵: ${e instanceof Error ? e.message : String(e)}`,
        }),
      );
    }
    log(`sentinel written (remaining=${remaining}, note="${note.slice(0, 50)}")`);
    return ok(
      JSON.stringify({
        remaining,
        message: '已请求下一批图片。**这一 turn 结束**，下一轮 poll 时你能看到下一批图片的像素。',
      }),
    );
  },
};

registerTools([nextImageBatch]);