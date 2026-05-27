/**
 * read_file MCP tool — lets the agent inspect a non-image inbox attachment.
 *
 * Why exposed via MCP:
 * - OpenAI-compatible runners don't have the Claude SDK's built-in Read tool
 * - Text files would otherwise need a separate ingestion path
 *
 * Output shape varies by file type:
 *   - .txt / .csv / .tsv / .md / .json / .xml / .yaml / .yml → raw text
 *     (utf-8 decoded, truncated to MAX_TEXT_CHARS with an obvious marker)
 *   - .xlsx / .xls → first sheet's header row + first PREVIEW_ROWS data rows
 *     as JSON, plus sheet-name list and row-count totals for the rest
 *   - .pdf / .doc / .docx → metadata only (size, name); we don't ship a
 *     PDF/Word parser today
 *
 * Identity: the path argument is constrained to inbox/<msgId>/<file> paths
 * under the session root (same realpath defense as read_image).
 */
import fs from 'fs';
import path from 'path';

import * as XLSX from 'xlsx';

import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const INBOX_ROOT = '/workspace/inbox';
const MAX_BYTES = 25 * 1024 * 1024;
const MAX_TEXT_CHARS = 200_000;
const PREVIEW_ROWS = 50;

function log(msg: string): void {
  console.error(`[read-file] ${msg}`);
}

function ok(text: string): CallToolResult {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string): CallToolResult {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

function resolveSafe(input: string): string | null {
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

function extOf(p: string): string {
  const m = p.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

function previewSheet(workbook: XLSX.WorkBook, sheetName: string): {
  headers: string[];
  rows: Array<Record<string, unknown>>;
  totalRows: number;
} {
  const ws = workbook.Sheets[sheetName];
  if (!ws) return { headers: [], rows: [], totalRows: 0 };
  // header: 1 → first row becomes the keys (raw array form), letting us
  // emit explicit headers + row dicts in a stable order regardless of
  // missing cells.
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: null, blankrows: false });
  if (aoa.length === 0) return { headers: [], rows: [], totalRows: 0 };
  const rawHeaders = aoa[0].map((h) => (h == null ? '' : String(h)));
  const headers: string[] = [];
  const seen = new Map<string, number>();
  for (const h of rawHeaders) {
    const base = h.trim() || 'col';
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    headers.push(n === 0 ? base : `${base}_${n + 1}`);
  }
  const dataRows = aoa.slice(1);
  const previewRows = dataRows.slice(0, PREVIEW_ROWS).map((row) => {
    const dict: Record<string, unknown> = {};
    for (let i = 0; i < headers.length; i += 1) {
      dict[headers[i]] = row[i] ?? null;
    }
    return dict;
  });
  return { headers, rows: previewRows, totalRows: dataRows.length };
}

export const readFile: McpToolDefinition = {
  tool: {
    name: 'read_file',
    description:
      '读取一个用户发到当前会话的非图片文件（txt/csv/md/json/xlsx/xls/pdf/doc/docx 等）。' +
      '参数 path 用 inbound 消息里 attachments[].localPath 的值。返回内容根据文件类型不同：' +
      '文本类返回 utf-8 文本（≤200k 字符），Excel 类返回第一张表的表头 + 前 50 行 JSON，PDF/Word 暂时只返元数据。' +
      '想看图片用 read_image，不要用这个工具。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description:
            "文件在 inbox/ 下的路径。可以是绝对路径 '/workspace/inbox/<msgId>/<filename>'，也可以是相对路径 '<msgId>/<filename>'。",
        },
        sheet: {
          type: 'string',
          description: '可选。Excel 文件指定 sheet 名（默认第一个 sheet）',
        },
      },
      required: ['path'],
    },
  },
  async handler(args) {
    const rawPath = typeof args.path === 'string' ? args.path.trim() : '';
    if (!rawPath) return err('path 不能为空');

    const safe = resolveSafe(rawPath);
    if (!safe) return err(`路径不在 ${INBOX_ROOT}/ 下或不存在`);

    let stat: fs.Stats;
    try {
      stat = fs.statSync(safe);
    } catch (e) {
      return err(`无法读取文件：${e instanceof Error ? e.message : String(e)}`);
    }
    if (!stat.isFile()) return err('目标不是文件');
    if (stat.size > MAX_BYTES) {
      return err(`文件过大（${stat.size}b），超过 ${MAX_BYTES}b 上限`);
    }

    const ext = extOf(safe);
    const name = path.basename(safe);

    // Text-like formats — utf-8 decode + truncate.
    if (['txt', 'csv', 'tsv', 'md', 'json', 'xml', 'yaml', 'yml'].includes(ext)) {
      let text: string;
      try {
        text = fs.readFileSync(safe, 'utf-8');
      } catch (e) {
        return err(`读取失败：${e instanceof Error ? e.message : String(e)}`);
      }
      const truncated = text.length > MAX_TEXT_CHARS;
      const body = truncated ? text.slice(0, MAX_TEXT_CHARS) : text;
      log(`served text ${safe} (${stat.size}b, ${ext}, ${truncated ? 'truncated' : 'full'})`);
      return ok(
        JSON.stringify({
          path: safe,
          name,
          ext,
          size: stat.size,
          totalChars: text.length,
          truncated,
          text: body,
        }),
      );
    }

    // Excel — first sheet preview + sheet-name index for the rest.
    if (ext === 'xlsx' || ext === 'xls') {
      let workbook: XLSX.WorkBook;
      try {
        workbook = XLSX.readFile(safe, { cellDates: true });
      } catch (e) {
        return err(`Excel 解析失败：${e instanceof Error ? e.message : String(e)}`);
      }
      const requested = typeof args.sheet === 'string' ? args.sheet.trim() : '';
      const sheetName = requested && workbook.SheetNames.includes(requested) ? requested : workbook.SheetNames[0];
      if (!sheetName) return err('Excel 文件没有任何 sheet');
      const { headers, rows, totalRows } = previewSheet(workbook, sheetName);
      log(`served excel ${safe} sheet=${sheetName} rows=${rows.length}/${totalRows}`);
      return ok(
        JSON.stringify({
          path: safe,
          name,
          ext,
          size: stat.size,
          sheetNames: workbook.SheetNames,
          activeSheet: sheetName,
          headers,
          previewRows: rows,
          previewRowCount: rows.length,
          totalRowCount: totalRows,
          truncated: totalRows > rows.length,
        }),
      );
    }

    // PDF / Word — metadata only for now. The agent should tell the user
    // we don't read these yet, or ask them to paste relevant content as text.
    if (ext === 'pdf' || ext === 'doc' || ext === 'docx') {
      log(`served metadata ${safe} (${ext})`);
      return ok(
        JSON.stringify({
          path: safe,
          name,
          ext,
          size: stat.size,
          message: `当前不支持自动解析 ${ext.toUpperCase()} 内容。建议让用户把关键信息以文字形式粘贴过来，或者另存为 .txt/.xlsx 重新上传。`,
        }),
      );
    }

    return err(`不支持的文件类型：${ext || '(无扩展名)'}`);
  },
};

registerTools([readFile]);
