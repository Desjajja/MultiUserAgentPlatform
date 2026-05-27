/**
 * XinJiuLong ERP MCP tool — a single HTTP wrapper the agent uses to call
 * /api/* on the ERP backend without needing Bash/curl/Read.
 *
 * Why this exists: when the runner uses an OpenAI-compatible model, the
 * Claude-built-in `Bash`/`Read`/`Write` tools are not available. Without a
 * dedicated tool, an OpenAI agent has no way to reach the ERP at all and
 * ends up hallucinating bind loops. This tool gives it one focused capability.
 *
 * Identity: the agent does NOT supply the open_id. We read the most recent
 * chat inbound row directly from inbound.db (which the host writes, and
 * which is mounted into this MCP subprocess), so a prompt-injected agent
 * cannot impersonate someone else.
 *
 * NB: this MCP server is a separate stdio subprocess from the agent
 * runner, so the in-process `getRequestIdentity()` ref does NOT cross
 * process boundaries here. The DB read is the only trustworthy source.
 */
import { createHmac, randomUUID } from 'node:crypto';

import { openInboundDb } from '../db/connection.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const DEFAULT_TIMEOUT_MS = 20_000;

interface JwtCacheEntry {
  token: string;
  expiresAt: number;
}

const jwtCache = new Map<string, JwtCacheEntry>();

function log(msg: string): void {
  console.error(`[xinjiulong-erp] ${msg}`);
}

function ok(text: string): CallToolResult {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string): CallToolResult {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

function envOr(key: string, fallback: string): string {
  return process.env[key] && process.env[key]!.length > 0 ? (process.env[key] as string) : fallback;
}

function erpBaseUrl(): string {
  return envOr('ERP_BASE_URL', 'http://host.docker.internal:8080').replace(/\/+$/, '');
}

function serviceKey(): string | undefined {
  return process.env.ERP_AGENT_SERVICE_KEY;
}

/**
 * Pull the most recent chat inbound row's trusted user id.
 *
 * Trust order matches request-identity.ts:
 *   1. origin_user_id column (set by the host on a2a forwards; container
 *      cannot forge)
 *   2. content.senderId (set by the host channel adapter)
 *
 * Namespaces a bare id with `<channel_type>:` if the senderId doesn't
 * already include a colon. Returns null when neither is available — the
 * caller surfaces that as "no Feishu identity" so the agent doesn't try
 * to call ERP on behalf of an unknown user.
 */
function readTrustedUserId(): string | null {
  let db;
  try {
    db = openInboundDb();
  } catch (e) {
    log(`openInboundDb failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
  let row: { origin_user_id: string | null; channel_type: string | null; content: string | null } | undefined;
  try {
    row = db
      .prepare(
        "SELECT origin_user_id, channel_type, content FROM messages_in WHERE kind IN ('chat','chat-sdk') ORDER BY seq DESC LIMIT 1",
      )
      .get() as typeof row;
  } catch (e) {
    log(`inbound query failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  } finally {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
  if (!row) return null;
  const origin = row.origin_user_id?.trim();
  if (origin) return origin;
  try {
    const parsed = JSON.parse(row.content ?? '{}') as Record<string, unknown>;
    const raw = typeof parsed.senderId === 'string' ? parsed.senderId.trim() : '';
    if (!raw) return null;
    if (raw.includes(':') || !row.channel_type) return raw;
    return `${row.channel_type}:${raw}`;
  } catch {
    return null;
  }
}

function extractOpenId(userId: string | null | undefined): string | null {
  if (!userId) return null;
  const m = userId.match(/^feishu:(ou_[A-Za-z0-9]+)$/);
  return m ? m[1] : null;
}

async function exchangeToken(openId: string): Promise<{ token: string; ttlSec: number } | { error: string; status: number }> {
  const key = serviceKey();
  if (!key) return { error: 'ERP_AGENT_SERVICE_KEY 未配置', status: 500 };
  const url = `${erpBaseUrl()}/api/feishu/exchange-token`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Agent-Service-Key': key },
      body: JSON.stringify({ open_id: openId }),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      return { error: text || `HTTP ${res.status}`, status: res.status };
    }
    const parsed = (text ? JSON.parse(text) : {}) as { access_token?: string; expires_in?: number };
    if (!parsed.access_token) return { error: 'exchange-token 返回缺少 access_token', status: 500 };
    return { token: parsed.access_token, ttlSec: parsed.expires_in ?? 900 };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e), status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

async function getJwt(openId: string): Promise<{ token: string } | { error: string; status: number }> {
  const cached = jwtCache.get(openId);
  if (cached && cached.expiresAt > Date.now() + 30_000) {
    return { token: cached.token };
  }
  const fresh = await exchangeToken(openId);
  if ('error' in fresh) return fresh;
  jwtCache.set(openId, { token: fresh.token, expiresAt: Date.now() + fresh.ttlSec * 1000 });
  return { token: fresh.token };
}

export const erpRequest: McpToolDefinition = {
  tool: {
    name: 'erp_request',
    description:
      '调用新鑫久隆 ERP /api/* 接口。自动处理身份换 token（基于当前用户的飞书 open_id），不要在参数里传账号密码或 open_id。' +
      '查询类接口直接调；写入类（建单、收款、审批…）必须先 preview，再让用户在飞书卡片上确认。' +
      '如果返回 needs_bind:true，请告诉用户用 !bind <用户名> <密码> 命令绑定。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        method: {
          type: 'string',
          enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
          description: 'HTTP 方法',
        },
        path: {
          type: 'string',
          description:
            '/api/ 开头的 ERP 接口路径，例如 /api/inventory/query?brand=青花郎 或 /api/orders/preview',
        },
        body: {
          type: 'object',
          description: '请求体（POST/PUT/PATCH 用）。GET 不传',
          additionalProperties: true,
        },
        auth: {
          type: 'string',
          enum: ['jwt', 'service-key'],
          description:
            '认证方式。默认 jwt（当前用户身份）。少数服务端到服务端的内部端点（如 /api/users/by-role）要 service-key，传 "service-key" 切换。service-key 模式不能用来执行个人身份的写操作。',
        },
      },
      required: ['method', 'path'],
    },
  },
  async handler(args) {
    const method = String(args.method || 'GET').toUpperCase();
    const rawPath = String(args.path || '');
    if (!rawPath.startsWith('/api/')) {
      return err(`path 必须以 /api/ 开头，收到："${rawPath}"`);
    }

    const authMode = args.auth === 'service-key' ? 'service-key' : 'jwt';
    const url = `${erpBaseUrl()}${rawPath}`;
    const headers: Record<string, string> = { 'content-type': 'application/json' };

    let openIdForLog = '';
    if (authMode === 'service-key') {
      // Service-key mode — used for internal directory / config endpoints
      // (e.g. /api/users/by-role) that don't represent a particular user's
      // action. We never carry user identity here; ERP treats the request
      // as system-level read.
      const k = serviceKey();
      if (!k) return err('ERP_AGENT_SERVICE_KEY 未配置');
      headers['X-Agent-Service-Key'] = k;
    } else {
      // Default JWT mode — derive identity from inbound.db (host-written,
      // unforgeable), exchange-token, attach Bearer JWT.
      const userId = readTrustedUserId();
      const openId = extractOpenId(userId);
      if (!openId) {
        return err(
          `无法识别当前用户的飞书身份。从 inbound.db 读到的 userId = ${userId ?? 'null'}。` +
            `检查 messages_in 最近一行是否有 origin_user_id 或 content.senderId。如果是后台系统调用（无用户上下文），传 auth: "service-key" 改用服务密钥。`,
        );
      }
      openIdForLog = openId;
      const jwtResult = await getJwt(openId);
      if ('error' in jwtResult) {
        if (jwtResult.status === 404) {
          return ok(
            JSON.stringify({
              needs_bind: true,
              message: `飞书 open_id ${openId} 还没有绑定 ERP 账号。请提示用户发送：!bind <ERP用户名> <ERP密码>`,
            }),
          );
        }
        return err(`换取登录态失败 (HTTP ${jwtResult.status})：${jwtResult.error}`);
      }
      headers.authorization = `Bearer ${jwtResult.token}`;
    }

    const init: RequestInit = { method, headers };
    if (method !== 'GET' && method !== 'DELETE' && args.body !== undefined) {
      init.body = JSON.stringify(args.body ?? {});
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    init.signal = controller.signal;

    try {
      const res = await fetch(url, init);
      const text = await res.text();
      log(`${method} ${rawPath} auth=${authMode} → HTTP ${res.status} (${text.length}b)`);
      if (res.status === 401 && authMode === 'jwt' && openIdForLog) {
        jwtCache.delete(openIdForLog);
        return ok(
          JSON.stringify({
            unauthorized: true,
            message: '登录态已失效。请重新发送原业务请求，系统会自动重新换取登录态。',
          }),
        );
      }
      let parsed: unknown = text;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        // keep raw text
      }
      return ok(
        JSON.stringify({
          status: res.status,
          ok: res.ok,
          body: parsed,
        }),
      );
    } catch (e) {
      return err(`ERP 请求失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      clearTimeout(timer);
    }
  },
};

/**
 * Sign a body with HMAC-SHA256 using the ERP gateway protocol:
 *   msg = `${ts}.${nonce}.${body}`
 *   sig = hex(hmac_sha256(secret, msg))
 *
 * Returns the three header values; absent FRONTLANE_HMAC_SECRET → null,
 * caller surfaces a clear error to the agent so writes don't half-go.
 */
function buildHmacHeaders(rawBody: string): { ts: string; nonce: string; sig: string } | null {
  const secret = process.env.FRONTLANE_HMAC_SECRET;
  if (!secret) return null;
  const ts = Math.floor(Date.now() / 1000).toString();
  const nonce = randomUUID();
  const msg = `${ts}.${nonce}.${rawBody}`;
  const sig = createHmac('sha256', secret).update(msg).digest('hex');
  return { ts, nonce, sig };
}

/**
 * Auto intent-id — pull the most recent chat inbound row's id and use it
 * as x-intent-id when the agent didn't pass one. Lets ERP audit_logs
 * group all execute calls produced by the same incoming user message
 * (including the dryRun + commit pair) without the agent having to
 * remember to thread the id through.
 */
function autoIntentId(): string | null {
  let db;
  try {
    db = openInboundDb();
  } catch {
    return null;
  }
  try {
    const row = db
      .prepare(
        `SELECT id FROM messages_in
         WHERE kind IN ('chat','chat-sdk')
         ORDER BY seq DESC
         LIMIT 1`,
      )
      .get() as { id?: string } | undefined;
    return row?.id ?? null;
  } catch {
    return null;
  } finally {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
}

interface ExecuteAttempt {
  status: number;
  text: string;
  ok: boolean;
  parsed: unknown;
}

async function postOnce(
  url: string,
  headers: Record<string, string>,
  rawBody: string,
): Promise<ExecuteAttempt> {
  // Each attempt gets its own timeout — the outer retry loop can sleep
  // 60s between tries without tripping a single shared abort signal.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: 'POST', headers, body: rawBody, signal: controller.signal });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // keep raw
    }
    return { status: res.status, text, ok: res.ok, parsed };
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Read the confirm-token that was minted at click-time and stamped onto
 * an inbound row by host's interactive module.
 *
 * If `explicitQuestionId` is provided we look for the matching button_click
 * row by questionId; otherwise we just take the most recent button_click
 * with a confirmToken. Returns null if nothing matches — the caller adds
 * no X-User-Confirm header and ERP rejects with 403 (clear signal that
 * the user hasn't clicked the right button yet).
 */
function readConfirmToken(explicitQuestionId?: string): string | null {
  let db;
  try {
    db = openInboundDb();
  } catch {
    return null;
  }
  try {
    // Pull recent button_click rows; we filter for confirmToken in JS
    // because the JSON column makes a SQL filter awkward.
    const rows = db
      .prepare(
        `SELECT content
         FROM messages_in
         WHERE kind IN ('chat','chat-sdk')
           AND content LIKE '%"kind":"button_click"%'
           AND content LIKE '%"confirmToken"%'
         ORDER BY seq DESC
         LIMIT 20`,
      )
      .all() as Array<{ content: string }>;
    for (const row of rows) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(row.content) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (parsed.kind !== 'button_click') continue;
      const token = typeof parsed.confirmToken === 'string' ? parsed.confirmToken : '';
      if (!token) continue;
      if (explicitQuestionId) {
        const qid = typeof parsed.questionId === 'string' ? parsed.questionId : '';
        if (qid !== explicitQuestionId) continue;
      }
      return token;
    }
    return null;
  } catch {
    return null;
  } finally {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
}

export const erpExecute: McpToolDefinition = {
  tool: {
    name: 'erp_execute',
    description:
      '调用 ERP 的 /api/agent/execute 网关 — **所有 L2 写操作必须用这个工具**（不是 erp_request）。' +
      '会自动签 HMAC、加 X-User-Confirm（来自上一次按钮点击）、x-channel: ai-agent、x-intent-id 审计标签。' +
      '建单 / 审批 / 发工资 / 收款 / 调拨 等都走这条；查询用 erp_request 即可。' +
      '使用方式：第一次 dryRun=true 拿 preview → 用户在 ask_user_question 卡片上点确认 → 新 turn 里 dryRun=false 真执行。' +
      '如果返回 403 unauthorized 说明缺 X-User-Confirm（用户还没点按钮）。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        operation: {
          type: 'string',
          description:
            'L2 operation 名（如 orders.create_with_policy、orders.approve_policy_with_request、payroll.batch_pay 等，参 ai-gateway.md 里的路由表）',
        },
        payload: {
          type: 'object',
          description: '业务字段。具体 schema 看 api-reference 对应 operation',
          additionalProperties: true,
        },
        dryRun: {
          type: 'boolean',
          description:
            'true = 试跑，事务内 SAVEPOINT + ROLLBACK，返回 preview 数据但不动账。false = 真执行（必须先有 X-User-Confirm）',
          default: false,
        },
        idempotencyKey: {
          type: 'string',
          description:
            '可选。重发同样的 idempotencyKey 24h 内会拿同样的结果（不会重复扣账）。dryRun=false 强烈建议带；ts+随机字符串即可',
        },
        intentId: {
          type: 'string',
          description: '可选。同次会话多次调用聚合用，建议传 questionId 或 session-turn',
        },
        questionId: {
          type: 'string',
          description:
            '可选。如果这次 execute 是某次按钮点击的 follow-up，传 questionId 让 host 把对应的 X-User-Confirm 注入',
        },
      },
      required: ['operation', 'payload'],
    },
  },
  async handler(args) {
    const userId = readTrustedUserId();
    const openId = extractOpenId(userId);
    if (!openId) {
      return err(
        `无法识别当前用户的飞书身份。从 inbound.db 读到的 userId = ${userId ?? 'null'}。`,
      );
    }

    const operation = String(args.operation || '').trim();
    if (!operation) return err('operation 不能为空');
    const dryRun = args.dryRun === true;
    const payload = (args.payload && typeof args.payload === 'object' ? args.payload : {}) as Record<string, unknown>;

    const jwtResult = await getJwt(openId);
    if ('error' in jwtResult) {
      if (jwtResult.status === 404) {
        return ok(
          JSON.stringify({
            needs_bind: true,
            message: `飞书 open_id ${openId} 还没绑定 ERP 账号。请用 !bind 绑定。`,
          }),
        );
      }
      return err(`换取登录态失败 (HTTP ${jwtResult.status})：${jwtResult.error}`);
    }

    // Build the request body in canonical form once — the HMAC must sign
    // the *exact* bytes that ship in the body, otherwise ERP rejects with
    // "signature mismatch". Don't reformat / re-stringify between sign
    // and send.
    const bodyObj: Record<string, unknown> = {
      operation,
      payload,
      dryRun,
    };
    if (typeof args.idempotencyKey === 'string' && args.idempotencyKey) {
      bodyObj.idempotencyKey = args.idempotencyKey;
    }
    const rawBody = JSON.stringify(bodyObj);

    const hmac = buildHmacHeaders(rawBody);
    if (!hmac) {
      return err(
        'FRONTLANE_HMAC_SECRET 未配置；erp_execute 无法签名。host 那边 .env 里要加这个 secret。',
      );
    }

    const headers: Record<string, string> = {
      authorization: `Bearer ${jwtResult.token}`,
      'content-type': 'application/json',
      'x-frontlane-timestamp': hmac.ts,
      'x-frontlane-nonce': hmac.nonce,
      'x-frontlane-signature': hmac.sig,
      // Audit trail — required by ERP audit_logs to mark actor_kind=ai_agent_assisted.
      'x-channel': 'ai-agent',
    };
    // intent-id — agent override > inbound message id auto-fallback.
    // Lets ERP group multi-step flows (preview + commit) under one row.
    const explicitIntent =
      typeof args.intentId === 'string' && args.intentId.trim() ? args.intentId.trim() : undefined;
    const intentId = explicitIntent ?? autoIntentId() ?? undefined;
    if (intentId) {
      headers['x-intent-id'] = intentId;
    }
    const confirmToken = readConfirmToken(
      typeof args.questionId === 'string' ? args.questionId : undefined,
    );
    if (confirmToken) {
      headers['x-user-confirm'] = confirmToken;
    }

    const url = `${erpBaseUrl()}/api/agent/execute`;
    // Retry policy:
    //   401 → JWT stale → clear cache + surface unauthorized to agent
    //         (don't retry; ERP will re-issue when next request comes).
    //   403 → permission / signature / token issue → DO NOT retry.
    //         Re-signing or replaying changes nothing; only the agent's
    //         next decision can fix it.
    //   429 → backoff 60s and retry once. Agent should not hammer ERP.
    //   500 / 502 / 503 / 504 → transient. If idempotencyKey is set,
    //         retry once with the SAME key (ERP dedup makes this safe).
    //         Without an idempotencyKey we don't retry: a write might
    //         have already partially committed.
    //   2xx / 4xx → return as-is, agent decides.
    const idempotencyKey = typeof args.idempotencyKey === 'string' ? args.idempotencyKey : '';
    const transientStatuses = new Set([500, 502, 503, 504]);

    // Each postOnce() has its own per-attempt timeout — no outer
    // controller needed. The retry loop is sequential and may sleep up
    // to 60s between attempts.
    let attempt: ExecuteAttempt;
    try {
      attempt = await postOnce(url, headers, rawBody);
    } catch (e) {
      return err(`erp_execute 请求失败：${e instanceof Error ? e.message : String(e)}`);
    }
    log(
      `execute ${operation} dryRun=${dryRun} → HTTP ${attempt.status} (${attempt.text.length}b)` +
        (intentId ? ` intent=${intentId}` : ''),
    );

    // 429 → wait 60s, single retry. Respect Retry-After body field if
    // ERP provides it, otherwise default to 60.
    if (attempt.status === 429) {
      const retryAfterHeader = (attempt.parsed && typeof attempt.parsed === 'object'
        ? (attempt.parsed as { retry_after?: number }).retry_after
        : undefined);
      const waitSec = typeof retryAfterHeader === 'number' && retryAfterHeader > 0 ? retryAfterHeader : 60;
      log(`execute 429 → backing off ${waitSec}s, retrying once`);
      await sleep(waitSec * 1000);
      // Sign fresh headers — the original timestamp may now be > 5min old.
      const hmac2 = buildHmacHeaders(rawBody);
      if (hmac2) {
        headers['x-frontlane-timestamp'] = hmac2.ts;
        headers['x-frontlane-nonce'] = hmac2.nonce;
        headers['x-frontlane-signature'] = hmac2.sig;
      }
      try {
        attempt = await postOnce(url, headers, rawBody);
        log(`execute 429-retry → HTTP ${attempt.status}`);
      } catch (e) {
        return err(`erp_execute 重试失败：${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // 5xx + idempotency → single retry with same key. ERP's idempotency
    // cache returns the original result if the first attempt actually
    // committed; if it didn't, the retry reaches a fresh code path.
    // Either way the agent never doubles up an action.
    if (transientStatuses.has(attempt.status) && idempotencyKey) {
      log(`execute ${attempt.status} → retrying once with same idempotencyKey`);
      await sleep(1500);
      const hmac3 = buildHmacHeaders(rawBody);
      if (hmac3) {
        headers['x-frontlane-timestamp'] = hmac3.ts;
        headers['x-frontlane-nonce'] = hmac3.nonce;
        headers['x-frontlane-signature'] = hmac3.sig;
      }
      try {
        attempt = await postOnce(url, headers, rawBody);
        log(`execute 5xx-retry → HTTP ${attempt.status}`);
      } catch (e) {
        return err(`erp_execute 重试失败：${e instanceof Error ? e.message : String(e)}`);
      }
    }

    if (attempt.status === 401) {
      jwtCache.delete(openId);
      return ok(
        JSON.stringify({
          unauthorized: true,
          message: '登录态已失效。请重新发送业务请求自动重新换取登录态。',
          }),
        );
      }

    return ok(
      JSON.stringify({
        status: attempt.status,
        ok: attempt.ok,
        body: attempt.parsed,
      }),
    );
  },
};

registerTools([erpRequest, erpExecute]);
