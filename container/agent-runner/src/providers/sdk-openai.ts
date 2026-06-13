import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText } from 'ai';
import { registerProvider } from './provider-registry.js';
import { injectTraceparent } from '../observability/init.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderOptions, QueryInput } from './types.js';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o';
const MAX_TRANSCRIPT_TURNS = 64;
const MAX_TRANSCRIPT_CHARS = 100_000;

interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

interface SdkOpenAIContinuation {
  v: 1;
  transcript: ChatTurn[];
}

function normalizeBaseUrl(raw: string | undefined): string {
  const trimmed = (raw || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  if (!trimmed) return DEFAULT_BASE_URL;
  if (/\/v\d+$/i.test(trimmed)) return trimmed;
  return `${trimmed}/v1`;
}

export function parseSdkOpenAIContinuation(raw: string | undefined): ChatTurn[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as Partial<SdkOpenAIContinuation>;
    if (parsed.v !== 1 || !Array.isArray(parsed.transcript)) return [];
    return parsed.transcript.filter(
      (turn): turn is ChatTurn =>
        !!turn &&
        typeof turn === 'object' &&
        (turn.role === 'user' || turn.role === 'assistant') &&
        typeof turn.content === 'string' &&
        turn.content.length > 0,
    );
  } catch {
    // Legacy opaque tokens like `sdk-<timestamp>` carry no transcript.
    return [];
  }
}

export function trimSdkOpenAITranscript(transcript: ChatTurn[]): ChatTurn[] {
  let trimmed = transcript.slice(-MAX_TRANSCRIPT_TURNS);
  while (trimmed.length > 0) {
    const size = trimmed.reduce((total, turn) => total + turn.content.length, 0);
    if (size <= MAX_TRANSCRIPT_CHARS) break;
    trimmed = trimmed.slice(1);
  }
  return trimmed;
}

/** Caller must pass an already-trimmed transcript (see trimSdkOpenAITranscript). */
export function serializeSdkOpenAIContinuation(transcript: ChatTurn[]): string {
  return JSON.stringify({ v: 1, transcript } satisfies SdkOpenAIContinuation);
}

class SdkOpenAIProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  private baseURL: string;
  private apiKey: string;
  private model: string;

  constructor(options: ProviderOptions = {}) {
    const env = options.env ?? {};
    this.baseURL = normalizeBaseUrl(env.OPENAI_BASE_URL);
    this.apiKey = env.OPENAI_API_KEY ?? '';
    this.model = env.OPENAI_MODEL ?? DEFAULT_MODEL;
  }

  isSessionInvalid(_err: unknown): boolean {
    return false;
  }

  query(input: QueryInput): AgentQuery {
    const self = this;
    const pending: string[] = [];
    let waiting: (() => void) | null = null;
    let ended = false;
    let aborted = false;

    async function* run(): AsyncGenerator<ProviderEvent> {
      if (!self.apiKey) {
        throw new Error('OPENAI_API_KEY is missing for provider=sdk-openai');
      }

      const provider = createOpenAICompatible({
        name: 'sdk-openai',
        baseURL: self.baseURL,
        apiKey: self.apiKey,
        headers: injectTraceparent({}),
      });

      let currentPrompt = input.prompt;
      let transcript = parseSdkOpenAIContinuation(input.continuation);

      while (!ended && !aborted) {
        yield { type: 'activity' };

        const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];
        if (input.systemContext?.instructions) {
          messages.push({ role: 'system', content: input.systemContext.instructions });
        }
        for (const turn of transcript) {
          messages.push({ role: turn.role, content: turn.content });
        }
        messages.push({ role: 'user', content: currentPrompt });

        const startMs = Date.now();
        const result = await generateText({
          model: provider.languageModel(self.model),
          messages,
        });
        const durationMs = Date.now() - startMs;

        transcript = trimSdkOpenAITranscript([
          ...transcript,
          { role: 'user', content: currentPrompt },
          ...(result.text ? [{ role: 'assistant' as const, content: result.text }] : []),
        ]);
        const continuation = serializeSdkOpenAIContinuation(transcript);

        yield { type: 'init', continuation };
        yield { type: 'activity' };

        if (result.text) {
          yield { type: 'result', text: result.text };
        }

        if (result.usage) {
          yield {
            type: 'usage',
            model: self.model,
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            totalTokens: result.usage.totalTokens,
            durationMs,
            transport: 'chat-completions',
          };
        }

        // Wait for follow-up messages or end signal
        while (!ended && pending.length === 0) {
          await new Promise<void>((resolve) => {
            waiting = resolve;
          });
          waiting = null;
        }

        if (pending.length > 0) {
          currentPrompt = pending.shift()!;
        }
      }

      // Drain remaining
      while (pending.length > 0) {
        yield { type: 'result', text: pending.shift()! };
      }
    }

    return {
      push(message: string) {
        pending.push(message);
        waiting?.();
      },
      end() {
        ended = true;
        waiting?.();
      },
      events: run(),
      abort() {
        aborted = true;
        waiting?.();
      },
    };
  }
}

registerProvider('sdk-openai', (opts) => new SdkOpenAIProvider(opts));
