/**
 * ERP role lookup — given a session, find the latest inbound chat
 * sender's Feishu open_id and ask ERP what roles they hold.
 *
 * Where this fits: spawnContainer() calls into here right before assembling
 * docker args, so the resulting role list lands in container env
 * USER_ROLES. The container-side inlineSkillFolder() then picks reference
 * files matching that role union.
 *
 * Failure modes are non-fatal — if anything throws / 404s / times out,
 * we return an empty role list. The container handles empty roles by
 * inlining only the must-have baseline (SKILL.md + ai-gateway + business
 * rules + pitfalls). Worst case = larger prompt, not broken behavior.
 *
 * Caching: a small in-memory map keeps role lookups for 15 minutes per
 * open_id. Matches the JWT TTL so flipping roles in ERP takes effect
 * inside one session lifetime without manual cache busting.
 */
import { readEnvFile } from './env.js';
import { log } from './log.js';
import { openInboundDb, inboundDbPath } from './session-manager.js';
import fs from 'fs';

const CACHE_TTL_MS = 15 * 60 * 1000;
const HTTP_TIMEOUT_MS = 5000;

interface CachedRoles {
  roles: string[];
  expiresAt: number;
}

const cache = new Map<string, CachedRoles>();

function erpBaseUrlHost(): string | undefined {
  const env = readEnvFile(['ERP_BASE_URL_HOST', 'ERP_BASE_URL']);
  return (env.ERP_BASE_URL_HOST || env.ERP_BASE_URL || '').trim() || undefined;
}

function serviceKey(): string | undefined {
  return readEnvFile(['ERP_AGENT_SERVICE_KEY']).ERP_AGENT_SERVICE_KEY?.trim() || undefined;
}

/**
 * Read the most recent chat/chat-sdk inbound row's senderId. Returns the
 * raw `ou_*` open_id without any namespace prefix.
 *
 * Skips synthetic/system rows (queue continuations, button clicks). Those
 * carry no real Feishu sender so we'd otherwise wrongly identify them as
 * unauthenticated.
 */
function findLatestFeishuOpenId(agentGroupId: string, sessionId: string): string | null {
  if (!fs.existsSync(inboundDbPath(agentGroupId, sessionId))) return null;
  let db;
  try {
    db = openInboundDb(agentGroupId, sessionId);
  } catch (err) {
    log.warn('erp-role-lookup: openInboundDb failed', {
      sessionId,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  let row: { channel_type: string | null; content: string | null } | undefined;
  try {
    row = db
      .prepare(
        `SELECT channel_type, content
         FROM messages_in
         WHERE kind IN ('chat', 'chat-sdk')
         ORDER BY seq DESC
         LIMIT 1`,
      )
      .get() as typeof row;
  } catch (err) {
    log.warn('erp-role-lookup: inbound query failed', {
      sessionId,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  } finally {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
  if (!row || row.channel_type !== 'feishu') return null;
  try {
    const parsed = JSON.parse(row.content ?? '{}') as Record<string, unknown>;
    // Skip our own synthetic shapes so we don't try to lookup roles for
    // "system" sender.
    if (parsed.kind === 'image_queue_continuation' || parsed.kind === 'button_click') {
      return null;
    }
    const raw = typeof parsed.senderId === 'string' ? parsed.senderId.trim() : '';
    if (!raw) return null;
    // senderId is raw "ou_..." (the channel formats it that way for Feishu).
    // Strip any leading "feishu:" prefix just in case.
    return raw.startsWith('feishu:') ? raw.slice('feishu:'.length) : raw;
  } catch {
    return null;
  }
}

/**
 * Ask ERP for the roles tied to a given Feishu open_id. Uses
 * /api/feishu/exchange-token because that endpoint already returns roles
 * alongside the JWT (and is the only one with stable cross-version
 * semantics today). Hits a 5s timeout; on any failure returns [].
 */
async function fetchRolesFromErp(openId: string): Promise<string[]> {
  const base = erpBaseUrlHost();
  const key = serviceKey();
  if (!base || !key) {
    log.warn('erp-role-lookup: ERP base url or service key not configured');
    return [];
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const url = `${base.replace(/\/+$/, '')}/api/feishu/exchange-token`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Agent-Service-Key': key,
      },
      body: JSON.stringify({ open_id: openId }),
      signal: controller.signal,
    });
    if (!res.ok) {
      // 404 = unbound, that's fine; anything else is worth logging.
      if (res.status !== 404) {
        log.warn('erp-role-lookup: exchange-token returned non-OK', {
          openId,
          status: res.status,
        });
      }
      return [];
    }
    const body = (await res.json()) as { roles?: unknown };
    if (!Array.isArray(body.roles)) return [];
    return body.roles.filter((r): r is string => typeof r === 'string' && r.length > 0);
  } catch (err) {
    log.warn('erp-role-lookup: exchange-token call failed', {
      openId,
      err: err instanceof Error ? err.message : String(err),
    });
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Public entry point used by container-runner. Always resolves to a
 * (possibly empty) string array; never throws.
 */
export async function resolveRolesForSession(
  agentGroupId: string,
  sessionId: string,
): Promise<string[]> {
  const openId = findLatestFeishuOpenId(agentGroupId, sessionId);
  if (!openId) return [];

  const now = Date.now();
  const cached = cache.get(openId);
  if (cached && cached.expiresAt > now) {
    return cached.roles;
  }
  const roles = await fetchRolesFromErp(openId);
  cache.set(openId, { roles, expiresAt: now + CACHE_TTL_MS });
  return roles;
}
