import { describe, expect, it } from 'bun:test';

import { buildLitellmOpenAiEnv, createLitellmProxyProvider } from './litellm-proxy.js';
import { OpenAIProvider } from './openai.js';

describe('litellm-proxy provider', () => {
  it('maps LITELLM_* env vars onto OpenAI-compatible settings', () => {
    expect(
      buildLitellmOpenAiEnv({
        LITELLM_PROXY_URL: 'http://localhost:4000',
        LITELLM_MASTER_KEY: 'sk-test',
        LITELLM_MODEL: 'deepseek-v4-flash',
        OPENAI_BASE_URL: 'https://ignored.example/v1',
      }),
    ).toEqual({
      LITELLM_PROXY_URL: 'http://localhost:4000',
      LITELLM_MASTER_KEY: 'sk-test',
      LITELLM_MODEL: 'deepseek-v4-flash',
      OPENAI_BASE_URL: 'http://localhost:4000',
      OPENAI_API_KEY: 'sk-test',
      OPENAI_MODEL: 'deepseek-v4-flash',
      OPENAI_FORCE_TRANSPORT: 'chat-completions',
    });
  });

  it('wraps OpenAIProvider with merged env', () => {
    const provider = createLitellmProxyProvider({
      env: { LITELLM_PROXY_URL: 'http://localhost:4000', LITELLM_MASTER_KEY: 'sk-test' },
    });
    expect(provider).toBeInstanceOf(OpenAIProvider);
  });
});
