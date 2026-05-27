/**
 * Feishu primitives — constants, tiny utility helpers, and pure transforms
 * that need no host state (no DB, no network, no mutable config). These
 * used to live at the top of feishu.ts; pulling them out keeps the main
 * file focused on adapter wiring.
 */
import crypto from 'crypto';

import { PLATFORM_PROTOCOL_NAMESPACE } from '../../branding.js';
import type { OutboundMessage } from '../adapter.js';
import type {
  FeishuApiResponse,
  FeishuConfig,
  FeishuEventMode,
  FeishuMessageEvent,
  FeishuQuestionActionPayload,
  NormalizedQuestionOption,
} from './types.js';

export const DEFAULT_BASE_URL = 'https://open.feishu.cn';
export const DEFAULT_WEBHOOK_PATH = '/webhook/feishu';
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
export const DEFAULT_BODY_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_BODY_BYTES = 128 * 1024;
export const DEFAULT_FEISHU_TEXT_LIMIT = 4_000;
// Refresh the tenant access token once we're within this window of expiry.
// Feishu tokens last ~2h; refreshing 5min early keeps concurrent API calls
// from hitting 401 mid-flight without thrashing the auth endpoint.
export const TOKEN_REFRESH_AHEAD_MS = 5 * 60_000;

export const FEISHU_REACTION_ALIASES: Record<string, string> = {
  '+1': 'THUMBSUP',
  clap: 'CLAP',
  fire: 'FIRE',
  heart: 'HEART',
  hourglass: 'HOURGLASS',
  ok: 'OK',
  thinking: 'THINKING',
  thumbs_up: 'THUMBSUP',
  thumbsup: 'THUMBSUP',
  typing: 'Typing',
  wait: 'WAIT',
  '❤️': 'HEART',
  '❤': 'HEART',
  '🔥': 'FIRE',
  '👏': 'CLAP',
  '👍': 'THUMBSUP',
  '✅': 'OK',
  '🤔': 'THINKING',
  '⌨️': 'Typing',
  '⌨': 'Typing',
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export function normalizeReactionEmojiType(value: unknown): string | undefined {
  const raw = readString(value);
  if (!raw) return undefined;
  return FEISHU_REACTION_ALIASES[raw.toLowerCase()] || FEISHU_REACTION_ALIASES[raw] || raw;
}

export function normalizeWebhookPath(value: string | undefined): string {
  const raw = (value || DEFAULT_WEBHOOK_PATH).trim();
  if (!raw) return DEFAULT_WEBHOOK_PATH;
  return raw.startsWith('/') ? raw : `/${raw}`;
}

export function normalizeFeishuEventMode(value: string | undefined): FeishuEventMode {
  const normalized = value?.trim().toLowerCase();
  switch (normalized) {
    case 'long-connection':
    case 'long_connection':
    case 'longconnection':
    case 'long':
    case 'ws':
    case 'websocket':
      return 'long-connection';
    case 'hybrid':
    case 'mixed':
    case 'both':
      return 'hybrid';
    case 'webhook':
    case undefined:
    case '':
      return 'webhook';
    default:
      return 'webhook';
  }
}

export function shouldEnableWebhook(config: FeishuConfig): boolean {
  return config.eventMode !== 'long-connection' && Boolean(config.encryptKey);
}

export function shouldEnableLongConnection(config: FeishuConfig): boolean {
  return config.eventMode !== 'webhook';
}

export function readPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function splitForLimit(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf('\n\n', limit);
    if (cut <= 0) cut = remaining.lastIndexOf('\n', limit);
    if (cut <= 0) cut = remaining.lastIndexOf(' ', limit);
    if (cut <= 0) cut = limit;
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

export function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function safeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function signFeishuBody(params: {
  encryptKey: string;
  timestamp: string;
  nonce: string;
  rawBody: string;
}): string {
  return crypto
    .createHash('sha256')
    .update(params.timestamp + params.nonce + params.encryptKey + params.rawBody)
    .digest('hex');
}

export function decryptFeishuPayload(encryptKey: string, encrypted: string): Record<string, unknown> | null {
  try {
    const data = Buffer.from(encrypted, 'base64');
    if (data.length <= 16) return null;
    const iv = data.subarray(0, 16);
    const ciphertext = data.subarray(16);
    const key = crypto.createHash('sha256').update(encryptKey).digest();
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    return parseJsonObject(plaintext);
  } catch {
    return null;
  }
}

export function extractEffectivePayload(
  rawPayload: Record<string, unknown>,
  encryptKey: string,
): Record<string, unknown> | null {
  const encrypted = readString(rawPayload.encrypt);
  if (!encrypted) return rawPayload;
  return decryptFeishuPayload(encryptKey, encrypted);
}

export function verifyFeishuSignature(
  headers: Record<string, string | string[] | undefined>,
  rawBody: string,
  encryptKey: string,
): boolean {
  const timestampHeader = headers['x-lark-request-timestamp'];
  const nonceHeader = headers['x-lark-request-nonce'];
  const signatureHeader = headers['x-lark-signature'];
  const timestamp = Array.isArray(timestampHeader) ? timestampHeader[0] : timestampHeader;
  const nonce = Array.isArray(nonceHeader) ? nonceHeader[0] : nonceHeader;
  const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
  if (!timestamp || !nonce || !signature) return false;
  return safeEqualHex(signFeishuBody({ encryptKey, timestamp, nonce, rawBody }), signature);
}

export function timestampToIso(raw: string | undefined): string {
  const trimmed = raw?.trim();
  if (!trimmed) return nowIso();
  const asNumber = Number(trimmed);
  if (Number.isFinite(asNumber)) {
    const millis = asNumber < 1_000_000_000_000 ? asNumber * 1000 : asNumber;
    return new Date(millis).toISOString();
  }
  return nowIso();
}

export function parseTextContent(rawContent: string, messageType: string): string {
  if (!rawContent) return '';
  const parsed = parseJsonObject(rawContent);
  if (!parsed) return rawContent;

  if (messageType === 'text') {
    return typeof parsed.text === 'string' ? parsed.text : '[Text message]';
  }
  if (messageType === 'post') {
    return parsePostContent(parsed);
  }
  if (messageType === 'interactive') {
    return parseInteractiveCardContent(parsed);
  }
  if (messageType === 'image') {
    // The bytes get downloaded + saved by the inbound pipeline as an
    // attachment; the agent receives a localPath in its inbox/.
    return '[图片]';
  }
  if (messageType === 'file') {
    // Try to surface the original filename so the agent has a starting
    // point even before it inspects attachments[].
    const name = readString(parsed.file_name);
    return name ? `[文件: ${name}]` : '[文件]';
  }

  if (typeof parsed.text === 'string' && parsed.text.trim()) return parsed.text;
  if (typeof parsed.title === 'string' && parsed.title.trim()) return parsed.title;
  return `[${messageType || 'unknown'} message]`;
}

/**
 * Extract image_keys from a Feishu inbound message's content payload.
 * Returns an empty array when none are present.
 *
 * Feishu shapes:
 *   - image messages: { image_key: "img_v3_..." }
 *   - post messages with embedded images: nodes have tag === 'img' with image_key
 */
export function extractImageKeys(rawContent: string, messageType: string): string[] {
  if (!rawContent) return [];
  const parsed = parseJsonObject(rawContent);
  if (!parsed) return [];
  const keys: string[] = [];
  if (messageType === 'image') {
    const k = readString(parsed.image_key);
    if (k) keys.push(k);
  }
  if (messageType === 'post' && Array.isArray(parsed.content)) {
    for (const row of parsed.content) {
      if (!Array.isArray(row)) continue;
      for (const node of row) {
        if (!isRecord(node)) continue;
        if (readString(node.tag) !== 'img') continue;
        const k = readString(node.image_key);
        if (k) keys.push(k);
      }
    }
  }
  return keys;
}

/**
 * Extract file attachment metadata from a Feishu inbound payload.
 * Returns one entry per file with the bits we need to (a) decide whether
 * to download and (b) name the saved file.
 *
 * Feishu file shape:
 *   { file_key: "file_v3_...", file_name: "...", file_size: <bytes>, file_type: "doc"|"xlsx"|... }
 *
 * `file_type` is Feishu's own taxonomy (doc, xlsx, pdf, etc); we use it
 * as a hint when file_name lacks an extension.
 */
export interface FeishuFileRef {
  fileKey: string;
  fileName: string;
  fileType: string;
  fileSize: number;
}

export function extractFileRefs(rawContent: string, messageType: string): FeishuFileRef[] {
  if (!rawContent || messageType !== 'file') return [];
  const parsed = parseJsonObject(rawContent);
  if (!parsed) return [];
  const fileKey = readString(parsed.file_key);
  if (!fileKey) return [];
  const fileName = readString(parsed.file_name) || 'attachment';
  const fileType = (readString(parsed.file_type) || '').toLowerCase();
  const sizeRaw = parsed.file_size;
  const fileSize =
    typeof sizeRaw === 'number' && Number.isFinite(sizeRaw)
      ? sizeRaw
      : typeof sizeRaw === 'string'
      ? Number.parseInt(sizeRaw, 10) || 0
      : 0;
  return [{ fileKey, fileName, fileType, fileSize }];
}

export function parsePostContent(parsed: Record<string, unknown>): string {
  const content = parsed.content;
  if (!Array.isArray(content)) return '[Post message]';
  const lines: string[] = [];
  for (const row of content) {
    if (!Array.isArray(row)) continue;
    let line = '';
    for (const node of row) {
      if (!isRecord(node)) continue;
      const tag = readString(node.tag) || '';
      if (tag === 'text') {
        line += typeof node.text === 'string' ? node.text : '';
        continue;
      }
      if (tag === 'at') {
        const name = readString(node.user_name) || readString(node.text) || 'someone';
        line += `@${name}`;
        continue;
      }
      if (tag === 'code') {
        line += `\`${typeof node.text === 'string' ? node.text : ''}\``;
        continue;
      }
      if (tag === 'code_block') {
        const lang = readString(node.language) || '';
        const code = typeof node.text === 'string' ? node.text : '';
        line += `\n\`\`\`${lang}\n${code}\n\`\`\`\n`;
        continue;
      }
      if (tag === 'a' && typeof node.text === 'string') {
        line += node.text;
      }
    }
    if (line.trim()) lines.push(line.trim());
  }
  return lines.join('\n').trim() || '[Post message]';
}

export function parseInteractiveCardContent(parsed: Record<string, unknown>): string {
  const body = isRecord(parsed.body) ? parsed.body : undefined;
  const elements = Array.isArray(parsed.elements)
    ? parsed.elements
    : Array.isArray(body?.elements)
      ? (body.elements as unknown[])
      : [];
  const texts: string[] = [];
  for (const element of elements) {
    if (!isRecord(element)) continue;
    const tag = readString(element.tag) || '';
    if (tag === 'markdown' && typeof element.content === 'string') {
      texts.push(element.content);
      continue;
    }
    if (tag === 'div' && isRecord(element.text) && typeof element.text.content === 'string') {
      texts.push(element.text.content);
      continue;
    }
    if (tag === 'note' && Array.isArray(element.elements)) {
      for (const child of element.elements) {
        if (isRecord(child) && isRecord(child.text) && typeof child.text.content === 'string') {
          texts.push(child.text.content);
        }
      }
    }
  }
  return texts.join('\n').trim() || '[Interactive card]';
}

export function extractPostMentionIds(parsed: Record<string, unknown>): string[] {
  const content = parsed.content;
  if (!Array.isArray(content)) return [];
  const mentions: string[] = [];
  for (const row of content) {
    if (!Array.isArray(row)) continue;
    for (const node of row) {
      if (!isRecord(node) || readString(node.tag) !== 'at') continue;
      const openId = readString(node.open_id) || readString(node.user_id);
      if (openId) mentions.push(openId);
    }
  }
  return mentions;
}

export function mentionsBot(event: FeishuMessageEvent, config: FeishuConfig): boolean {
  const botOpenId = config.botOpenId?.trim();
  const botName = config.botName?.trim();
  const mentions = Array.isArray(event.message.mentions) ? event.message.mentions : [];
  if (botOpenId) {
    for (const mention of mentions) {
      const mentionOpenId = readString(mention.id?.open_id) || readString(mention.id?.user_id);
      if (mentionOpenId === botOpenId) return true;
    }
    if (event.message.message_type === 'post') {
      const parsed = parseJsonObject(event.message.content);
      if (parsed && extractPostMentionIds(parsed).includes(botOpenId)) return true;
    }
  }
  if (botName) {
    for (const mention of mentions) {
      if (readString(mention.name) === botName) return true;
    }
  }
  return false;
}

export function normalizeFeishuPlatformId(params: {
  chatId: string;
  chatType: 'p2p' | 'private' | 'group';
  senderOpenId?: string;
}): string | null {
  if (params.chatType === 'p2p' || params.chatType === 'private') {
    const senderId = params.senderOpenId?.trim();
    return senderId ? `feishu:p2p:${senderId}` : null;
  }
  return `feishu:${params.chatId}`;
}

export function resolveThreadId(event: FeishuMessageEvent): string | null {
  return event.message.root_id?.trim() || event.message.thread_id?.trim() || null;
}

export function isFeishuMessageEvent(value: unknown): value is FeishuMessageEvent {
  if (!isRecord(value) || !isRecord(value.sender) || !isRecord(value.message) || !isRecord(value.sender.sender_id)) {
    return false;
  }
  const message = value.message as Record<string, unknown>;
  return (
    typeof message.message_id === 'string' &&
    typeof message.chat_id === 'string' &&
    typeof message.chat_type === 'string' &&
    typeof message.message_type === 'string' &&
    typeof message.content === 'string'
  );
}

export function isFeishuCardActionEvent(value: unknown): value is import('./types.js').FeishuCardActionEvent {
  return (
    isRecord(value) &&
    isRecord(value.operator) &&
    isRecord(value.action) &&
    isRecord(value.context) &&
    typeof value.token === 'string' &&
    isRecord(value.action.value)
  );
}

export function extractVerificationToken(payload: Record<string, unknown>): string | undefined {
  return readString(payload.token) || (isRecord(payload.header) ? readString(payload.header.token) : undefined);
}

export function parseFeishuQuestionActionPayload(value: unknown, now = Date.now()): FeishuQuestionActionPayload | null {
  if (!isRecord(value)) return null;
  if (value.kind !== `${PLATFORM_PROTOCOL_NAMESPACE}.ask_question`) return null;
  const questionId = readString(value.questionId);
  const selectedOption = readString(value.selectedOption);
  const selectedLabel = readString(value.selectedLabel);
  const expectedUserId = readString(value.expectedUserId);
  const expiresAt =
    typeof value.expiresAt === 'number' && Number.isFinite(value.expiresAt) ? value.expiresAt : undefined;
  if (!questionId || !selectedOption) return null;
  if (expiresAt !== undefined && expiresAt < now) return null;
  // pendingAction is embedded per-button when the agent set it on the
  // option. Round-trip it back so handleCardAction can sign a
  // confirm-token bound to this specific (operation, payload).
  let pendingAction: FeishuQuestionActionPayload['pendingAction'] | undefined;
  const rawAction = (value as Record<string, unknown>).pendingAction;
  if (isRecord(rawAction)) {
    const operation = readString(rawAction.operation);
    if (operation) {
      const payload = isRecord(rawAction.payload) ? (rawAction.payload as Record<string, unknown>) : {};
      pendingAction = { operation, payload };
    }
  }
  return {
    kind: 'frontlane.ask_question',
    questionId,
    selectedOption,
    selectedLabel,
    expectedUserId,
    expiresAt,
    pendingAction,
  };
}

export function normalizeOptions(raw: unknown): NormalizedQuestionOption[] {
  if (!Array.isArray(raw)) return [];
  const out: NormalizedQuestionOption[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string' && entry.trim()) {
      out.push({ label: entry.trim(), value: entry.trim(), selectedLabel: entry.trim() });
      continue;
    }
    if (!isRecord(entry)) continue;
    const label = readString(entry.label) || readString(entry.value);
    const value = readString(entry.value) || label;
    const selectedLabel = readString(entry.selectedLabel) || label;
    if (!label || !value) continue;
    const opt: NormalizedQuestionOption = { label, value, selectedLabel: selectedLabel || label };
    // Carry through optional L2 pendingAction. Reject anything malformed
    // — a button without a usable operation field shouldn't sneak through
    // because that's how confirm-token signing decides whether to mint.
    const action = entry.action;
    if (isRecord(action)) {
      const operation = readString(action.operation);
      if (operation) {
        const payload = isRecord(action.payload) ? (action.payload as Record<string, unknown>) : {};
        opt.pendingAction = { operation, payload };
      }
    }
    out.push(opt);
  }
  return out;
}

export function buildMarkdownCard(text: string, title?: string): Record<string, unknown> {
  const card: Record<string, unknown> = {
    schema: '2.0',
    config: { width_mode: 'fill' },
    body: {
      elements: [{ tag: 'markdown', content: text }],
    },
  };
  if (title) {
    card.header = {
      title: { tag: 'plain_text', content: title },
      template: 'blue',
    };
  }
  return card;
}

export function buildFeishuAskQuestionCardWithPayloads(params: {
  title: string;
  questionId: string;
  question: string;
  options: NormalizedQuestionOption[];
  expectedUserId?: string;
  expiresAt?: number;
}): Record<string, unknown> {
  // Feishu card schema v2 dropped the legacy `tag: "action"` container that
  // wrapped a list of buttons (ErrCode 200861 "cards of schema V2 no longer
  // support this capability; unsupported tag action"). The new shape lays
  // buttons out as a column_set so they sit on a single row.
  //
  // Behavior we keep from the old shape:
  //   - First option styled `primary` (the "do it" button)
  //   - Each button's `value` carries the same payload struct
  //     (kind / questionId / selectedOption / selectedLabel / expectedUserId /
  //     expiresAt) so handleCardAction parsing is unchanged.
  //   - Top-level `value` (not `behaviors[].value`) — Feishu's card.action.trigger
  //     event surfaces this verbatim as `event.action.value` regardless of card
  //     schema, so the existing parseFeishuQuestionActionPayload keeps working.
  const buttons = params.options.map((option, index) => ({
    tag: 'button',
    text: { tag: 'plain_text', content: option.label },
    type: index === 0 ? 'primary' : 'default',
    value: {
      kind: `${PLATFORM_PROTOCOL_NAMESPACE}.ask_question`,
      questionId: params.questionId,
      selectedOption: option.value,
      selectedLabel: option.selectedLabel,
      // Embed the original title + question so the click handler can
      // re-render a "confirmed" view of the same card without round-tripping
      // through the DB. Cost: each button payload carries ~the same text
      // (~1KB usually), but Feishu accepts payloads up to 8KB per element
      // and the savings of avoiding a pending_questions JOIN are worth it.
      cardTitle: params.title,
      cardQuestion: params.question,
      ...(option.pendingAction
        ? {
            // Per-button L2 action — handleCardAction signs a confirm-token
            // bound to this specific (operation, payload) when the user
            // clicks. Buttons without pendingAction (cancel / later)
            // intentionally omit it so no token gets minted.
            pendingAction: {
              operation: option.pendingAction.operation,
              payload: option.pendingAction.payload,
            },
          }
        : {}),
      ...(params.expectedUserId ? { expectedUserId: params.expectedUserId } : {}),
      ...(params.expiresAt ? { expiresAt: params.expiresAt } : {}),
    },
  }));

  return {
    schema: '2.0',
    config: { width_mode: 'fill' },
    header: {
      title: { tag: 'plain_text', content: params.title },
      template: 'blue',
    },
    body: {
      elements: [
        { tag: 'markdown', content: params.question },
        {
          tag: 'column_set',
          flex_mode: 'stretch',
          horizontal_spacing: '8px',
          columns: buttons.map((btn) => ({
            tag: 'column',
            width: 'weighted',
            weight: 1,
            elements: [btn],
          })),
        },
      ],
    },
  };
}

/**
 * Build the "post-click" version of an ask_question card. Called from
 * handleCardAction right after a user picks an option. Renders:
 *   - the original markdown question (preserved so context isn't lost)
 *   - a single info row instead of buttons: "✓ 已确认（label）" or
 *     "✗ 已取消（label）" depending on what got picked
 *   - an italic footer "由 <name> 于 HH:MM 处理"
 *
 * The header keeps the original title and template but the buttons are
 * replaced with a non-interactive markdown line — clicking the card again
 * does nothing. This gives the user instant visual feedback while the
 * agent's follow-up turn (which actually performs the action) is still
 * running.
 *
 * `acceptedLabels` is the set of selectedOption values that should render
 * the green check style (typically the primary/affirmative options like
 * "approve" / "confirm"). Anything else renders with a red ✗.
 */
export function buildFeishuAskQuestionConfirmedCard(params: {
  title: string;
  question: string;
  selectedLabel: string;
  selectedOption: string;
  operatorName?: string;
  whenIso?: string;
  approveLikeOptions?: ReadonlyArray<string>;
}): Record<string, unknown> {
  const approveLike = new Set(
    (params.approveLikeOptions ?? ['approve', 'confirm', 'yes', 'ok']).map((v) => v.toLowerCase()),
  );
  const isApprove = approveLike.has(params.selectedOption.toLowerCase());
  const mark = isApprove ? '✓' : '✗';
  const color = isApprove ? 'green' : 'red';
  // Strip a leading ✓/✗/check/×/⨯ from selectedLabel so the prepended mark
  // doesn't double up ("✓ ✓ 确认通过"). Buttons commonly carry their own
  // glyph in the label for the unclicked state.
  const cleanLabel = params.selectedLabel.replace(/^[\s ]*[✓✗×⨯⊘√✕✘✓✗][\s ]+/u, '');
  // Feishu V2 card click events don't surface operator.name (only open_id),
  // so omit the "由 X" prefix entirely unless we genuinely have a name.
  const who = params.operatorName ? `由 ${params.operatorName} ` : '';
  let timeText = '';
  if (params.whenIso) {
    try {
      const d = new Date(params.whenIso);
      const hh = `${d.getHours()}`.padStart(2, '0');
      const mm = `${d.getMinutes()}`.padStart(2, '0');
      timeText = `于 ${hh}:${mm} `;
    } catch {
      // Ignore — footer just omits the time.
    }
  }
  return {
    schema: '2.0',
    config: { width_mode: 'fill' },
    header: {
      title: { tag: 'plain_text', content: params.title },
      template: 'blue',
    },
    body: {
      elements: [
        { tag: 'markdown', content: params.question },
        {
          tag: 'markdown',
          content: `<font color="${color}">**${mark} ${escapeMarkdown(cleanLabel)}**</font>`,
        },
        {
          tag: 'markdown',
          content: `<font color="grey">${who}${timeText}处理</font>`,
        },
      ],
    },
  };
}

function escapeMarkdown(s: string): string {
  // Feishu's markdown shares enough syntax with CommonMark that bracket /
  // emphasis chars in user-supplied labels can break the rendered card.
  // Minimal escape — labels are short and we're rendering, not parsing.
  return s.replace(/([*_`[\]<>])/g, '\\$1');
}

export function buildDisplayCard(content: Record<string, unknown>): Record<string, unknown> {
  const card = content.card;
  if (!isRecord(card)) return buildMarkdownCard((content.fallbackText as string) || '[Card]');
  const title = readString(card.title);
  const description = readString(card.description);
  const children: string[] = [];
  if (description) children.push(description);
  if (Array.isArray(card.children)) {
    for (const child of card.children) {
      if (typeof child === 'string' && child.trim()) {
        children.push(child.trim());
        continue;
      }
      if (isRecord(child) && typeof child.text === 'string' && child.text.trim()) {
        children.push(child.text.trim());
      }
    }
  }
  if (Array.isArray(card.actions)) {
    for (const action of card.actions) {
      if (!isRecord(action)) continue;
      const label = readString(action.label);
      const url = readString(action.url);
      if (label && url) children.push(`- [${label}](${url})`);
    }
  }
  return buildMarkdownCard(children.join('\n\n') || (content.fallbackText as string) || '[Card]', title);
}

export function appendAttachmentSummary(text: string, files: OutboundMessage['files']): string {
  if (!files || files.length === 0) return text;
  const suffix = `Attachments: ${files.map((file) => file.filename).join(', ')}`;
  return text.trim().length > 0 ? `${text}\n\n${suffix}` : suffix;
}

export function stripChannelPrefix(platformId: string): string {
  return platformId.startsWith('feishu:') ? platformId.slice('feishu:'.length) : platformId;
}

export function resolveReceiveTarget(platformId: string): import('./types.js').FeishuReceiveTarget {
  const raw = stripChannelPrefix(platformId).trim();
  const lower = raw.toLowerCase();
  if (lower.startsWith('p2p:')) {
    const id = raw.slice('p2p:'.length).trim();
    return {
      receiveId: id,
      receiveIdType: id.startsWith('ou_') ? 'open_id' : 'user_id',
    };
  }
  if (lower.startsWith('chat:') || lower.startsWith('group:') || lower.startsWith('channel:')) {
    const receiveId = raw.slice(raw.indexOf(':') + 1).trim();
    return { receiveId, receiveIdType: 'chat_id' };
  }
  if (lower.startsWith('open_id:')) {
    return { receiveId: raw.slice('open_id:'.length).trim(), receiveIdType: 'open_id' };
  }
  if (lower.startsWith('user:') || lower.startsWith('dm:')) {
    const receiveId = raw.slice(raw.indexOf(':') + 1).trim();
    return {
      receiveId,
      receiveIdType: receiveId.startsWith('ou_') ? 'open_id' : 'user_id',
    };
  }
  if (raw.startsWith('oc_')) return { receiveId: raw, receiveIdType: 'chat_id' };
  if (raw.startsWith('ou_')) return { receiveId: raw, receiveIdType: 'open_id' };
  return { receiveId: raw, receiveIdType: 'user_id' };
}

export function isWithdrawnReplyError(response: FeishuApiResponse): boolean {
  if (response.code === 230011 || response.code === 231003) return true;
  const msg = (response.msg || '').toLowerCase();
  return msg.includes('withdrawn') || msg.includes('not found');
}
