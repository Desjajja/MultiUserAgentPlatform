/**
 * Claude provider container config — only registered when the user has
 * configured a custom Anthropic-compatible endpoint via setup. Setup
 * appends `import './claude.js'` to providers/index.ts at that point;
 * standard installs hitting api.anthropic.com don't need this file
 * loaded.
 *
 * Two credential modes:
 *   1. OneCLI gateway (recommended) — real token never enters the
 *      container. Setup creates a OneCLI generic secret keyed to the
 *      base URL hostname; the proxy rewrites the Authorization header on
 *      the wire. Container env: ANTHROPIC_BASE_URL + AUTH_TOKEN=placeholder.
 *   2. Direct token — when ANTHROPIC_AUTH_TOKEN is present in .env, pass
 *      it through to the container. Use this for low-risk proxy tokens
 *      (third-party Anthropic-protocol gateways where the credential
 *      gates a prepaid balance, not an Anthropic-issued key).
 */
import { readEnvFile } from '../env.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

registerProviderContainerConfig('claude', () => {
  const dotenv = readEnvFile([
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_MODEL',
    'ERP_BASE_URL',
    'ERP_AGENT_SERVICE_KEY',
    'FRONTLANE_HMAC_SECRET',
  ]);
  const env: Record<string, string> = {};
  if (dotenv.ANTHROPIC_BASE_URL) {
    env.ANTHROPIC_BASE_URL = dotenv.ANTHROPIC_BASE_URL;
    env.ANTHROPIC_AUTH_TOKEN = dotenv.ANTHROPIC_AUTH_TOKEN || 'placeholder';
  }
  if (dotenv.ANTHROPIC_MODEL) {
    env.ANTHROPIC_MODEL = dotenv.ANTHROPIC_MODEL;
  }
  // ERP backend coords for the xinjiulong-erp skill. The skill's scripts
  // and the agent's curl calls read these from env so we don't bake the
  // base URL into per-group instructions.
  if (dotenv.ERP_BASE_URL) {
    env.ERP_BASE_URL = dotenv.ERP_BASE_URL;
  }
  if (dotenv.ERP_AGENT_SERVICE_KEY) {
    env.ERP_AGENT_SERVICE_KEY = dotenv.ERP_AGENT_SERVICE_KEY;
  }
  if (dotenv.FRONTLANE_HMAC_SECRET) {
    env.FRONTLANE_HMAC_SECRET = dotenv.FRONTLANE_HMAC_SECRET;
  }
  return { env };
});
