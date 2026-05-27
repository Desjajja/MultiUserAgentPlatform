/**
 * Upload inbound Feishu images to the ERP /api/uploads endpoint so the
 * resulting URL is reachable from ERP's own front-end (財務 in 报销审批
 * etc. needs to see the original voucher).
 *
 * Auth model: ERP /api/uploads is JWT-gated (CurrentUser), so we have to
 * call /api/feishu/exchange-token first using the sender's open_id and
 * upload under their identity. Audit chain stays intact: ERP audit_logs
 * will record the upload as "员工 X 上传凭证" rather than a service
 * account, which matches what the user did in Feishu.
 *
 * Fail-soft: any error here is logged but doesn't block the inbound
 * pipeline — `attachments[i].erp_url` simply stays unset, and the agent
 * tells the user "凭证我看到了但还没传到 ERP 系统，请你在 ERP 前端附件
 * 区域手动上传一张" instead of fabricating a URL.
 *
 * Original bytes (not the compressed copy) are sent on purpose: audit /
 * 财务复核 wants the full-resolution image, not a 1280px JPEG.
 */
import { readEnvFile } from './env.js';
import { log } from './log.js';

const TIMEOUT_MS = 30_000;

interface JwtCache {
  token: string;
  expiresAt: number;
}
const jwtCache = new Map<string, JwtCache>();

function erpBaseUrlHost(): string | undefined {
  const env = readEnvFile(['ERP_BASE_URL_HOST', 'ERP_BASE_URL']);
  return (env.ERP_BASE_URL_HOST || env.ERP_BASE_URL || '').trim() || undefined;
}

function serviceKey(): string | undefined {
  return readEnvFile(['ERP_AGENT_SERVICE_KEY']).ERP_AGENT_SERVICE_KEY?.trim() || undefined;
}

async function fetchJwt(openId: string): Promise<string | null> {
  const cached = jwtCache.get(openId);
  if (cached && cached.expiresAt > Date.now() + 30_000) return cached.token;

  const base = erpBaseUrlHost();
  const key = serviceKey();
  if (!base || !key) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${base.replace(/\/+$/, '')}/api/feishu/exchange-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Agent-Service-Key': key },
      body: JSON.stringify({ open_id: openId }),
      signal: controller.signal,
    });
    if (!res.ok) {
      if (res.status !== 404) {
        log.warn('erp-uploader: exchange-token non-OK', { openId, status: res.status });
      }
      return null;
    }
    const body = (await res.json()) as { access_token?: string; expires_in_min?: number };
    if (!body.access_token) return null;
    const ttlMs = (body.expires_in_min ?? 15) * 60 * 1000;
    jwtCache.set(openId, { token: body.access_token, expiresAt: Date.now() + ttlMs });
    return body.access_token;
  } catch (err) {
    log.warn('erp-uploader: exchange-token error', {
      openId,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

interface UploadResult {
  url: string;
  filename: string;
  size: number;
}

/**
 * Upload one image file to ERP under the given user's identity.
 * Returns `null` on any failure (host logs and the caller skips erp_url).
 */
export async function uploadImageToErp(params: {
  openId: string;
  bytes: Buffer;
  filename: string;
  mimeType: string;
}): Promise<UploadResult | null> {
  const base = erpBaseUrlHost();
  if (!base) {
    log.warn('erp-uploader: ERP_BASE_URL_HOST not configured');
    return null;
  }
  const jwt = await fetchJwt(params.openId);
  if (!jwt) return null;

  const form = new FormData();
  // Node 20+ FormData accepts Blob with filename via the 3rd arg.
  const blob = new Blob([new Uint8Array(params.bytes)], { type: params.mimeType });
  form.append('file', blob, params.filename);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${base.replace(/\/+$/, '')}/api/uploads`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}` },
      body: form,
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      log.warn('erp-uploader: upload non-OK', {
        openId: params.openId,
        status: res.status,
        body: text.slice(0, 200),
      });
      return null;
    }
    const body = (await res.json()) as Partial<UploadResult>;
    if (typeof body.url !== 'string' || !body.url) return null;
    return {
      url: body.url,
      filename: typeof body.filename === 'string' ? body.filename : params.filename,
      size: typeof body.size === 'number' ? body.size : params.bytes.length,
    };
  } catch (err) {
    log.warn('erp-uploader: upload error', {
      openId: params.openId,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}
