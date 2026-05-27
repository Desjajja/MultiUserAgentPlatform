/**
 * OpenAI-compatible provider container config.
 *
 * This provider currently forwards its API credentials directly into the
 * container environment so the container-side runner can call an
 * OpenAI-compatible Responses API endpoint. This is less strict than the
 * Claude + OneCLI flow, but keeps local enterprise deployments simple while
 * we are still bootstrapping the reusable provider baseline.
 */
import { readEnvFile } from '../env.js';
import { registerProviderContainerConfig, type ProviderContainerContribution } from './provider-container-registry.js';

const OPENAI_ENV_KEYS = [
  'OPENAI_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_MODEL',
  'OPENAI_REASONING_EFFORT',
  'OPENAI_TIMEOUT_MS',
  // Force `chat-completions` for relays (e.g. d1token) that don't implement
  // OpenAI's newer `/responses` endpoint. Values: chat-completions | responses.
  'OPENAI_TRANSPORT',
  // ERP backend coords for the xinjiulong-erp skill. Same envs the Claude
  // provider passes through — keeps skill-side curl calls working regardless
  // of which LLM provider the group runs.
  'ERP_BASE_URL',
  'ERP_AGENT_SERVICE_KEY',
  // HMAC signing secret for ERP /api/agent/* gateway. Container's
  // erp_execute MCP tool reads this to sign each request. Same value as
  // the ERP backend's FRONTLANE_HMAC_SECRET.
  'FRONTLANE_HMAC_SECRET',
] as const;

function buildOpenAIContribution(): ProviderContainerContribution {
  const dotenv = readEnvFile([...OPENAI_ENV_KEYS]);
  const env: Record<string, string> = {};
  for (const key of OPENAI_ENV_KEYS) {
    const value = dotenv[key];
    if (value) env[key] = value;
  }
  return { env };
}

registerProviderContainerConfig('openai', buildOpenAIContribution);
registerProviderContainerConfig('codex', buildOpenAIContribution);
