export interface AgentProvider {
  /**
   * True if the provider's underlying SDK handles slash commands natively and
   * wants them passed through as raw text. When false, the poll-loop formats
   * slash commands like any other chat message.
   */
  readonly supportsNativeSlashCommands: boolean;

  /** Start a new query. Returns a handle for streaming input and output. */
  query(input: QueryInput): AgentQuery;

  /**
   * True if the given error indicates the stored continuation is invalid
   * (missing transcript, unknown session, etc.) and should be cleared.
   */
  isSessionInvalid(err: unknown): boolean;
}

/**
 * Options passed to provider constructors. Fields are common to most
 * providers; individual providers may ignore any they don't need.
 */
export interface ProviderOptions {
  assistantName?: string;
  mcpServers?: Record<string, McpServerConfig>;
  env?: Record<string, string | undefined>;
  additionalDirectories?: string[];
}

export interface QueryInput {
  /** Initial prompt (already formatted by agent-runner). */
  prompt: string;

  /**
   * Image attachments tied to the messages this prompt was built from.
   * Multi-modal-capable providers (e.g. OpenAI chat-completions) inline these
   * as `image_url` content parts so the model can actually see the pixels.
   * Providers that don't support image input ignore this field — the text
   * prompt already mentions the localPath, so the agent can still call
   * `read_image` to fetch bytes itself if it has another use for them.
   */
  imageAttachments?: ImageAttachmentRef[];

  /**
   * Opaque continuation token from a previous query. The provider decides
   * what this means (session ID, thread ID, nothing at all).
   */
  continuation?: string;

  /** Working directory inside the container. */
  cwd: string;

  /**
   * System context to inject. Providers translate this into whatever their
   * SDK expects (preset append, full system prompt, per-turn injection…).
   */
  systemContext?: {
    instructions?: string;
  };
}

export interface ImageAttachmentRef {
  /** Absolute path inside /workspace/inbox/<msgId>/<file>. */
  localPath: string;
  /** MIME type (`image/jpeg` etc.). Falls back to derive-from-extension. */
  mimeType?: string;
  /** Human label — usually `image-<n>-<keyTail>.<ext>`. */
  name?: string;
}

export interface McpServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface AgentQuery {
  /**
   * Push a follow-up message into the active query.
   *
   * `imageAttachments` lets the host re-inline images on a mid-stream
   * push (e.g. a barcode photo arriving while the agent is mid-turn for
   * an out-of-stock confirmation). Providers that don't support
   * multi-modal input ignore the field — the text prompt still mentions
   * the localPath via formatAttachments(), so the agent can call
   * `read_image` directly if it has another use for the bytes.
   */
  push(message: string, imageAttachments?: ImageAttachmentRef[]): void;

  /** Signal that no more input will be sent. */
  end(): void;

  /** Output event stream. */
  events: AsyncIterable<ProviderEvent>;

  /** Force-stop the query. */
  abort(): void;
}

export type ProviderEvent =
  | { type: 'init'; continuation: string }
  | { type: 'result'; text: string | null }
  | { type: 'error'; message: string; retryable: boolean; classification?: string }
  | { type: 'progress'; message: string }
  /**
   * Liveness signal. Providers MUST yield this on every underlying SDK
   * event (tool call, thinking, partial message, anything) so the
   * poll-loop's idle timer stays honest during long tool runs.
   */
  | { type: 'activity' }
  /**
   * The provider's underlying SDK auto-compacted the conversation context.
   * The poll-loop reacts by injecting a destination reminder back into
   * the live query so the agent doesn't drop `<message to="…">` wrapping
   * after compaction. Distinct from `result` so it doesn't mark the turn
   * completed or get dispatched as a chat message. See qwibitai/nanoclaw#2325.
   */
  | { type: 'compacted'; text: string };
