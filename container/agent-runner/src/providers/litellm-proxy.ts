/**
 * LiteLLM Proxy provider — chat-completions only.
 *
 * Routes all LLM calls through a LiteLLM Proxy instance using the OpenAI
 * chat-completions API. Does not use the Responses API (opencode-go and
 * most LiteLLM upstreams only support /v1/chat/completions).
 */
import { OpenAIProvider } from './openai.js';
import { registerProvider } from './provider-registry.js';
import type { AgentProvider, ProviderOptions } from './types.js';

const DEFAULT_PROXY_URL = 'http://host.docker.internal:4000';
const DEFAULT_MODEL = 'deepseek-v4-flash';

function pickEnv(...values: (string | undefined)[]): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

export function buildLitellmOpenAiEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  return {
    ...env,
    OPENAI_BASE_URL: pickEnv(env.LITELLM_PROXY_URL, env.OPENAI_BASE_URL) ?? DEFAULT_PROXY_URL,
    OPENAI_API_KEY: pickEnv(env.LITELLM_MASTER_KEY, env.LITELLM_API_KEY, env.OPENAI_API_KEY) ?? '',
    OPENAI_MODEL: pickEnv(env.LITELLM_MODEL, env.OPENAI_MODEL) ?? DEFAULT_MODEL,
    OPENAI_FORCE_TRANSPORT: 'chat-completions',
  };
}

export function createLitellmProxyProvider(options: ProviderOptions = {}): AgentProvider {
  const mergedEnv = buildLitellmOpenAiEnv(options.env ?? {});
  return new OpenAIProvider({ ...options, env: mergedEnv });
}

registerProvider('litellm-proxy', createLitellmProxyProvider);
