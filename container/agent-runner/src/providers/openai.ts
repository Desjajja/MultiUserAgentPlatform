import { createHash } from 'node:crypto';
import * as fsForImages from 'node:fs';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

import { touchHeartbeat } from '../db/connection.js';
import { setContinuation } from '../db/session-state.js';
import { registerProvider } from './provider-registry.js';
import type {
  AgentProvider,
  AgentQuery,
  ImageAttachmentRef,
  McpServerConfig,
  ProviderEvent,
  ProviderOptions,
  QueryInput,
} from './types.js';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-5.4';
const DEFAULT_TIMEOUT_MS = 120_000;
const HEARTBEAT_INTERVAL_MS = 10_000;
const MAX_REQUEST_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 1_500;
// Transcript replay budget. The OpenAI-compatible model gets sent
// `[system prompt] + [transcript] + [new user message]` every turn — see
// transcriptToChatMessages(). With system prompt ~150KB (CLAUDE.md +
// inlined skill), capping transcript at ~400KB keeps total request well
// under gpt-5.4's 200k-token (~600-700KB) limit while still giving room
// for the running tool-call history of a real multi-turn business flow
// (建单 → preview → ask_user_question → click → create).
//
// Why this size matters specifically: with non-blocking ask_user_question,
// the agent's transcript across a card click can span days. We need to
// retain enough history that the click-resumed turn sees the original
// ask_user_question round + the ERP preview that informed it; otherwise
// the agent has to re-query the world to figure out what it was doing.
//
// Bumped from 128 items / 120KB after observing that a typical build-an-
// order flow produces ~12-20 transcript items totaling ~80KB, leaving
// almost no headroom for multi-step approvals or scans.
const MAX_REPLAY_TRANSCRIPT_ITEMS = 512;
const MAX_REPLAY_TRANSCRIPT_CHARS = 400_000;
const PREVIOUS_RESPONSE_UNSUPPORTED_RE = /previous_response_id.*(?:responses websocket v2|only supported)/i;
const RESPONSES_TRANSPORT_FALLBACK_RE =
  /non-json response \((502|503|504)\)|unreadable sse response \((502|503|504)\)|request failed with status (502|503|504)|upstream request failed|bad gateway|gateway timeout|service unavailable/i;
const INVALID_SESSION_RE =
  /response.*not found|unknown response|invalid response|previous_response_id.*(?:not found|does not exist|invalid)/i;

type JsonObject = Record<string, unknown>;

interface OpenAIFunctionTool {
  type: 'function';
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
  strict?: boolean;
}

interface OpenAIResponseError {
  message?: string;
}

interface OpenAIResponse {
  id?: string;
  status?: string;
  error?: OpenAIResponseError | null;
  incomplete_details?: { reason?: string } | null;
  output?: OpenAIOutputItem[];
  output_text?: string;
}

interface OpenAIOutputItem extends JsonObject {
  type?: string;
}

interface OpenAIFunctionCall extends OpenAIOutputItem {
  type: 'function_call';
  call_id?: string;
  name?: string;
  arguments?: string;
}

interface OpenAIChatCompletionResponse {
  id?: string;
  error?: OpenAIResponseError | null;
  choices?: Array<{
    message?: {
      role?: string;
      content?: string | Array<{ type?: string; text?: string }>;
      tool_calls?: Array<{
        id?: string;
        type?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason?: string | null;
  }>;
}

interface ToolBinding {
  client: Client;
  originalName: string;
}

interface ConnectedMcpServer {
  client: Client;
}

type ContinuationMode = 'responses' | 'stateless';
type OpenAITransport = 'responses' | 'chat-completions';

interface OpenAIContinuationState {
  v: 1 | 2;
  mode: ContinuationMode;
  transport: OpenAITransport;
  responseId?: string;
  transcript: JsonObject[];
}

function log(msg: string): void {
  console.error(`[openai-provider] ${msg}`);
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeBaseUrl(raw: string | undefined): string {
  const trimmed = (raw || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  if (!trimmed) return DEFAULT_BASE_URL;
  if (/\/v\d+$/i.test(trimmed)) return trimmed;
  return `${trimmed}/v1`;
}

function sanitizeToolSegment(raw: string): string {
  const normalized = raw
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_');
  return normalized || 'tool';
}

function qualifyToolName(serverName: string, toolName: string, used: Set<string>): string {
  const base = `mcp__${sanitizeToolSegment(serverName)}__${sanitizeToolSegment(toolName)}`;
  if (base.length <= 64 && !used.has(base)) {
    used.add(base);
    return base;
  }

  const hash = createHash('sha256').update(`${serverName}:${toolName}`).digest('hex').slice(0, 8);
  const maxPrefix = Math.max(1, 64 - hash.length - 1);
  let candidate = `${base.slice(0, maxPrefix)}_${hash}`;
  let suffix = 2;
  while (used.has(candidate)) {
    const suffixText = `_${suffix++}`;
    candidate = `${candidate.slice(0, Math.max(1, 64 - suffixText.length))}${suffixText}`;
  }
  used.add(candidate);
  return candidate;
}

function defaultInputSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {},
    additionalProperties: true,
  };
}

function toolInputSchema(tool: Tool): Record<string, unknown> {
  const raw =
    (tool as unknown as { inputSchema?: unknown; input_schema?: unknown }).inputSchema ??
    (tool as unknown as { inputSchema?: unknown; input_schema?: unknown }).input_schema;
  return isRecord(raw) ? raw : defaultInputSchema();
}

function formatToolResult(result: CallToolResult): string {
  const parts: string[] = [];
  const withStructured = result as CallToolResult & { structuredContent?: unknown };

  if (withStructured.structuredContent !== undefined) {
    parts.push(JSON.stringify(withStructured.structuredContent, null, 2));
  }

  if (Array.isArray(result.content)) {
    for (const item of result.content) {
      if (!isRecord(item)) {
        parts.push(String(item));
        continue;
      }
      if (item.type === 'text' && typeof item.text === 'string') {
        parts.push(item.text);
        continue;
      }
      if ('json' in item) {
        parts.push(JSON.stringify(item.json, null, 2));
        continue;
      }
      parts.push(JSON.stringify(item, null, 2));
    }
  }

  if (parts.length === 0) {
    return result.isError ? 'Tool returned an error with no details.' : 'Tool completed successfully with no output.';
  }

  const joined = parts
    .filter((part) => part.trim().length > 0)
    .join('\n\n')
    .trim();
  return (
    joined ||
    (result.isError ? 'Tool returned an error with no details.' : 'Tool completed successfully with no output.')
  );
}

function collectFunctionCalls(output: OpenAIOutputItem[] | undefined): OpenAIFunctionCall[] {
  if (!Array.isArray(output)) return [];
  return output.filter((item): item is OpenAIFunctionCall => item.type === 'function_call');
}

function extractOutputText(response: OpenAIResponse): string | null {
  if (typeof response.output_text === 'string' && response.output_text.trim()) {
    return response.output_text;
  }

  const parts: string[] = [];
  for (const item of response.output ?? []) {
    if (!isRecord(item) || item.type !== 'message') continue;
    const content = Array.isArray(item.content) ? item.content : [];
    for (const block of content) {
      if (!isRecord(block)) continue;
      if ((block.type === 'output_text' || block.type === 'text') && typeof block.text === 'string') {
        parts.push(block.text);
      }
    }
  }

  const text = parts.join('\n').trim();
  return text || null;
}

function transcriptSize(item: JsonObject): number {
  try {
    return JSON.stringify(item).length;
  } catch {
    return 0;
  }
}

function trimTranscript(items: JsonObject[]): JsonObject[] {
  const capped = items.slice(-MAX_REPLAY_TRANSCRIPT_ITEMS);
  if (capped.length === 0) return capped;

  const sizes = capped.map(transcriptSize);
  let total = sizes.reduce((sum, size) => sum + size, 0);
  let start = 0;
  while (total > MAX_REPLAY_TRANSCRIPT_CHARS && start < capped.length - 1) {
    total -= sizes[start] ?? 0;
    start += 1;
  }

  // Heal a dangling function_call_output / tool message at the head.
  //
  // Both the OpenAI Responses API and Chat Completions API require every
  // tool output to follow its matching function_call in the same message
  // list. If trimming drops the preceding function_call but keeps its
  // output, the next request fails with:
  //   "No tool call found for function call output with call_id fc_xxx"
  //   "未找到 call_id 为 fc_xxx 的函数调用输出对应的工具调用"
  //
  // Skip orphan tool messages at the new head until we land on something
  // safe to start replay from (a user/assistant message or a fresh
  // function_call followed by its output). Worst case we walk all the
  // way to capped.length, returning [] — which is still a valid replay
  // (the next user prompt drives a fresh round).
  while (start < capped.length) {
    const head = capped[start];
    const headType = typeof head?.type === 'string' ? head.type : '';
    const headRole = typeof head?.role === 'string' ? head.role : '';
    if (headType === 'function_call_output' || headRole === 'tool') {
      start += 1;
      continue;
    }
    break;
  }

  // Pair-aware sweep: drop any function_call_output whose preceding
  // function_call is missing AND any function_call whose function_call_output
  // is missing.
  //
  // Why this matters even after the head-heal: in a multi-round transcript,
  // a partial trim can land in the middle (e.g. call_X kept but call_Y
  // and its preceding function_call got dropped between rounds). The
  // upstream API rejects with the same error pointing at the orphan.
  //
  // Algorithm: build the set of call_ids present as function_call. Then
  // filter: keep every item except function_call_output whose call_id
  // isn't in the set. Also separately filter function_call without any
  // matching output — though OpenAI is more forgiving about that
  // direction (it just thinks the agent ignored its tool result), better
  // safe than sorry.
  const sliced = capped.slice(start);
  const callIds = new Set<string>();
  const outputIds = new Set<string>();
  for (const item of sliced) {
    if (!item || typeof item !== 'object') continue;
    const t = (item as { type?: unknown }).type;
    const cid = (item as { call_id?: unknown }).call_id;
    if (typeof cid !== 'string' || !cid) continue;
    if (t === 'function_call') callIds.add(cid);
    else if (t === 'function_call_output') outputIds.add(cid);
  }
  const orphanOutputs = new Set<string>();
  for (const id of outputIds) if (!callIds.has(id)) orphanOutputs.add(id);
  const orphanCalls = new Set<string>();
  for (const id of callIds) if (!outputIds.has(id)) orphanCalls.add(id);
  if (orphanOutputs.size === 0 && orphanCalls.size === 0) return sliced;

  return sliced.filter((item) => {
    if (!item || typeof item !== 'object') return true;
    const t = (item as { type?: unknown }).type;
    const cid = (item as { call_id?: unknown }).call_id;
    if (typeof cid !== 'string' || !cid) return true;
    if (t === 'function_call' && orphanCalls.has(cid)) return false;
    if (t === 'function_call_output' && orphanOutputs.has(cid)) return false;
    return true;
  });
}

/**
 * Per-item cap for individual tool outputs.
 *
 * The agent's MCP tools occasionally return very large payloads:
 * - erp_request listing all SKUs / orders / customers
 * - read_file dumping a multi-MB CSV
 * - read_image base64 of an 8MB photo (image_url path bypasses this, but
 *   if the agent asks for raw bytes via read_image it lands here)
 *
 * trimTranscript drops whole items from the head, never partial, so one
 * fat tool output sits in transcript forever and crowds out the recent
 * rounds the agent actually needs to see. Truncate at write time and
 * leave a marker so the agent knows to re-query with a tighter filter
 * if it actually needs the missing data.
 */
const MAX_TOOL_OUTPUT_CHARS = 40_000;

function capToolOutput(output: string): string {
  if (output.length <= MAX_TOOL_OUTPUT_CHARS) return output;
  return (
    output.slice(0, MAX_TOOL_OUTPUT_CHARS) +
    `\n\n[truncated — original was ${output.length} chars, only first ${MAX_TOOL_OUTPUT_CHARS} kept. If you need the rest, narrow your query with a filter/limit and call the tool again.]`
  );
}

function appendTranscript(existing: JsonObject[], items: JsonObject[]): JsonObject[] {
  if (items.length === 0) return existing;
  return trimTranscript([...existing, ...items.map((item) => cloneJson(item))]);
}

function userMessageInput(text: string, images: ImageAttachmentRef[] = []): JsonObject {
  const content: JsonObject[] = [
    {
      type: 'input_text',
      text,
    },
  ];
  for (const img of images) {
    const dataUrl = tryReadImageAsDataUrl(img);
    if (!dataUrl) continue;
    // OpenAI Responses API uses `input_image` with `image_url` (string).
    // Chat-completions translation in transcriptToChatMessages maps this to
    // `image_url` parts as well, so this one shape works for both transports.
    content.push({
      type: 'input_image',
      image_url: dataUrl,
    });
  }
  return {
    type: 'message',
    role: 'user',
    content,
  };
}

const IMAGE_DATA_URL_MAX_BYTES = 8 * 1024 * 1024;

function tryReadImageAsDataUrl(img: ImageAttachmentRef): string | null {
  try {
    const stat = fsForImages.statSync(img.localPath);
    if (!stat.isFile() || stat.size > IMAGE_DATA_URL_MAX_BYTES) return null;
    const bytes = fsForImages.readFileSync(img.localPath);
    const mime = img.mimeType || mimeFromPath(img.localPath);
    return `data:${mime};base64,${bytes.toString('base64')}`;
  } catch {
    return null;
  }
}

function mimeFromPath(p: string): string {
  const m = p.toLowerCase().match(/\.(jpe?g|png|gif|webp|bmp|heic)$/);
  if (!m) return 'application/octet-stream';
  const ext = m[1] === 'jpg' ? 'jpeg' : m[1];
  return `image/${ext}`;
}

function replayableOutputItems(output: OpenAIOutputItem[] | undefined): JsonObject[] {
  if (!Array.isArray(output)) return [];
  const replayable: JsonObject[] = [];
  for (const item of output) {
    if (!isRecord(item)) continue;
    if (item.type !== 'message' && item.type !== 'function_call') continue;
    replayable.push(cloneJson(item));
  }
  return replayable;
}

function parseContinuationState(raw: string | undefined): OpenAIContinuationState {
  const legacyResponseId = readString(raw);
  if (!legacyResponseId) {
    return { v: 2, mode: 'responses', transport: 'responses', transcript: [] };
  }

  try {
    const parsed = JSON.parse(legacyResponseId) as unknown;
    if (!isRecord(parsed) || (parsed.v !== 1 && parsed.v !== 2)) {
      return { v: 2, mode: 'responses', transport: 'responses', responseId: legacyResponseId, transcript: [] };
    }

    const mode = parsed.mode === 'stateless' ? 'stateless' : 'responses';
    const transport = parsed.transport === 'chat-completions' ? 'chat-completions' : 'responses';
    const transcript = Array.isArray(parsed.transcript)
      ? trimTranscript(parsed.transcript.filter(isRecord).map((item) => cloneJson(item)))
      : [];
    const responseId = readString(parsed.responseId);
    return {
      v: parsed.v === 2 ? 2 : 1,
      mode: transport === 'chat-completions' ? 'stateless' : mode,
      transport,
      responseId,
      transcript,
    };
  } catch {
    return { v: 2, mode: 'responses', transport: 'responses', responseId: legacyResponseId, transcript: [] };
  }
}

function serializeContinuationState(state: OpenAIContinuationState): string {
  return JSON.stringify({
    v: 2,
    mode: state.mode,
    transport: state.transport,
    responseId: state.responseId,
    transcript: trimTranscript(state.transcript),
  });
}

function persistAliasedContinuation(value: string): void {
  // `codex` is an alias of the OpenAI-compatible provider; persist both so
  // mid-turn recovery keeps working even if the configured provider name flips.
  setContinuation('openai', value);
  setContinuation('codex', value);
}

function isPreviousResponseIdUnsupported(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return PREVIOUS_RESPONSE_UNSUPPORTED_RE.test(message);
}

function shouldFallbackToChatCompletions(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return RESPONSES_TRANSPORT_FALLBACK_RE.test(message);
}

function extractMessageTextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const item of content) {
    if (!isRecord(item)) continue;
    const text = readString(item.text);
    if (text) parts.push(text);
  }
  return parts.join('\n').trim();
}

function transcriptToChatMessages(transcript: JsonObject[], instructions?: string): JsonObject[] {
  const messages: JsonObject[] = [];
  if (instructions) {
    messages.push({ role: 'system', content: instructions });
  }

  let pendingToolCalls: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }> = [];

  function flushPendingToolCalls(): void {
    if (pendingToolCalls.length === 0) return;
    messages.push({
      role: 'assistant',
      content: '',
      tool_calls: pendingToolCalls,
    });
    pendingToolCalls = [];
  }

  for (const item of transcript) {
    const type = readString(item.type);
    if (type === 'function_call') {
      const callId = readString(item.call_id);
      const name = readString(item.name);
      const args = typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {});
      if (callId && name) {
        pendingToolCalls.push({
          id: callId,
          type: 'function',
          function: {
            name,
            arguments: args,
          },
        });
      }
      continue;
    }

    flushPendingToolCalls();

    if (type === 'function_call_output') {
      const callId = readString(item.call_id);
      if (callId) {
        messages.push({
          role: 'tool',
          tool_call_id: callId,
          content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? ''),
        });
      }
      continue;
    }

    if (type !== 'message') continue;
    const role = readString(item.role);
    if (!role) continue;
    // For user messages with image parts, emit chat-completions style
    // multi-part `content[]` so middlemen (d1token etc.) that only speak
    // `/chat/completions` can still forward images to the model.
    if (role === 'user' && Array.isArray(item.content)) {
      const parts = convertUserContentToChatParts(item.content);
      if (parts.length > 0) {
        messages.push({ role, content: parts });
        continue;
      }
    }
    const content = extractMessageTextContent(item.content);
    messages.push({
      role,
      content,
    });
  }

  flushPendingToolCalls();
  return messages;
}

/**
 * Translate the Responses-API user content shape (with `input_text` /
 * `input_image` items) into the chat-completions multi-part `content[]`
 * format (with `text` / `image_url` items).
 *
 * Falls back to a single-text part list when no recognized parts are
 * present — caller decides whether to use those or flatten to a string.
 */
function convertUserContentToChatParts(content: unknown[]): JsonObject[] {
  const parts: JsonObject[] = [];
  for (const item of content) {
    if (!isRecord(item)) continue;
    const partType = readString(item.type);
    if (partType === 'input_text' || partType === 'text') {
      const text = readString(item.text);
      if (text) parts.push({ type: 'text', text });
      continue;
    }
    if (partType === 'input_image' || partType === 'image_url') {
      // image_url may be either a string (Responses-API shape) or a
      // { url, detail? } object (chat-completions-API shape). Accept both.
      let url: string | undefined;
      if (typeof item.image_url === 'string') {
        url = readString(item.image_url);
      } else if (isRecord(item.image_url)) {
        url = readString(item.image_url.url);
      }
      if (url) {
        parts.push({ type: 'image_url', image_url: { url } });
      }
    }
  }
  return parts;
}

function responseToolsToChatTools(tools: OpenAIFunctionTool[]): JsonObject[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

function chatCompletionToResponse(response: OpenAIChatCompletionResponse): OpenAIResponse {
  const choice = response.choices?.[0];
  const message = choice?.message;
  const output: OpenAIOutputItem[] = [];

  const contentText = extractMessageTextContent(message?.content);
  if (contentText) {
    output.push({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: contentText }],
    });
  }

  for (const toolCall of message?.tool_calls ?? []) {
    if (!toolCall || toolCall.type !== 'function') continue;
    output.push({
      type: 'function_call',
      call_id: readString(toolCall.id),
      name: readString(toolCall.function?.name),
      arguments: typeof toolCall.function?.arguments === 'string' ? toolCall.function.arguments : undefined,
    });
  }

  return {
    id: readString(response.id),
    status: 'completed',
    error: response.error ?? null,
    output,
    output_text: contentText || undefined,
  };
}

function parseSseResponse(raw: string): OpenAIResponse | null {
  if (!raw.includes('event:') || !raw.includes('data:')) return null;

  let response: OpenAIResponse | null = null;
  const outputItems: OpenAIOutputItem[] = [];
  const textByItemId = new Map<string, string>();

  let currentEvent = '';
  let dataLines: string[] = [];

  function flushEvent(): void {
    if (!dataLines.length) {
      currentEvent = '';
      return;
    }

    const payloadText = dataLines.join('\n').trim();
    dataLines = [];
    if (!payloadText) {
      currentEvent = '';
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(payloadText);
    } catch {
      currentEvent = '';
      return;
    }
    if (!isRecord(payload)) {
      currentEvent = '';
      return;
    }

    if ((currentEvent === 'response.created' || currentEvent === 'response.completed') && isRecord(payload.response)) {
      response = {
        ...(response ?? {}),
        ...(payload.response as OpenAIResponse),
      };
    } else if (currentEvent === 'response.output_item.done' && isRecord(payload.item)) {
      outputItems.push(payload.item as OpenAIOutputItem);
    } else if (currentEvent === 'response.output_text.done') {
      const itemId = readString(payload.item_id);
      const text = readString(payload.text);
      if (itemId && text) {
        textByItemId.set(itemId, text);
      }
    }

    currentEvent = '';
  }

  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trimEnd();
    if (!line) {
      flushEvent();
      continue;
    }
    if (line.startsWith('event:')) {
      currentEvent = line.slice('event:'.length).trim();
      continue;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trim());
    }
  }
  flushEvent();

  if (!response) return null;

  for (const item of outputItems) {
    const itemId = readString(item.id);
    const existingText = itemId ? textByItemId.get(itemId) : undefined;
    if (existingText && item.type === 'message') {
      const content = Array.isArray(item.content) ? [...item.content] : [];
      if (!content.some((part) => isRecord(part) && part.type === 'output_text')) {
        content.push({ type: 'output_text', text: existingText, annotations: [], logprobs: [] });
      }
      item.content = content;
    }
  }

  response.output = outputItems;
  response.output_text = extractOutputText(response) ?? undefined;
  return response;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || (status >= 500 && status <= 599);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function withHeartbeat<T>(fn: () => Promise<T>): Promise<T> {
  touchHeartbeat();
  const interval = setInterval(() => touchHeartbeat(), HEARTBEAT_INTERVAL_MS);
  try {
    return await fn();
  } finally {
    clearInterval(interval);
    touchHeartbeat();
  }
}

class OpenAIMcpBridge {
  private readonly mcpServers: Record<string, McpServerConfig>;
  private readonly env: Record<string, string | undefined>;
  private readonly connectedServers = new Map<string, ConnectedMcpServer>();
  private readonly toolBindings = new Map<string, ToolBinding>();
  private toolsPromise: Promise<OpenAIFunctionTool[]> | null = null;

  constructor(mcpServers: Record<string, McpServerConfig>, env: Record<string, string | undefined>) {
    this.mcpServers = mcpServers;
    this.env = env;
  }

  async listTools(): Promise<OpenAIFunctionTool[]> {
    if (!this.toolsPromise) {
      this.toolsPromise = this.loadTools();
    }
    return this.toolsPromise;
  }

  async callTool(qualifiedName: string, rawArguments: string | undefined): Promise<string> {
    const binding = this.toolBindings.get(qualifiedName);
    if (!binding) {
      return `Unknown MCP tool: ${qualifiedName}`;
    }

    let parsedArgs: Record<string, unknown> = {};
    const trimmed = rawArguments?.trim();
    if (trimmed) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        parsedArgs = isRecord(parsed) ? parsed : { value: parsed };
      } catch (err) {
        return `Invalid JSON arguments for ${qualifiedName}: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    try {
      const result = await withHeartbeat(() =>
        binding.client.callTool({
          name: binding.originalName,
          arguments: parsedArgs,
        }),
      );
      return formatToolResult(result);
    } catch (err) {
      return `Tool ${qualifiedName} failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private async loadTools(): Promise<OpenAIFunctionTool[]> {
    const usedNames = new Set<string>();
    const tools: OpenAIFunctionTool[] = [];

    for (const [serverName, config] of Object.entries(this.mcpServers)) {
      const server = await this.getServer(serverName, config);
      let cursor: string | undefined;
      do {
        const listed = await server.client.listTools(cursor ? { cursor } : undefined);
        for (const tool of listed.tools ?? []) {
          const qualifiedName = qualifyToolName(serverName, tool.name, usedNames);
          this.toolBindings.set(qualifiedName, {
            client: server.client,
            originalName: tool.name,
          });
          tools.push({
            type: 'function',
            name: qualifiedName,
            description: tool.description
              ? `${tool.description}\n\nOriginal MCP tool: ${tool.name} on server ${serverName}.`
              : `MCP tool ${tool.name} on server ${serverName}.`,
            parameters: toolInputSchema(tool),
            strict: false,
          });
        }
        cursor = listed.nextCursor;
      } while (cursor);
    }

    log(`Loaded ${tools.length} MCP tools for OpenAI provider`);
    return tools;
  }

  private async getServer(serverName: string, config: McpServerConfig): Promise<ConnectedMcpServer> {
    const existing = this.connectedServers.get(serverName);
    if (existing) return existing;

    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: {
        ...(Object.fromEntries(Object.entries(this.env).filter(([, value]) => typeof value === 'string')) as Record<
          string,
          string
        >),
        ...(config.env ?? {}),
      },
    });

    const client = new Client(
      {
        name: `frontlane-openai-${sanitizeToolSegment(serverName)}`,
        version: '1.0.0',
      },
      {
        capabilities: {},
      },
    );

    await client.connect(transport);

    const connected = { client };
    this.connectedServers.set(serverName, connected);
    return connected;
  }
}

export class OpenAIProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly reasoningEffort?: string;
  private readonly timeoutMs: number;
  private readonly bridge: OpenAIMcpBridge;
  private readonly forcedTransport: OpenAITransport | null;

  constructor(options: ProviderOptions = {}) {
    const env = options.env ?? {};
    this.baseUrl = normalizeBaseUrl(readString(env.OPENAI_BASE_URL));
    this.apiKey = readString(env.OPENAI_API_KEY) || '';
    this.model = readString(env.OPENAI_MODEL) || DEFAULT_MODEL;
    this.reasoningEffort = readString(env.OPENAI_REASONING_EFFORT);
    this.timeoutMs = Number.parseInt(readString(env.OPENAI_TIMEOUT_MS) || '', 10) || DEFAULT_TIMEOUT_MS;
    this.bridge = new OpenAIMcpBridge(options.mcpServers ?? {}, env);
    const transportEnv = readString(env.OPENAI_TRANSPORT)?.toLowerCase();
    this.forcedTransport =
      transportEnv === 'chat-completions' || transportEnv === 'chat'
        ? 'chat-completions'
        : transportEnv === 'responses'
        ? 'responses'
        : null;
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return INVALID_SESSION_RE.test(msg);
  }

  query(input: QueryInput): AgentQuery {
    let pendingFollowUp: string | null = null;
    let pendingFollowUpImages: ImageAttachmentRef[] | null = null;
    let stopRequested = false;
    let activeAbort: AbortController | null = null;
    let continuation = input.continuation;
    // Image attachments only apply to the very first turn. Follow-up
    // pushes re-populate this slot via push(message, images) so a barcode
    // photo arriving mid-stream still reaches the multi-modal channel.
    let pendingImages: ImageAttachmentRef[] | undefined = input.imageAttachments;

    const events: AsyncIterable<ProviderEvent> = {
      [Symbol.asyncIterator]: async function* (this: OpenAIProvider) {
        let currentPrompt = input.prompt;

        while (true) {
          if (stopRequested && !pendingFollowUp) return;

          const controller = new AbortController();
          activeAbort = controller;

          try {
            const images = pendingImages;
            pendingImages = undefined;
            const turn = await this.runTurn({
              prompt: currentPrompt,
              imageAttachments: images,
              continuation,
              instructions: input.systemContext?.instructions,
              signal: controller.signal,
            });

            continuation = turn.continuation;
            yield { type: 'init', continuation };
            for (const progress of turn.progressMessages) {
              yield { type: 'progress', message: progress };
            }
            yield { type: 'result', text: turn.text };
          } catch (err) {
            if (controller.signal.aborted) {
              if (pendingFollowUp) {
                currentPrompt = pendingFollowUp;
                pendingFollowUp = null;
                pendingImages = pendingFollowUpImages ?? undefined;
                pendingFollowUpImages = null;
                continue;
              }
              if (stopRequested) return;
            }
            throw err;
          } finally {
            if (activeAbort === controller) {
              activeAbort = null;
            }
          }

          if (pendingFollowUp) {
            currentPrompt = pendingFollowUp;
            pendingFollowUp = null;
            pendingImages = pendingFollowUpImages ?? undefined;
            pendingFollowUpImages = null;
            continue;
          }

          return;
        }
      }.bind(this),
    };

    return {
      push(message: string, imageAttachments?: ImageAttachmentRef[]) {
        pendingFollowUp = message;
        pendingFollowUpImages = imageAttachments ?? null;
        activeAbort?.abort();
      },
      end() {
        // OpenAI responses are discrete turns; nothing to flush here.
      },
      events,
      abort() {
        stopRequested = true;
        activeAbort?.abort();
      },
    };
  }

  private async runTurn(params: {
    prompt: string;
    imageAttachments?: ImageAttachmentRef[];
    continuation?: string;
    instructions?: string;
    signal: AbortSignal;
  }): Promise<{ continuation: string; text: string | null; progressMessages: string[] }> {
    if (!this.apiKey) {
      throw new Error('OPENAI_API_KEY is missing for provider=openai');
    }

    const tools = await this.bridge.listTools();
    const progressMessages: string[] = [];
    const restored = parseContinuationState(params.continuation);
    let mode: ContinuationMode = restored.mode;
    let transport: OpenAITransport = this.forcedTransport ?? restored.transport;
    if (transport === 'chat-completions') {
      mode = 'stateless';
    }
    let previousResponseId = restored.mode === 'responses' ? restored.responseId : undefined;
    let transcript = trimTranscript(restored.transcript);
    transcript = appendTranscript(transcript, [userMessageInput(params.prompt, params.imageAttachments)]);
    let nextInput: unknown =
      transport === 'chat-completions' || mode === 'stateless' ? transcript : transcript[transcript.length - 1];

    while (true) {
      if (params.signal.aborted) throw new Error('OpenAI request aborted');

      let response: OpenAIResponse;
      try {
        if (transport === 'chat-completions') {
          response = await this.createChatCompletionResponse({
            transcript: Array.isArray(nextInput) ? nextInput.filter(isRecord) : transcript,
            instructions: params.instructions,
            tools,
            signal: params.signal,
          });
        } else {
          response = await this.createResponse({
            previousResponseId: mode === 'responses' ? previousResponseId : undefined,
            input: nextInput,
            instructions: params.instructions,
            tools,
            signal: params.signal,
          });
        }
      } catch (err) {
        if (
          transport === 'responses' &&
          mode === 'responses' &&
          previousResponseId &&
          isPreviousResponseIdUnsupported(err)
        ) {
          log('OpenAI-compatible backend rejected previous_response_id; switching to stateless replay mode');
          mode = 'stateless';
          previousResponseId = undefined;
          nextInput = transcript;
          continue;
        }
        if (transport === 'responses' && shouldFallbackToChatCompletions(err)) {
          log('OpenAI Responses API appears unstable on this backend; switching to chat completions fallback');
          transport = 'chat-completions';
          mode = 'stateless';
          previousResponseId = undefined;
          nextInput = transcript;
          continue;
        }
        throw err;
      }

      const responseId = readString(response.id);
      if (!responseId) {
        throw new Error('OpenAI response missing id');
      }
      const responseItems = replayableOutputItems(response.output);

      const functionCalls = collectFunctionCalls(response.output);
      if (functionCalls.length === 0) {
        transcript = appendTranscript(transcript, responseItems);
        const continuation = serializeContinuationState({
          v: 2,
          mode,
          transport,
          responseId: mode === 'responses' ? responseId : undefined,
          transcript,
        });
        persistAliasedContinuation(continuation);
        if (response.error?.message) {
          throw new Error(response.error.message);
        }
        if (response.status === 'incomplete') {
          throw new Error(
            `OpenAI response incomplete${response.incomplete_details?.reason ? `: ${response.incomplete_details.reason}` : ''}`,
          );
        }
        return {
          continuation,
          text: extractOutputText(response),
          progressMessages,
        };
      }

      const toolOutputs: Array<{ type: 'function_call_output'; call_id: string; output: string }> = [];
      for (const call of functionCalls) {
        if (params.signal.aborted) throw new Error('OpenAI request aborted');

        const callId = readString(call.call_id);
        const name = readString(call.name);
        if (!callId || !name) {
          continue;
        }

        progressMessages.push(`Calling ${name}`);
        const rawOutput = await this.bridge.callTool(name, readString(call.arguments));
        // Per-item cap. A single tool returning a giant payload (e.g. a
        // 200-SKU product list, a full Excel sheet) would otherwise sit
        // in the transcript verbatim and never get trimmed by the
        // total-size sweep — trimTranscript drops whole items from the
        // head, never partial. Truncate here so a heavy round doesn't
        // poison the next 50 turns' worth of replay.
        const output = capToolOutput(rawOutput);
        toolOutputs.push({
          type: 'function_call_output',
          call_id: callId,
          output,
        });
      }

      transcript = appendTranscript(transcript, [...responseItems, ...toolOutputs]);
      const continuation = serializeContinuationState({
        v: 2,
        mode,
        transport,
        responseId: mode === 'responses' ? responseId : undefined,
        transcript,
      });
      persistAliasedContinuation(continuation);
      previousResponseId = responseId;
      nextInput = transport === 'responses' && mode === 'responses' ? toolOutputs : transcript;
    }
  }

  private async createResponse(params: {
    previousResponseId?: string;
    input: unknown;
    instructions?: string;
    tools: OpenAIFunctionTool[];
    signal: AbortSignal;
  }): Promise<OpenAIResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const abortFromCaller = () => controller.abort();
    params.signal.addEventListener('abort', abortFromCaller, { once: true });

    const body: Record<string, unknown> = {
      model: this.model,
      input: params.input,
      tools: params.tools,
      parallel_tool_calls: false,
      store: true,
      stream: false,
    };

    if (params.previousResponseId) {
      body.previous_response_id = params.previousResponseId;
    }
    if (params.instructions) {
      body.instructions = params.instructions;
    }
    if (this.reasoningEffort) {
      body.reasoning = { effort: this.reasoningEffort };
    }

    try {
      for (let attempt = 1; attempt <= MAX_REQUEST_ATTEMPTS; attempt += 1) {
        let response: Response;
        try {
          response = await withHeartbeat(() =>
            fetch(`${this.baseUrl}/responses`, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${this.apiKey}`,
              },
              body: JSON.stringify(body),
              signal: controller.signal,
            }),
          );
        } catch (err) {
          if (params.signal.aborted) throw err;
          if (controller.signal.aborted) {
            throw new Error(`OpenAI request timed out after ${this.timeoutMs}ms`);
          }
          if (attempt < MAX_REQUEST_ATTEMPTS) {
            log(
              `OpenAI request transport failed (attempt ${attempt}/${MAX_REQUEST_ATTEMPTS}), retrying: ${err instanceof Error ? err.message : String(err)}`,
            );
            await sleep(RETRY_BACKOFF_MS * attempt);
            continue;
          }
          throw err;
        }

        const raw = await withHeartbeat(() => response.text());
        let parsed: unknown;
        const contentType = response.headers.get('content-type') || '';
        try {
          if (contentType.includes('text/event-stream')) {
            parsed = parseSseResponse(raw);
            if (!parsed) {
              throw new Error(`OpenAI endpoint returned unreadable SSE response (${response.status})`);
            }
          } else {
            try {
              parsed = raw ? JSON.parse(raw) : {};
            } catch {
              parsed = parseSseResponse(raw);
              if (!parsed) {
                throw new Error(`OpenAI endpoint returned non-JSON response (${response.status})`);
              }
            }
          }
        } catch (err) {
          if (attempt < MAX_REQUEST_ATTEMPTS && isRetryableStatus(response.status)) {
            log(
              `OpenAI response parse failed (status ${response.status}, attempt ${attempt}/${MAX_REQUEST_ATTEMPTS}), retrying: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
            await sleep(RETRY_BACKOFF_MS * attempt);
            continue;
          }
          throw err;
        }

        if (!response.ok) {
          const message =
            isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.message === 'string'
              ? parsed.error.message
              : `OpenAI request failed with status ${response.status}`;
          if (attempt < MAX_REQUEST_ATTEMPTS && isRetryableStatus(response.status)) {
            log(
              `OpenAI request failed with status ${response.status} (attempt ${attempt}/${MAX_REQUEST_ATTEMPTS}), retrying`,
            );
            await sleep(RETRY_BACKOFF_MS * attempt);
            continue;
          }
          throw new Error(message);
        }

        if (!isRecord(parsed)) {
          throw new Error('OpenAI endpoint returned an invalid response payload');
        }

        return parsed as OpenAIResponse;
      }

      throw new Error('OpenAI request exhausted retries');
    } finally {
      clearTimeout(timeout);
      params.signal.removeEventListener('abort', abortFromCaller);
    }
  }

  private async createChatCompletionResponse(params: {
    transcript: JsonObject[];
    instructions?: string;
    tools: OpenAIFunctionTool[];
    signal: AbortSignal;
  }): Promise<OpenAIResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const abortFromCaller = () => controller.abort();
    params.signal.addEventListener('abort', abortFromCaller, { once: true });

    const body: Record<string, unknown> = {
      model: this.model,
      messages: transcriptToChatMessages(params.transcript, params.instructions),
      tools: responseToolsToChatTools(params.tools),
      tool_choice: 'auto',
      parallel_tool_calls: false,
      stream: false,
    };

    try {
      for (let attempt = 1; attempt <= MAX_REQUEST_ATTEMPTS; attempt += 1) {
        let response: Response;
        try {
          response = await withHeartbeat(() =>
            fetch(`${this.baseUrl}/chat/completions`, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${this.apiKey}`,
              },
              body: JSON.stringify(body),
              signal: controller.signal,
            }),
          );
        } catch (err) {
          if (params.signal.aborted) throw err;
          if (controller.signal.aborted) {
            throw new Error(`OpenAI chat completion request timed out after ${this.timeoutMs}ms`);
          }
          if (attempt < MAX_REQUEST_ATTEMPTS) {
            log(
              `OpenAI chat completion transport failed (attempt ${attempt}/${MAX_REQUEST_ATTEMPTS}), retrying: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
            await sleep(RETRY_BACKOFF_MS * attempt);
            continue;
          }
          throw err;
        }

        const raw = await withHeartbeat(() => response.text());
        let parsed: unknown;
        try {
          parsed = raw ? JSON.parse(raw) : {};
        } catch {
          if (attempt < MAX_REQUEST_ATTEMPTS && isRetryableStatus(response.status)) {
            log(
              `OpenAI chat completion parse failed (status ${response.status}, attempt ${attempt}/${MAX_REQUEST_ATTEMPTS}), retrying`,
            );
            await sleep(RETRY_BACKOFF_MS * attempt);
            continue;
          }
          throw new Error(`OpenAI chat completion endpoint returned non-JSON response (${response.status})`);
        }

        if (!response.ok) {
          const message =
            isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.message === 'string'
              ? parsed.error.message
              : `OpenAI chat completion request failed with status ${response.status}`;
          if (attempt < MAX_REQUEST_ATTEMPTS && isRetryableStatus(response.status)) {
            log(
              `OpenAI chat completion failed with status ${response.status} (attempt ${attempt}/${MAX_REQUEST_ATTEMPTS}), retrying`,
            );
            await sleep(RETRY_BACKOFF_MS * attempt);
            continue;
          }
          throw new Error(message);
        }

        if (!isRecord(parsed)) {
          throw new Error('OpenAI chat completion endpoint returned an invalid response payload');
        }

        return chatCompletionToResponse(parsed as OpenAIChatCompletionResponse);
      }

      throw new Error('OpenAI chat completion request exhausted retries');
    } finally {
      clearTimeout(timeout);
      params.signal.removeEventListener('abort', abortFromCaller);
    }
  }
}

registerProvider('openai', (opts) => new OpenAIProvider(opts));
registerProvider('codex', (opts) => new OpenAIProvider(opts));
