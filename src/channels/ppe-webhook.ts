/**
 * PPE alert push channel — accepts POST /webhook/ppe-alert from the lab
 * camera backend and routes the alert as an inbound message to the
 * configured target agent group (typically monitor-worker via a
 * dedicated platform_id).
 *
 * This is a one-way push channel: the camera backend POSTs JSON when it
 * detects an operator without required PPE; the host translates that
 * into an inbound chat message and lets the monitor worker decide what
 * to do (raise a red alert in the bound Feishu conversation, wait for
 * "PPE OK", etc.).
 *
 * Configuration via env vars. The factory returns null and the channel
 * is skipped if any required field is missing.
 *
 *   PPE_WEBHOOK_TARGET_PLATFORM_ID  required. platform_id used for inbound.
 *                                   agent_destinations wires this to the
 *                                   receiving agent (monitor-worker).
 *                                   Example: 'ppe:lab-cam-1'.
 *   PPE_WEBHOOK_SHARED_SECRET       optional. If set, the POST must carry
 *                                   `x-ppe-secret: <value>` or be rejected
 *                                   401. Cheap protection against the
 *                                   open port on the host webhook server.
 *
 * Expected POST body (application/json):
 *   {
 *     "alert_type": "no_lab_coat" | "no_gloves" | "no_goggles" | "generic",
 *     "camera_id":  "lab-cam-1",
 *     "detected_at": "2026-05-15T09:12:34Z",
 *     "snapshot_url": "http://192.168.66.31/snapshots/abc.jpg",  // optional
 *     "confidence":   0.92,                                        // optional
 *     "notes":        "operator at bench 3"                        // optional
 *   }
 *
 * Outbound delivery is a logged no-op (push-only channel).
 */
import http from 'http';

import { log } from '../log.js';
import { registerWebhookHandler } from '../webhook-server.js';
import type { ChannelAdapter, ChannelSetup, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

interface PpeWebhookConfig {
  targetPlatformId: string;
  sharedSecret?: string;
}

interface PpeAlertPayload {
  alert_type?: string;
  camera_id?: string;
  detected_at?: string;
  snapshot_url?: string;
  confidence?: number;
  notes?: string;
}

const CHANNEL_TYPE = 'ppe-webhook';
const WEBHOOK_PATH = '/webhook/ppe-alert';
const MAX_BODY_BYTES = 64 * 1024;

function readEnvConfig(): PpeWebhookConfig | null {
  const target = process.env.PPE_WEBHOOK_TARGET_PLATFORM_ID?.trim();
  if (!target) return null;

  return {
    targetPlatformId: target,
    sharedSecret: process.env.PPE_WEBHOOK_SHARED_SECRET?.trim() || undefined,
  };
}

async function readBody(req: http.IncomingMessage, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    received += buf.length;
    if (received > max) {
      throw new Error(`payload exceeds ${max} bytes`);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function buildHumanReadable(alert: PpeAlertPayload): string {
  const parts: string[] = ['🚨 PPE 告警'];
  if (alert.alert_type) parts.push(`类型=${alert.alert_type}`);
  if (alert.camera_id) parts.push(`摄像头=${alert.camera_id}`);
  if (typeof alert.confidence === 'number') parts.push(`置信度=${alert.confidence.toFixed(2)}`);
  if (alert.detected_at) parts.push(`时间=${alert.detected_at}`);
  if (alert.snapshot_url) parts.push(`快照=${alert.snapshot_url}`);
  if (alert.notes) parts.push(`备注=${alert.notes}`);
  return parts.join(' / ');
}

function createAdapter(cfg: PpeWebhookConfig): ChannelAdapter {
  let setupConfig: ChannelSetup | null = null;
  let registered = false;

  const adapter: ChannelAdapter = {
    name: 'ppe-webhook',
    channelType: CHANNEL_TYPE,
    supportsThreads: false,

    isConnected(): boolean {
      return registered;
    },

    async setup(config: ChannelSetup): Promise<void> {
      setupConfig = config;

      registerWebhookHandler(WEBHOOK_PATH, async (req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(405, { 'Content-Type': 'text/plain' });
          res.end('Method Not Allowed');
          return;
        }

        if (cfg.sharedSecret) {
          const provided = req.headers['x-ppe-secret'];
          const got = typeof provided === 'string' ? provided : Array.isArray(provided) ? provided[0] : '';
          if (got !== cfg.sharedSecret) {
            res.writeHead(401, { 'Content-Type': 'text/plain' });
            res.end('Unauthorized');
            return;
          }
        }

        let body: Buffer;
        try {
          body = await readBody(req, MAX_BODY_BYTES);
        } catch (err) {
          log.warn('PPE webhook body read failed', { err });
          res.writeHead(413, { 'Content-Type': 'text/plain' });
          res.end('Payload Too Large');
          return;
        }

        let alert: PpeAlertPayload;
        try {
          alert = JSON.parse(body.toString('utf-8')) as PpeAlertPayload;
        } catch (err) {
          log.warn('PPE webhook JSON parse failed', { err });
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Bad JSON');
          return;
        }

        if (!setupConfig) {
          res.writeHead(503, { 'Content-Type': 'text/plain' });
          res.end('Channel not ready');
          return;
        }

        const id = `ppe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        const ts = alert.detected_at || new Date().toISOString();
        const human = buildHumanReadable(alert);

        try {
          await setupConfig.onInbound(cfg.targetPlatformId, null, {
            id,
            kind: 'chat',
            content: { text: human, alert },
            timestamp: ts,
          });
        } catch (err) {
          log.error('PPE onInbound failed', { err });
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Internal Server Error');
          return;
        }

        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, id }));
      });

      registered = true;
      log.info('PPE webhook channel ready', {
        path: WEBHOOK_PATH,
        targetPlatformId: cfg.targetPlatformId,
        authRequired: Boolean(cfg.sharedSecret),
      });
    },

    async teardown(): Promise<void> {
      setupConfig = null;
      registered = false;
    },

    async deliver(
      platformId: string,
      _threadId: string | null,
      _message: OutboundMessage,
    ): Promise<string | undefined> {
      log.warn('PPE webhook adapter does not deliver — outbound dropped', { platformId });
      return undefined;
    },

    async setTyping(): Promise<void> {
      // No-op — push-only channel.
    },
  };

  return adapter;
}

const envConfig = readEnvConfig();
registerChannelAdapter(CHANNEL_TYPE, {
  factory: () => (envConfig ? createAdapter(envConfig) : null),
});
