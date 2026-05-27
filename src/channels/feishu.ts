/**
 * Feishu channel adapter.
 *
 * Surface area is split across a few files:
 *   - feishu/types.ts       → shared type / interface declarations
 *   - feishu/primitives.ts  → pure helpers (parsing, signing, card-building)
 *
 * This file owns the stateful plumbing: env config, token cache, HTTP client
 * methods, webhook + long-connection handlers, and the outbound `deliver`
 * path. Re-exports the primitive surface so callers (and tests) can keep
 * importing from `./feishu` as before.
 */
import { EventDispatcher, LoggerLevel, WSClient } from '@larksuiteoapi/node-sdk';

import { PLATFORM_PROTOCOL_NAMESPACE } from '../branding.js';
import { markInboundSeen } from '../db/inbound-dedup.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { inboundTotal } from '../metrics.js';
import { registerWebhookHandler } from '../webhook-server.js';
import type { ChannelAdapter, ChannelSetup, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';
import { compressInboundImage } from './feishu/image-compress.js';
import { uploadImageToErp } from '../erp-uploader.js';
import type {
  FeishuApiResponse,
  FeishuCardActionEvent,
  FeishuConfig,
  FeishuMessageEvent,
  FeishuReactionItem,
  FeishuReceiveTarget,
  FeishuTenantTokenResponse,
  TokenCacheEntry,
} from './feishu/types.js';
import {
  DEFAULT_BASE_URL,
  DEFAULT_BODY_TIMEOUT_MS,
  DEFAULT_FEISHU_TEXT_LIMIT,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_REQUEST_TIMEOUT_MS,
  TOKEN_REFRESH_AHEAD_MS,
  appendAttachmentSummary,
  buildDisplayCard,
  buildFeishuAskQuestionCardWithPayloads,
  buildFeishuAskQuestionConfirmedCard,
  buildMarkdownCard,
  extractEffectivePayload,
  extractFileRefs,
  extractImageKeys,
  extractVerificationToken,
  isFeishuCardActionEvent,
  isFeishuMessageEvent,
  isRecord,
  isWithdrawnReplyError,
  mentionsBot,
  normalizeFeishuEventMode,
  normalizeFeishuPlatformId,
  normalizeOptions,
  normalizeReactionEmojiType,
  normalizeWebhookPath,
  parseFeishuQuestionActionPayload,
  parseJsonObject,
  parseTextContent,
  readPositiveInt,
  readString,
  resolveReceiveTarget,
  resolveThreadId,
  shouldEnableLongConnection,
  shouldEnableWebhook,
  splitForLimit,
  timestampToIso,
  verifyFeishuSignature,
} from './feishu/primitives.js';

// Re-export the subset of primitives that existing callers (including
// tests) reach for via `./feishu`. Keeping the public surface stable means
// external tests never broke when we moved implementations around.
// Re-export primitives for tests/callers that historically imported from
// `./feishu`. `parseFeishuQuestionActionPayload` is *also* used internally
// in this file (via the top-level import above).
export {
  decryptFeishuPayload,
  normalizeFeishuEventMode,
  normalizeFeishuPlatformId,
  parseFeishuQuestionActionPayload,
  signFeishuBody,
} from './feishu/primitives.js';

function readEnvConfig(): FeishuConfig | null {
  const dotenv = readEnvFile([
    'FEISHU_APP_ID',
    'FEISHU_APP_SECRET',
    'FEISHU_EVENT_MODE',
    'FEISHU_ENCRYPT_KEY',
    'FEISHU_VERIFICATION_TOKEN',
    'FEISHU_WEBHOOK_PATH',
    'FEISHU_BASE_URL',
    'FEISHU_REQUEST_TIMEOUT_MS',
    'FEISHU_BODY_TIMEOUT_MS',
    'FEISHU_MAX_BODY_BYTES',
    'FEISHU_BOT_OPEN_ID',
    'FEISHU_BOT_NAME',
    'ERP_BASE_URL',
    'ERP_BASE_URL_HOST',
    'ERP_AGENT_SERVICE_KEY',
  ]);
  const appId = (process.env.FEISHU_APP_ID || dotenv.FEISHU_APP_ID)?.trim();
  const appSecret = (process.env.FEISHU_APP_SECRET || dotenv.FEISHU_APP_SECRET)?.trim();
  const encryptKey = (process.env.FEISHU_ENCRYPT_KEY || dotenv.FEISHU_ENCRYPT_KEY)?.trim();
  const verificationToken = (process.env.FEISHU_VERIFICATION_TOKEN || dotenv.FEISHU_VERIFICATION_TOKEN)?.trim();
  const eventMode = normalizeFeishuEventMode(process.env.FEISHU_EVENT_MODE || dotenv.FEISHU_EVENT_MODE);
  if (!appId || !appSecret) return null;
  if (eventMode === 'webhook' && !encryptKey) {
    log.warn('Feishu adapter disabled: FEISHU_ENCRYPT_KEY is required for webhook mode');
    return null;
  }
  if (eventMode === 'hybrid' && !encryptKey) {
    log.warn('Feishu adapter starting without webhook callbacks because FEISHU_ENCRYPT_KEY is missing', {
      eventMode,
    });
  }
  return {
    appId,
    appSecret,
    encryptKey,
    verificationToken,
    webhookPath: normalizeWebhookPath(process.env.FEISHU_WEBHOOK_PATH || dotenv.FEISHU_WEBHOOK_PATH),
    baseUrl: ((process.env.FEISHU_BASE_URL || dotenv.FEISHU_BASE_URL)?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    requestTimeoutMs: readPositiveInt(
      process.env.FEISHU_REQUEST_TIMEOUT_MS || dotenv.FEISHU_REQUEST_TIMEOUT_MS,
      DEFAULT_REQUEST_TIMEOUT_MS,
    ),
    bodyTimeoutMs: readPositiveInt(
      process.env.FEISHU_BODY_TIMEOUT_MS || dotenv.FEISHU_BODY_TIMEOUT_MS,
      DEFAULT_BODY_TIMEOUT_MS,
    ),
    maxBodyBytes: readPositiveInt(
      process.env.FEISHU_MAX_BODY_BYTES || dotenv.FEISHU_MAX_BODY_BYTES,
      DEFAULT_MAX_BODY_BYTES,
    ),
    botOpenId: (process.env.FEISHU_BOT_OPEN_ID || dotenv.FEISHU_BOT_OPEN_ID)?.trim() || undefined,
    botName: (process.env.FEISHU_BOT_NAME || dotenv.FEISHU_BOT_NAME)?.trim() || undefined,
    eventMode,
    erpBaseUrl:
      (process.env.ERP_BASE_URL_HOST || dotenv.ERP_BASE_URL_HOST)?.trim() ||
      (process.env.ERP_BASE_URL || dotenv.ERP_BASE_URL)?.trim() ||
      undefined,
    erpServiceKey: (process.env.ERP_AGENT_SERVICE_KEY || dotenv.ERP_AGENT_SERVICE_KEY)?.trim() || undefined,
  };
}

// Whitelisted file extensions for `message_type=file` inbound. Mirrors the
// container-side `read_file` parser's capabilities. Anything outside this
// set lands in attachments[] as metadata-only so the agent can tell the
// user "I see the file but I don't process this type" instead of silently
// dropping the message.
const ALLOWED_FILE_EXTENSIONS = new Set([
  'csv',
  'doc',
  'docx',
  'json',
  'md',
  'pdf',
  'tsv',
  'txt',
  'xls',
  'xlsx',
  'xml',
  'yaml',
  'yml',
]);

// 20MB inline cap. Feishu's hard limit is higher, but we don't want to
// stuff arbitrary multi-MB blobs into base64 + the inbox: the agent can
// always re-request a smaller upload.
const FILE_DOWNLOAD_MAX_BYTES = 20 * 1024 * 1024;

function deriveFileExtension(fileName: string, fileType: string): string {
  const match = fileName.toLowerCase().match(/\.([a-z0-9]+)$/);
  if (match) return match[1];
  // Feishu's `file_type` taxonomy maps roughly 1:1 to extensions for the
  // common doc types; trust it as a fallback only.
  const fromFeishu = (fileType || '').toLowerCase();
  return fromFeishu;
}

function mimeForExtension(ext: string): string {
  switch (ext) {
    case 'csv':
      return 'text/csv';
    case 'doc':
      return 'application/msword';
    case 'docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'json':
      return 'application/json';
    case 'md':
      return 'text/markdown';
    case 'pdf':
      return 'application/pdf';
    case 'tsv':
      return 'text/tab-separated-values';
    case 'txt':
      return 'text/plain';
    case 'xls':
      return 'application/vnd.ms-excel';
    case 'xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case 'xml':
      return 'application/xml';
    case 'yaml':
    case 'yml':
      return 'application/yaml';
    default:
      return 'application/octet-stream';
  }
}

function createAdapter(config: FeishuConfig): ChannelAdapter {
  let setupConfig: ChannelSetup | null = null;
  let connected = false;
  let tokenCache: TokenCacheEntry | null = null;
  let tokenInflight: Promise<string> | null = null;
  let wsClient: WSClient | null = null;

  async function refreshTenantAccessToken(): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
    try {
      const response = await fetch(`${config.baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          app_id: config.appId,
          app_secret: config.appSecret,
        }),
        signal: controller.signal,
      });
      const data = (await response.json()) as FeishuTenantTokenResponse;
      if (!response.ok || data.code !== 0 || !data.tenant_access_token) {
        throw new Error(`Feishu token request failed: ${data.msg || response.statusText}`);
      }
      tokenCache = {
        token: data.tenant_access_token,
        expiresAt: Date.now() + Math.max(60, (data.expire || 7200) - 60) * 1000,
      };
      return tokenCache.token;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function fetchTenantAccessToken(): Promise<string> {
    // Proactive refresh: treat the token as expired once we're within
    // TOKEN_REFRESH_AHEAD_MS of its real expiry, so concurrent API calls
    // don't race a mid-flight 401.
    if (tokenCache && tokenCache.expiresAt - TOKEN_REFRESH_AHEAD_MS > Date.now()) {
      return tokenCache.token;
    }
    // Single-flight: coalesce concurrent refresh requests onto one auth
    // call. Without this, a spike of inbound messages on a cold cache
    // hammers /tenant_access_token/internal (and Feishu rate-limits it).
    if (tokenInflight) return tokenInflight;
    tokenInflight = refreshTenantAccessToken().finally(() => {
      tokenInflight = null;
    });
    return tokenInflight;
  }

  async function callApi<T extends FeishuApiResponse>(
    path: string,
    init: {
      method?: 'DELETE' | 'GET' | 'PATCH' | 'POST';
      body?: Record<string, unknown>;
      query?: Record<string, number | string | undefined>;
    },
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
    try {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        accept: 'application/json',
      };
      headers.Authorization = `Bearer ${await fetchTenantAccessToken()}`;
      const queryParams = new URLSearchParams();
      if (init.query) {
        for (const [key, value] of Object.entries(init.query)) {
          if (value !== undefined) {
            queryParams.set(key, String(value));
          }
        }
      }
      const query = queryParams.toString();
      const url = `${config.baseUrl}${path}${query ? `${path.includes('?') ? '&' : '?'}${query}` : ''}`;
      const response = await fetch(url, {
        method: init.method || 'POST',
        headers,
        body: init.body ? JSON.stringify(init.body) : undefined,
        signal: controller.signal,
      });
      const text = await response.text();
      const parsed = text ? (JSON.parse(text) as T) : ({ code: 0 } as T);
      if (!response.ok && parsed.code === undefined) {
        throw new Error(`Feishu API ${path} failed with ${response.status} ${response.statusText}`);
      }
      return parsed;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Download a raw binary resource attached to an inbound message (image or
   * file). Returns the bytes + content-type so callers can persist + tag the
   * file.
   *
   * Feishu endpoint:
   *   GET /open-apis/im/v1/messages/{message_id}/resources/{file_key}?type=image|file
   *
   * Auth: tenant_access_token bearer (same as the JSON API). The body is the
   * raw bytes — not JSON — so we bypass callApi() and handle the response
   * stream directly.
   */
  async function downloadMessageResource(
    messageId: string,
    fileKey: string,
    type: 'image' | 'file',
  ): Promise<{ bytes: Buffer; mimeType: string } | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
    try {
      const token = await fetchTenantAccessToken();
      const url =
        `${config.baseUrl}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}` +
        `/resources/${encodeURIComponent(fileKey)}?type=${type}`;
      const response = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      if (!response.ok) {
        log.warn('Feishu resource download failed', {
          messageId,
          fileKey,
          type,
          status: response.status,
        });
        return null;
      }
      const buf = Buffer.from(await response.arrayBuffer());
      const mimeType = response.headers.get('content-type') || 'application/octet-stream';
      return { bytes: buf, mimeType };
    } catch (err) {
      log.warn('Feishu resource download exception', {
        messageId,
        fileKey,
        err: err instanceof Error ? err.message : String(err),
      });
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function createMessage(
    target: FeishuReceiveTarget,
    msgType: 'text' | 'interactive',
    content: string,
    threadId: string | null,
  ): Promise<string | undefined> {
    if (threadId) {
      const reply = await callApi<FeishuApiResponse & { data?: { message_id?: string } }>(
        `/open-apis/im/v1/messages/${encodeURIComponent(threadId)}/reply`,
        {
          method: 'POST',
          body: {
            content,
            msg_type: msgType,
            reply_in_thread: true,
          },
        },
      );
      if (reply.code === 0) return reply.data?.message_id;
      if (!isWithdrawnReplyError(reply)) {
        throw new Error(`Feishu reply failed: ${reply.msg || `code ${reply.code}`}`);
      }
    }

    const created = await callApi<FeishuApiResponse & { data?: { message_id?: string } }>(
      `/open-apis/im/v1/messages?receive_id_type=${encodeURIComponent(target.receiveIdType)}`,
      {
        method: 'POST',
        body: {
          receive_id: target.receiveId,
          msg_type: msgType,
          content,
        },
      },
    );
    if (created.code !== 0) {
      throw new Error(`Feishu send failed: ${created.msg || `code ${created.code}`}`);
    }
    return created.data?.message_id;
  }

  async function patchMessage(messageId: string, content: string): Promise<void> {
    const response = await callApi<FeishuApiResponse>(`/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, {
      method: 'PATCH',
      body: { content },
    });
    if (response.code !== 0) {
      throw new Error(`Feishu edit failed: ${response.msg || `code ${response.code}`}`);
    }
  }

  async function recallMessage(messageId: string): Promise<void> {
    // Feishu allows the bot to recall messages it can see for ~2 minutes.
    // Used by the !bind ingress command to scrub plaintext credentials from
    // the chat after they've been consumed by the host.
    const response = await callApi<FeishuApiResponse>(`/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, {
      method: 'DELETE',
    });
    if (response.code !== 0) {
      throw new Error(`Feishu recall failed: ${response.msg || `code ${response.code}`}`);
    }
  }

  async function sendBotText(target: FeishuReceiveTarget, threadId: string | null, text: string): Promise<void> {
    await createMessage(target, 'text', JSON.stringify({ text }), threadId);
  }

  /**
   * Heuristic: should this outbound text be rendered as a Feishu markdown
   * card (with a styled title bar) instead of plain text?
   *
   * Plain text wins for terse single-line replies — a card frame feels
   * heavy when the answer is "好的，正在查". Cards win as soon as the
   * content has structure: tables, lists, headings, or just multiple
   * lines worth of formatted information.
   */
  function shouldRenderAsCard(text: string): boolean {
    const trimmed = text.trim();
    if (trimmed.length === 0) return false;
    // Multi-line content → card.
    if (/\r?\n/.test(trimmed)) return true;
    // Markdown table pipe on a single line → card (rare but explicit).
    if (/\|.*\|/.test(trimmed)) return true;
    // Long single-line plain text reads better as a quoted card.
    if (trimmed.length > 200) return true;
    return false;
  }

  /**
   * If the markdown body begins with a heading-like first line, peel it
   * off and use it as the card title bar so the body reads cleaner.
   *
   * Three accepted heading forms (in order of strictness):
   *   - `# Heading` / `## Heading`  — canonical markdown heading
   *   - `**Heading**`               — bold-only line; LLMs reach for this
   *                                   reflexively when they mean "title"
   *
   * Only the very first non-blank line is considered — a heading mid-body
   * is kept where it is, since it's structuring content rather than
   * labelling the card. The chosen line is dropped from the body, along
   * with one trailing blank separator if present.
   */
  function extractCardTitle(text: string): { title?: string; body: string } {
    const lines = text.split(/\r?\n/);
    let firstNonBlank = 0;
    while (firstNonBlank < lines.length && lines[firstNonBlank].trim() === '') {
      firstNonBlank += 1;
    }
    if (firstNonBlank >= lines.length) return { body: text };

    const line = lines[firstNonBlank];
    let title: string | undefined;

    const hashMatch = line.match(/^\s{0,3}#{1,2}\s+(.+?)\s*#*\s*$/);
    if (hashMatch) {
      title = hashMatch[1].trim();
    } else {
      // Bold-only first line: `**Title**` (no other non-whitespace content).
      // Allow trailing punctuation like `（截至今日）` outside the bold pair
      // so headers like `**青花郎库存**（截至今日）` are still lifted intact.
      const boldMatch = line.match(/^\s*\*\*(.+?)\*\*\s*([^*\s].*)?$/);
      if (boldMatch) {
        title = (boldMatch[1] + (boldMatch[2] ? boldMatch[2] : '')).trim();
      }
    }

    if (!title) return { body: text };

    // Drop the heading line plus any single blank separator that followed it
    // so we don't leave a leading blank in the body.
    let consume = firstNonBlank + 1;
    if (consume < lines.length && lines[consume].trim() === '') consume += 1;
    const body = lines.slice(consume).join('\n').trimEnd();
    return { title, body: body || ' ' };
  }

  /**
   * Try to handle the inbound message as an ingress-only command (e.g. !bind).
   *
   * Returns `true` when the message has been fully handled here and should
   * NOT be forwarded to an agent. Plaintext credentials never reach the
   * agent container's context: the host calls the ERP gateway directly,
   * recalls the original chat message, and posts a short ack as the bot.
   */
  async function tryHandleIngressCommand(params: {
    text: string;
    senderOpenId: string | undefined;
    chatId: string;
    chatType: 'p2p' | 'private' | 'group';
    messageId: string;
    threadId: string | null;
  }): Promise<boolean> {
    const trimmed = params.text.trim();
    if (!trimmed.startsWith('!')) return false;

    const [rawCmd, ...rest] = trimmed.split(/\s+/);
    const cmd = rawCmd.toLowerCase();
    if (cmd !== '!bind' && cmd !== '!unbind' && cmd !== '!help') return false;

    if (!params.senderOpenId) {
      log.warn('Ingress command rejected: no sender open_id', { cmd, messageId: params.messageId });
      return false;
    }

    const target: FeishuReceiveTarget =
      params.chatType === 'group'
        ? { receiveId: params.chatId, receiveIdType: 'chat_id' }
        : { receiveId: params.senderOpenId, receiveIdType: 'open_id' };

    if (cmd === '!help') {
      await sendBotText(
        target,
        params.threadId,
        '可用命令（用 ! 前缀，避免被飞书内置指令拦截）：\n  !bind <ERP用户名> <ERP密码>  绑定飞书账号到 ERP\n  !unbind                     解除当前飞书账号的绑定\n  !help                       查看本帮助\n\n⚠️ 飞书规则：P2P 私聊里 bot 没有撤回用户消息的权限。请你绑定成功后**长按 !bind 那条消息 → 撤回**，避免密码留在对话历史里。',
      );
      return true;
    }

    // Try to recall the original credential-bearing message. P2P chats
    // block bot-initiated recall of user messages (Feishu rule), so this
    // is best-effort — we only attempt it in group chats. The user is
    // reminded to manually recall in the ack message either way.
    let recalled = false;
    if (cmd === '!bind' && params.chatType === 'group') {
      try {
        await recallMessage(params.messageId);
        recalled = true;
      } catch (err) {
        log.warn('Ingress command: failed to recall message', {
          cmd,
          messageId: params.messageId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (cmd === '!unbind') {
      const erpResult = await callErpUnbind(params.senderOpenId);
      const ack = erpResult.ok ? '✅ 已解除绑定。' : `❌ 解除绑定失败：${erpResult.message ?? '未知错误'}`;
      await sendBotText(target, params.threadId, ack);
      return true;
    }

    // !bind <username> <password>
    if (rest.length < 2) {
      await sendBotText(
        target,
        params.threadId,
        '⚠️ !bind 用法：!bind <ERP用户名> <ERP密码>',
      );
      return true;
    }
    const username = rest[0];
    const password = rest.slice(1).join(' ');

    const erpResult = await callErpBind(params.senderOpenId, username, password);
    let ack: string;
    if (erpResult.ok) {
      const name = erpResult.employeeName || erpResult.username || 'ERP 账号';
      const roles = erpResult.roles && erpResult.roles.length > 0 ? `（${erpResult.roles.join('/')}）` : '';
      ack = `✅ 已绑定 ${name}${roles}。下次直接说出你要做的事即可。`;
    } else {
      ack = `❌ 绑定失败：${erpResult.message ?? '未知错误'}。请检查用户名/密码后重试。`;
    }
    // In P2P chats Feishu blocks bot-initiated recall, so always remind
    // the user to scrub the credential message themselves. In group
    // chats we try and only warn if the attempt failed.
    if (params.chatType !== 'group') {
      ack += '\n⚠️ 请**长按 !bind 那条消息 → 撤回**，避免密码留在对话历史。';
    } else if (!recalled) {
      ack += '\n⚠️ 自动撤回失败，请你手动长按上一条消息撤回。';
    }
    await sendBotText(target, params.threadId, ack);
    return true;
  }

  interface ErpBindResult {
    ok: boolean;
    message?: string;
    employeeName?: string;
    username?: string;
    roles?: string[];
  }

  async function callErpBind(openId: string, username: string, password: string): Promise<ErpBindResult> {
    if (!config.erpBaseUrl || !config.erpServiceKey) {
      return { ok: false, message: 'ERP_BASE_URL / ERP_AGENT_SERVICE_KEY 未配置' };
    }
    try {
      const response = await fetch(`${config.erpBaseUrl.replace(/\/+$/, '')}/api/feishu/bind`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Agent-Service-Key': config.erpServiceKey,
        },
        body: JSON.stringify({ open_id: openId, username, password }),
      });
      const text = await response.text();
      const parsed = (text ? JSON.parse(text) : {}) as Record<string, unknown>;
      if (!response.ok) {
        const detail = typeof parsed.detail === 'string' ? parsed.detail : `HTTP ${response.status}`;
        return { ok: false, message: detail };
      }
      return {
        ok: true,
        username: typeof parsed.username === 'string' ? parsed.username : undefined,
        employeeName: typeof parsed.employee_name === 'string' ? parsed.employee_name : undefined,
        roles: Array.isArray(parsed.roles) ? (parsed.roles as string[]) : undefined,
      };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  async function callErpUnbind(openId: string): Promise<ErpBindResult> {
    if (!config.erpBaseUrl || !config.erpServiceKey) {
      return { ok: false, message: 'ERP_BASE_URL / ERP_AGENT_SERVICE_KEY 未配置' };
    }
    try {
      const response = await fetch(`${config.erpBaseUrl.replace(/\/+$/, '')}/api/feishu/unbind`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Agent-Service-Key': config.erpServiceKey,
        },
        body: JSON.stringify({ open_id: openId }),
      });
      const text = await response.text();
      const parsed = (text ? JSON.parse(text) : {}) as Record<string, unknown>;
      if (!response.ok) {
        const detail = typeof parsed.detail === 'string' ? parsed.detail : `HTTP ${response.status}`;
        return { ok: false, message: detail };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  async function addReaction(messageId: string, emojiType: string): Promise<string | undefined> {
    const response = await callApi<FeishuApiResponse & { data?: { reaction_id?: string } }>(
      `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions`,
      {
        method: 'POST',
        body: {
          reaction_type: {
            emoji_type: emojiType,
          },
        },
      },
    );
    if (response.code !== 0) {
      throw new Error(`Feishu add reaction failed: ${response.msg || `code ${response.code}`}`);
    }
    return response.data?.reaction_id;
  }

  async function removeReaction(messageId: string, reactionId: string): Promise<void> {
    const response = await callApi<FeishuApiResponse>(
      `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(reactionId)}`,
      {
        method: 'DELETE',
      },
    );
    if (response.code !== 0) {
      throw new Error(`Feishu remove reaction failed: ${response.msg || `code ${response.code}`}`);
    }
  }

  async function listReactions(messageId: string, emojiType: string): Promise<FeishuReactionItem[]> {
    const response = await callApi<FeishuApiResponse & { data?: { items?: FeishuReactionItem[] } }>(
      `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions`,
      {
        method: 'GET',
        query: {
          reaction_type: emojiType,
          page_size: 50,
        },
      },
    );
    if (response.code !== 0) {
      throw new Error(`Feishu list reactions failed: ${response.msg || `code ${response.code}`}`);
    }
    return Array.isArray(response.data?.items) ? response.data.items : [];
  }

  async function readRawBody(req: import('http').IncomingMessage): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        req.off('data', onData);
        req.off('end', onEnd);
        req.off('error', onError);
        fn();
      };
      const onData = (chunk: Buffer) => {
        size += chunk.length;
        if (size > config.maxBodyBytes) {
          finish(() => reject(new Error('Payload too large')));
          return;
        }
        chunks.push(chunk);
      };
      const onEnd = () => finish(() => resolve(Buffer.concat(chunks).toString('utf8')));
      const onError = (err: Error) => finish(() => reject(err));
      const timer = setTimeout(() => {
        finish(() => reject(new Error('Request body timeout')));
      }, config.bodyTimeoutMs);
      req.on('data', onData);
      req.on('end', onEnd);
      req.on('error', onError);
    });
  }

  async function handleMessageReceive(event: FeishuMessageEvent): Promise<void> {
    if (!setupConfig) return;
    const senderId =
      readString(event.sender.sender_id.open_id) ||
      readString(event.sender.sender_id.user_id) ||
      readString(event.sender.sender_id.union_id);
    if (config.botOpenId && senderId === config.botOpenId) return;

    const platformId = normalizeFeishuPlatformId({
      chatId: event.message.chat_id,
      chatType: event.message.chat_type,
      senderOpenId: senderId,
    });
    if (!platformId) {
      log.warn('Feishu message dropped: missing sender identity for p2p chat', {
        chatId: event.message.chat_id,
        messageId: event.message.message_id,
      });
      return;
    }
    if (!markInboundSeen('feishu', `msg:${event.message.message_id}`)) {
      inboundTotal.labels('feishu', 'deduped').inc();
      return;
    }

    const isGroup = event.message.chat_type === 'group';
    const text = parseTextContent(event.message.content, event.message.message_type);
    const isMention = isGroup ? mentionsBot(event, config) : true;

    // Ingress-only commands (e.g. !bind). These are intercepted at the
    // channel boundary so plaintext credentials never enter the agent
    // container's context or the session inbound DB.
    const handled = await tryHandleIngressCommand({
      text,
      senderOpenId: senderId,
      chatId: event.message.chat_id,
      chatType: event.message.chat_type === 'private' ? 'p2p' : event.message.chat_type,
      messageId: event.message.message_id,
      threadId: resolveThreadId(event),
    });
    if (handled) {
      inboundTotal.labels('feishu', 'ingress_command').inc();
      return;
    }

    log.info('Feishu inbound message accepted', {
      messageId: event.message.message_id,
      chatId: event.message.chat_id,
      chatType: event.message.chat_type,
      senderId: senderId || null,
      isGroup,
      isMention,
    });

    // Download any inline images so the agent's container can `read_image`
    // them. We pass them as `attachments[]` with base64 data; session-manager
    // extractAttachmentFiles() writes them to `inbox/<msgId>/` and replaces
    // the entries with localPath references the container can resolve.
    const imageKeys = extractImageKeys(event.message.content, event.message.message_type);
    // attachments[] now optionally carries an erp_url so business writes
    // (报销 / 收款 / 发货 vouchers) can reference the same file in ERP.
    // The upload is best-effort and fire-and-forget per image — if it
    // fails the local copy is still on disk and the agent gets the click
    // event verbatim, just without erp_url; prompt rules tell the agent
    // to surface that to the user instead of fabricating a URL.
    const attachments: Array<{
      name: string;
      mimeType: string;
      data: string;
      erp_url?: string;
      erp_filename?: string;
      erp_size?: number;
    }> = [];
    // The original (uncompressed) bytes upload to ERP — auditors want
    // the full-resolution source, not a 1280px JPEG. The compressed copy
    // only goes to the LLM/inbox.
    const erpUploadable = senderId && /^ou_[A-Za-z0-9]+$/.test(senderId) ? senderId : null;
    for (let i = 0; i < imageKeys.length; i += 1) {
      const key = imageKeys[i];
      const dl = await downloadMessageResource(event.message.message_id, key, 'image');
      if (!dl) continue;
      // Compress big phone-camera shots before they hit the inbox + the
      // LLM. Always falls back to the original bytes if sharp is missing
      // or the source format is unrecognized.
      const compressed = await compressInboundImage(dl.bytes, dl.mimeType);
      const finalBytes = compressed?.bytes ?? dl.bytes;
      const finalMime = compressed?.mimeType ?? dl.mimeType;
      const mimeBase = finalMime.split(';')[0].trim().toLowerCase();
      const ext =
        mimeBase === 'image/jpeg'
          ? 'jpg'
          : mimeBase === 'image/png'
          ? 'png'
          : mimeBase === 'image/gif'
          ? 'gif'
          : mimeBase === 'image/webp'
          ? 'webp'
          : '';
      const keyTail = key.replace(/[^A-Za-z0-9_-]/g, '').slice(-12) || `${i + 1}`;
      const fileName = ext ? `image-${i + 1}-${keyTail}.${ext}` : `image-${i + 1}-${keyTail}`;

      // Upload to ERP under the user's identity. Skipped silently when:
      //   - sender open_id is missing or malformed
      //   - the user has not bound their ERP account yet (exchange-token
      //     returns 404 → uploadImageToErp returns null)
      //   - upload fails for any other reason (logged via uploader)
      let erpInfo: { url: string; filename: string; size: number } | null = null;
      if (erpUploadable) {
        const uploadName = ext === 'jpg' ? `${fileName.replace(/\.jpg$/, '')}.jpg` : fileName;
        const uploadMime = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'].includes(dl.mimeType)
          ? dl.mimeType
          : 'image/jpeg';
        erpInfo = await uploadImageToErp({
          openId: erpUploadable,
          bytes: dl.bytes, // ← ORIGINAL bytes, not compressed
          filename: uploadName,
          mimeType: uploadMime,
        });
      }

      log.debug('Feishu inbound image processed', {
        messageId: event.message.message_id,
        idx: i + 1,
        sourceBytes: dl.bytes.length,
        finalBytes: finalBytes.length,
        sourceMime: dl.mimeType,
        finalMime,
        compressed: !!compressed,
        erpUploaded: !!erpInfo,
        erpUrl: erpInfo?.url,
      });
      attachments.push({
        name: fileName,
        mimeType: finalMime,
        data: finalBytes.toString('base64'),
        ...(erpInfo
          ? { erp_url: erpInfo.url, erp_filename: erpInfo.filename, erp_size: erpInfo.size }
          : {}),
      });
    }

    // Download `message_type=file` attachments (docs, sheets, PDFs, …). We
    // allow-list extensions to avoid pulling random binaries into the
    // session; everything outside the list shows up as a metadata-only
    // breadcrumb so the user gets a clear "I see the file but don't
    // process this type" response from the agent.
    const fileRefs = extractFileRefs(event.message.content, event.message.message_type);
    for (const ref of fileRefs) {
      const ext = deriveFileExtension(ref.fileName, ref.fileType);
      if (!ALLOWED_FILE_EXTENSIONS.has(ext)) {
        log.warn('Feishu inbound: rejecting file with disallowed extension', {
          messageId: event.message.message_id,
          fileName: ref.fileName,
          ext,
        });
        attachments.push({
          name: ref.fileName,
          mimeType: 'application/octet-stream',
          // Tiny placeholder so attachments[] still surfaces the file's
          // existence to the agent — base64 of "<unsupported file type>"
          data: Buffer.from(`Unsupported file type: ${ext || '(unknown)'}`).toString('base64'),
        });
        continue;
      }
      if (ref.fileSize > FILE_DOWNLOAD_MAX_BYTES) {
        log.warn('Feishu inbound: file too large, skipping bytes', {
          messageId: event.message.message_id,
          fileName: ref.fileName,
          size: ref.fileSize,
        });
        attachments.push({
          name: ref.fileName,
          mimeType: mimeForExtension(ext),
          data: Buffer.from(`File too large to inline (${ref.fileSize} bytes).`).toString('base64'),
        });
        continue;
      }
      const dl = await downloadMessageResource(event.message.message_id, ref.fileKey, 'file');
      if (!dl) continue;
      attachments.push({
        name: ref.fileName,
        mimeType: dl.mimeType || mimeForExtension(ext),
        data: dl.bytes.toString('base64'),
      });
    }

    await setupConfig.onInbound(platformId, resolveThreadId(event), {
      id: event.message.message_id,
      kind: 'chat',
      timestamp: timestampToIso(event.message.create_time),
      content: {
        senderId: senderId || undefined,
        sender: senderId || 'feishu-user',
        text,
        chatId: event.message.chat_id,
        chatType: event.message.chat_type,
        messageType: event.message.message_type,
        messageId: event.message.message_id,
        rootId: event.message.root_id,
        parentId: event.message.parent_id,
        threadId: event.message.thread_id,
        mentions: event.message.mentions ?? [],
        ...(attachments.length > 0 ? { attachments } : {}),
      },
      isMention,
      isGroup,
    });
  }

  async function startLongConnection(): Promise<void> {
    if (wsClient) return;

    const eventDispatcher = new EventDispatcher({ loggerLevel: LoggerLevel.warn }).register({
      'im.message.receive_v1': async (data: unknown) => {
        log.info('Feishu long-connection payload accepted', {
          eventType: 'im.message.receive_v1',
        });
        if (!isFeishuMessageEvent(data)) {
          log.warn('Feishu long-connection message ignored: unsupported payload shape');
          return;
        }
        await handleMessageReceive(data);
      },
      // Card button clicks come through this event. Without registering
      // it here the long-connection client returns 200672 "card action
      // not handled" to Feishu, the user sees a red error toast, and the
      // bot never wakes. The webhook path also handles this event (see
      // handleWebhook below) but most deployments run long-connection
      // only — that's why we keep both wiring sites in sync.
      'card.action.trigger': async (data: unknown) => {
        log.info('Feishu long-connection payload accepted', {
          eventType: 'card.action.trigger',
        });
        if (!isFeishuCardActionEvent(data)) {
          log.warn('Feishu long-connection card action ignored: unsupported payload shape');
          return;
        }
        // handleCardAction returns the new card object (Feishu V2 schema)
        // so the dispatcher / SDK can include it in the synchronous
        // response. With this in place the Feishu client immediately
        // re-renders the card to its "confirmed" state — without it the
        // client briefly shows "已点击" then reverts because no card
        // update arrived inline with the click response.
        return await handleCardAction(data);
      },
    });

    wsClient = new WSClient({
      appId: config.appId,
      appSecret: config.appSecret,
      loggerLevel: LoggerLevel.error,
      source: PLATFORM_PROTOCOL_NAMESPACE,
      onReady: () => {
        log.info('Feishu long-connection ready');
      },
      onReconnecting: () => {
        log.warn('Feishu long-connection reconnecting');
      },
      onReconnected: () => {
        log.info('Feishu long-connection reconnected');
      },
      onError: (err: Error) => {
        log.error('Feishu long-connection error', { err });
      },
    });

    await wsClient.start({ eventDispatcher });
  }

  async function handleCardAction(event: FeishuCardActionEvent): Promise<unknown> {
    if (!setupConfig) return;
    const token = event.token.trim();
    if (!token) return;
    if (!markInboundSeen('feishu', `action:${token}`)) {
      inboundTotal.labels('feishu', 'deduped').inc();
      return;
    }
    const action = parseFeishuQuestionActionPayload(event.action.value);
    if (!action) {
      log.warn('Feishu card action ignored: unsupported payload', {
        token,
        chatId: event.context.chat_id,
      });
      return;
    }
    const operatorUserId =
      readString(event.operator.open_id) ||
      readString(event.operator.user_id) ||
      readString(event.operator.union_id) ||
      '';
    if (action.expectedUserId && operatorUserId && action.expectedUserId !== operatorUserId) {
      log.warn('Feishu card action rejected: wrong user', {
        token,
        expectedUserId: action.expectedUserId,
        operatorUserId,
      });
      return;
    }

    setupConfig.onAction(action.questionId, action.selectedOption, operatorUserId, {
      selectedLabel: action.selectedLabel,
      pendingAction: action.pendingAction,
    });

    // Build the "post-click" card from the original title/question
    // embedded in the button payload + who clicked it. Returning this
    // object as the dispatcher response makes Feishu render the new
    // card inline with the click — no separate patchMessage HTTP call,
    // no "已点击" flicker. See the sibling registration comment in
    // startLongConnection for why this matters.
    const rawValue = (event.action.value ?? {}) as Record<string, unknown>;
    const cardTitle = readString(rawValue.cardTitle) || '已收到您的选择';
    const cardQuestion = readString(rawValue.cardQuestion) || '';
    const operatorName = readString(event.operator.name);
    const confirmedCard = buildFeishuAskQuestionConfirmedCard({
      title: cardTitle,
      question: cardQuestion,
      selectedLabel: action.selectedLabel || action.selectedOption,
      selectedOption: action.selectedOption,
      operatorName,
      whenIso: new Date().toISOString(),
    });
    return {
      // Feishu V2 inline-update response shape: top-level object with
      // `toast` (optional, small banner) + `card` (the new card body in
      // schema 2.0). The `type: "raw"` wrapper tells Feishu to use this
      // object verbatim as the new card content.
      toast: {
        type: action.selectedOption.toLowerCase().match(/^(approve|confirm|yes|ok)$/) ? 'success' : 'info',
        content: action.selectedLabel || action.selectedOption,
      },
      card: {
        type: 'raw',
        data: confirmedCard,
      },
    };
  }

  async function handleWebhook(req: import('http').IncomingMessage, res: import('http').ServerResponse): Promise<void> {
    log.info('Feishu webhook request received', {
      method: req.method || 'unknown',
      path: req.url || config.webhookPath,
      contentType: Array.isArray(req.headers['content-type'])
        ? req.headers['content-type'][0]
        : req.headers['content-type'],
    });
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Method Not Allowed');
      return;
    }
    const contentType = req.headers['content-type'];
    const contentTypeValue = Array.isArray(contentType) ? contentType[0] : contentType;
    if (!contentTypeValue || !contentTypeValue.toLowerCase().includes('application/json')) {
      res.writeHead(415, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Unsupported Media Type');
      return;
    }

    try {
      const rawBody = await readRawBody(req);
      if (!config.encryptKey || !verifyFeishuSignature(req.headers, rawBody, config.encryptKey)) {
        log.warn('Feishu webhook rejected: invalid signature', {
          path: req.url || config.webhookPath,
          timestamp: Array.isArray(req.headers['x-lark-request-timestamp'])
            ? req.headers['x-lark-request-timestamp'][0]
            : req.headers['x-lark-request-timestamp'],
        });
        res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Invalid signature');
        return;
      }

      const outerPayload = parseJsonObject(rawBody);
      if (!outerPayload) {
        log.warn('Feishu webhook rejected: invalid JSON');
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Invalid JSON');
        return;
      }
      const payload = extractEffectivePayload(outerPayload, config.encryptKey);
      if (!payload) {
        log.warn('Feishu webhook rejected: invalid encrypted payload');
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Invalid encrypted payload');
        return;
      }

      const verificationToken = extractVerificationToken(payload);
      if (config.verificationToken && verificationToken && verificationToken !== config.verificationToken) {
        log.warn('Feishu webhook rejected: invalid verification token');
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Invalid verification token');
        return;
      }

      if (payload.type === 'url_verification' && typeof payload.challenge === 'string') {
        log.info('Feishu webhook url_verification handled');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ challenge: payload.challenge }));
        return;
      }

      if (isFeishuCardActionEvent(payload)) {
        const cardResp = await handleCardAction(payload);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(cardResp ?? {}));
        return;
      }

      const header = isRecord(payload.header) ? payload.header : null;
      const eventType = header ? readString(header.event_type) : undefined;
      const eventData = payload.event;
      log.info('Feishu webhook payload accepted', {
        eventType: eventType || (isFeishuCardActionEvent(payload) ? 'card.action.trigger' : 'unknown'),
      });
      if (eventType === 'im.message.receive_v1' && isFeishuMessageEvent(eventData)) {
        await handleMessageReceive(eventData);
      } else if (eventType === 'card.action.trigger' && isFeishuCardActionEvent(eventData)) {
        await handleCardAction(eventData);
      } else {
        log.debug('Feishu webhook event ignored', { eventType: eventType || 'unknown' });
      }

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end('{}');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message === 'Payload too large' ? 413 : message === 'Request body timeout' ? 408 : 500;
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(status === 413 ? 'Payload too large' : status === 408 ? 'Request body timeout' : 'Internal Server Error');
      if ((status === 413 || status === 408) && !req.destroyed) {
        req.destroy();
      }
      log.error('Feishu webhook handler failed', { err });
    }
  }

  const adapter: ChannelAdapter = {
    name: 'feishu',
    channelType: 'feishu',
    supportsThreads: true,

    async setup(hostConfig: ChannelSetup): Promise<void> {
      setupConfig = hostConfig;
      const webhookEnabled = shouldEnableWebhook(config);
      let longConnectionEnabled = false;

      if (webhookEnabled) {
        registerWebhookHandler(config.webhookPath, handleWebhook);
      }

      if (shouldEnableLongConnection(config)) {
        try {
          await startLongConnection();
          longConnectionEnabled = true;
        } catch (err) {
          wsClient = null;
          if (!webhookEnabled) throw err;
          log.error('Feishu long-connection startup failed; continuing with webhook only', { err });
        }
      }

      if (!webhookEnabled && !longConnectionEnabled) {
        throw new Error('Feishu adapter failed to start: no active webhook or long-connection transport');
      }

      connected = true;
      log.info('Feishu adapter initialized', {
        eventMode: config.eventMode,
        webhookEnabled,
        webhookPath: config.webhookPath,
        longConnectionEnabled,
        botOpenId: config.botOpenId || null,
      });
    },

    async teardown(): Promise<void> {
      connected = false;
      setupConfig = null;
      tokenCache = null;
      wsClient?.close({ force: true });
      wsClient = null;
    },

    isConnected(): boolean {
      return connected;
    },

    async deliver(platformId: string, threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
      const content = isRecord(message.content) ? message.content : {};

      if (content.operation === 'reaction') {
        const action = readString(content.action)?.toLowerCase();
        const messageId = readString(content.messageId);
        const reactionId = readString(content.reactionId);
        const emojiType = normalizeReactionEmojiType(content.emojiType ?? content.emoji);

        if (!action || !messageId) {
          throw new Error('Feishu reaction operation requires action and messageId');
        }

        if (action === 'add') {
          if (!emojiType) {
            throw new Error('Feishu reaction add requires emoji or emojiType');
          }
          return addReaction(messageId, emojiType);
        }

        if (action === 'remove') {
          if (reactionId) {
            await removeReaction(messageId, reactionId);
            return reactionId;
          }
          if (!emojiType) {
            throw new Error('Feishu reaction remove requires reactionId or emoji/emojiType');
          }
          const items = await listReactions(messageId, emojiType);
          const mine = items.find((item) => item.reaction_id && item.operator?.operator_type === 'app');
          if (!mine?.reaction_id) return undefined;
          await removeReaction(messageId, mine.reaction_id);
          return mine.reaction_id;
        }

        throw new Error(`Unsupported Feishu reaction action: ${action}`);
      }

      if (content.operation === 'edit' && typeof content.messageId === 'string') {
        if (isRecord(content.card)) {
          await patchMessage(content.messageId, JSON.stringify(content.card));
          return content.messageId;
        }
        const text = appendAttachmentSummary(
          (typeof content.markdown === 'string'
            ? content.markdown
            : typeof content.text === 'string'
              ? content.text
              : ''
          ).trim(),
          message.files,
        );
        await patchMessage(content.messageId, JSON.stringify(buildMarkdownCard(text || '[Updated]')));
        return content.messageId;
      }

      const target = resolveReceiveTarget(platformId);

      if (content.type === 'ask_question' && typeof content.questionId === 'string') {
        const title = typeof content.title === 'string' && content.title.trim() ? content.title.trim() : 'Question';
        const question = typeof content.question === 'string' ? content.question : '';
        const options = normalizeOptions(content.options);
        if (options.length === 0) {
          throw new Error('Feishu ask_question requires at least one option');
        }
        const expectedUserId = target.receiveIdType === 'open_id' ? target.receiveId : undefined;
        // Honor agent-supplied expiresAt; default to 7 days. Cards with no
        // expiry get rejected on click after this window.
        const expiresAt =
          typeof content.expiresAt === 'number' && content.expiresAt > Date.now()
            ? content.expiresAt
            : Date.now() + 7 * 24 * 60 * 60 * 1000;
        const card = buildFeishuAskQuestionCardWithPayloads({
          title,
          questionId: content.questionId,
          question,
          options,
          expectedUserId,
          expiresAt,
        });
        return createMessage(target, 'interactive', JSON.stringify(card), threadId);
      }

      if (content.type === 'card') {
        const card = buildDisplayCard(content);
        return createMessage(target, 'interactive', JSON.stringify(card), threadId);
      }

      const rawText =
        (typeof content.markdown === 'string' ? content.markdown : undefined) ||
        (typeof content.text === 'string' ? content.text : undefined) ||
        '';
      const text = appendAttachmentSummary(rawText, message.files);
      if (!text.trim()) return undefined;

      // Render multi-line or markdown-rich replies as a Feishu interactive
      // card so tables, lists, and headings actually render. Short single-
      // line replies stay as plain text (a card title bar would feel heavy
      // for a one-liner). Heuristic: any newline, any markdown-table pipe,
      // any list/heading prefix → card.
      const useCard = shouldRenderAsCard(text);
      if (useCard) {
        // If the markdown begins with a `# ` or `## ` heading, lift it out
        // and use it as the card's blue title bar so the body reads
        // cleaner. Explicit `content.title` still wins.
        const explicitTitle = typeof content.title === 'string' && content.title.trim() ? content.title.trim() : undefined;
        const { title: extractedTitle, body } = extractCardTitle(text);
        const title = explicitTitle || extractedTitle;
        const card = buildMarkdownCard(body, title);
        return createMessage(target, 'interactive', JSON.stringify(card), threadId);
      }

      const chunks = splitForLimit(text, DEFAULT_FEISHU_TEXT_LIMIT);
      let firstId: string | undefined;
      for (let index = 0; index < chunks.length; index += 1) {
        const messageId = await createMessage(
          target,
          'text',
          JSON.stringify({ text: chunks[index] }),
          index === 0 ? threadId : null,
        );
        if (index === 0) firstId = messageId;
      }
      return firstId;
    },

    async setTyping(): Promise<void> {
      // Feishu bot API doesn't expose a useful typing indicator for this flow.
    },

    async openDM(userHandle: string): Promise<string> {
      const normalized = userHandle.trim();
      return `feishu:p2p:${normalized}`;
    },
  };

  return adapter;
}

const envConfig = readEnvConfig();
registerChannelAdapter('feishu', {
  factory: () => (envConfig ? createAdapter(envConfig) : null),
});
