/**
 * confirm-tokens caller — when a user clicks an ask_question button that
 * carries a `pendingAction`, host calls ERP `POST /api/confirm-tokens` to
 * mint a one-shot X-User-Confirm token bound to:
 *   - the clicker's open_id (sub)
 *   - the action name
 *   - sha256(canonical(payload)) so the agent can't quietly mutate the
 *     payload between click time and execute time
 *
 * The returned token gets stamped onto the inbound chat row that wakes
 * the agent's next turn, where erp_execute reads it back and forwards
 * as X-User-Confirm.
 */
import { readEnvFile } from './env.js';
import { log } from './log.js';

const TIMEOUT_MS = 8_000;

export interface ConfirmTokenResult {
  token: string;
  expiresInSec: number;
}

function erpBaseUrlHost(): string | undefined {
  const env = readEnvFile(['ERP_BASE_URL_HOST', 'ERP_BASE_URL']);
  return (env.ERP_BASE_URL_HOST || env.ERP_BASE_URL || '').trim() || undefined;
}

function serviceKey(): string | undefined {
  return readEnvFile(['ERP_AGENT_SERVICE_KEY']).ERP_AGENT_SERVICE_KEY?.trim() || undefined;
}

/**
 * Mint a confirm-token under the clicker's identity.
 *
 * The clicker's JWT is fetched via /api/feishu/exchange-token (same path
 * that erp_role_lookup uses). We never carry a service-wide token here —
 * the resulting confirm-token is bound to the clicker's user id, so they
 * — and only they — can spend it on /api/agent/execute.
 *
 * Returns null on any failure (logged); caller proceeds without a token
 * and the agent's next turn will see the click but no token, surfacing
 * the failure to the user instead of half-executing.
 */
export async function mintConfirmToken(params: {
  openId: string;
  action: string;
  payload: Record<string, unknown>;
}): Promise<ConfirmTokenResult | null> {
  const base = erpBaseUrlHost();
  const key = serviceKey();
  if (!base || !key) {
    log.warn('confirm-tokens: ERP_BASE_URL_HOST or ERP_AGENT_SERVICE_KEY missing');
    return null;
  }

  // Step 1: exchange open_id → user JWT.
  const exchangeController = new AbortController();
  const exchangeTimer = setTimeout(() => exchangeController.abort(), TIMEOUT_MS);
  let jwt: string | null = null;
  try {
    const exchangeUrl = `${base.replace(/\/+$/, '')}/api/feishu/exchange-token`;
    const exchangeRes = await fetch(exchangeUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Agent-Service-Key': key },
      body: JSON.stringify({ open_id: params.openId }),
      signal: exchangeController.signal,
    });
    if (!exchangeRes.ok) {
      log.warn('confirm-tokens: exchange-token non-OK', {
        openId: params.openId,
        status: exchangeRes.status,
      });
      return null;
    }
    const body = (await exchangeRes.json()) as { access_token?: string };
    jwt = body.access_token ?? null;
    if (!jwt) {
      log.warn('confirm-tokens: exchange-token missing access_token', { openId: params.openId });
      return null;
    }
  } catch (err) {
    log.warn('confirm-tokens: exchange-token error', {
      openId: params.openId,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  } finally {
    clearTimeout(exchangeTimer);
  }

  // Step 2: ask ERP to sign a confirm-token bound to action + payload.
  const tokenController = new AbortController();
  const tokenTimer = setTimeout(() => tokenController.abort(), TIMEOUT_MS);
  try {
    // ERP route is defined as `@router.post("/")` mounted at
    // prefix=/api/confirm-tokens. FastAPI returns 405 (not 307 redirect)
    // when the trailing slash is missing — keep it explicit here.
    const url = `${base.replace(/\/+$/, '')}/api/confirm-tokens/`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify({
        action: params.action,
        payload: params.payload,
      }),
      signal: tokenController.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      log.warn('confirm-tokens: mint non-OK', {
        action: params.action,
        status: res.status,
        body: text.slice(0, 200),
      });
      return null;
    }
    const body = (await res.json()) as { token?: string; expires_in_seconds?: number; expires_in?: number };
    if (typeof body.token !== 'string' || !body.token) {
      log.warn('confirm-tokens: mint response missing token', { action: params.action });
      return null;
    }
    return {
      token: body.token,
      expiresInSec: body.expires_in_seconds ?? body.expires_in ?? 120,
    };
  } catch (err) {
    log.warn('confirm-tokens: mint error', {
      action: params.action,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  } finally {
    clearTimeout(tokenTimer);
  }
}
