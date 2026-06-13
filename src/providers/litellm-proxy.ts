/**
 * Host-side container config for the litellm-proxy provider.
 *
 * Forwards LiteLLM connection settings into the agent container. The
 * container-side provider maps these to OpenAI-compatible chat-completions
 * calls against the local LiteLLM Proxy (ADR-0016).
 */
import { readEnvFile } from '../env.js';
import { registerProviderContainerConfig, type ProviderContainerContribution } from './provider-container-registry.js';

const LITELLM_ENV_KEYS = [
  'LITELLM_PROXY_URL',
  'LITELLM_MASTER_KEY',
  'LITELLM_MODEL',
  'OPENAI_REASONING_EFFORT',
  'OPENAI_TIMEOUT_MS',
] as const;

function buildLitellmProxyContribution(): ProviderContainerContribution {
  const dotenv = readEnvFile([...LITELLM_ENV_KEYS]);
  const env: Record<string, string> = {};
  for (const key of LITELLM_ENV_KEYS) {
    const value = dotenv[key] || process.env[key];
    if (value) env[key] = value;
  }
  return { env };
}

registerProviderContainerConfig('litellm-proxy', buildLitellmProxyContribution);
