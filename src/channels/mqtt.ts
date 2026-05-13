/**
 * MQTT channel — subscribe to broker topics and route incoming MQTT
 * payloads as inbound messages to a configured target messaging group.
 *
 * Plan 块 1.6 — supports the "daemon-mode" skill class (mqtt-experiment-mode
 * etc.) by giving the host a persistent MQTT connection that survives
 * container idle-stop cycles. Without this channel, MQTT events arriving
 * while the target agent's container is stopped would just be dropped on
 * the floor.
 *
 * Subscribe-only (per autonomous-mode decision A.4). Outbound MQTT
 * publishing remains the responsibility of in-container Python skills
 * using paho-mqtt directly — that path is fire-and-forget and works fine
 * without a persistent host connection.
 *
 * Configuration via env vars. The factory returns null and the channel
 * is skipped if any required field is missing, so deployments without
 * MQTT just don't wire the channel — no error.
 *
 *   MQTT_BROKER_URL          required, e.g. mqtts://x2219abf.ala.cn-hangzhou.emqxsl.cn:8883
 *   MQTT_USERNAME            optional, e.g. emqx
 *   MQTT_PASSWORD            secret; falls back to EMQX_PASSWORD env if unset
 *   MQTT_TOPICS              required, comma-separated topic patterns,
 *                            e.g. "lab/+/event,semantic_nav/ack"
 *   MQTT_TARGET_PLATFORM_ID  platform_id used for inbound. agent_destinations
 *                            wires this to the receiving agent. Default:
 *                            'mqtt:default'.
 *   MQTT_QOS                 0|1|2, default 0
 *
 * Message format (what the agent sees):
 *   { "topic": "lab/cam-3/event",
 *     "payload": "<utf-8 string>",
 *     "ts": "2026-05-13T11:22:33.456Z" }
 *
 * Outbound delivery is a logged no-op — agents that address an mqtt
 * destination get a visible warning instead of a silent drop. To publish
 * from a worker, install paho-mqtt via install_packages and call from
 * inside the container (the existing robot skills do this).
 */
import type { MqttClient, IClientOptions } from 'mqtt';
import mqtt from 'mqtt';

import { log } from '../log.js';
import type { ChannelAdapter, ChannelSetup, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

interface MqttChannelConfig {
  brokerUrl: string;
  username?: string;
  password?: string;
  topics: string[];
  targetPlatformId: string;
  qos: 0 | 1 | 2;
}

function readEnvConfig(): MqttChannelConfig | null {
  const brokerUrl = process.env.MQTT_BROKER_URL?.trim();
  if (!brokerUrl) return null;

  const topicsRaw = process.env.MQTT_TOPICS?.trim();
  if (!topicsRaw) return null;
  const topics = topicsRaw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  if (topics.length === 0) return null;

  const qosRaw = process.env.MQTT_QOS?.trim();
  let qos: 0 | 1 | 2 = 0;
  if (qosRaw === '1') qos = 1;
  else if (qosRaw === '2') qos = 2;

  return {
    brokerUrl,
    username: process.env.MQTT_USERNAME?.trim() || undefined,
    password: process.env.MQTT_PASSWORD?.trim() || process.env.EMQX_PASSWORD?.trim() || undefined,
    topics,
    targetPlatformId: process.env.MQTT_TARGET_PLATFORM_ID?.trim() || 'mqtt:default',
    qos,
  };
}

function createAdapter(cfg: MqttChannelConfig): ChannelAdapter {
  let client: MqttClient | null = null;
  let setupConfig: ChannelSetup | null = null;

  const adapter: ChannelAdapter = {
    name: 'mqtt',
    channelType: 'mqtt',
    supportsThreads: false,

    isConnected(): boolean {
      return client?.connected ?? false;
    },

    async setup(config: ChannelSetup): Promise<void> {
      setupConfig = config;

      const options: IClientOptions = {
        username: cfg.username,
        password: cfg.password,
        reconnectPeriod: 30_000,
        clientId: `frontlane-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      };

      const c = mqtt.connect(cfg.brokerUrl, options);
      client = c;

      c.on('connect', () => {
        log.info('MQTT channel connected', { broker: cfg.brokerUrl, topics: cfg.topics });
        c.subscribe(cfg.topics, { qos: cfg.qos }, (err, granted) => {
          if (err) {
            log.error('MQTT subscribe failed', { err });
            return;
          }
          log.info('MQTT subscribed', {
            granted: (granted ?? []).map((g) => ({ topic: g.topic, qos: g.qos })),
          });
        });
      });

      c.on('reconnect', () => {
        log.warn('MQTT channel reconnecting', { broker: cfg.brokerUrl });
      });

      c.on('error', (err) => {
        log.error('MQTT channel error', { err });
      });

      c.on('message', (topic, payload) => {
        if (!setupConfig) return;
        const text = payload.toString('utf-8');
        const id = `mqtt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        const ts = new Date().toISOString();
        void Promise.resolve(
          setupConfig.onInbound(cfg.targetPlatformId, null, {
            id,
            kind: 'chat',
            content: { topic, payload: text, ts },
            timestamp: ts,
          }),
        ).catch((err: unknown) => {
          log.error('MQTT onInbound failed', { topic, err });
        });
      });
    },

    async teardown(): Promise<void> {
      if (client) {
        try {
          await new Promise<void>((resolve) => {
            client!.end(false, undefined, () => resolve());
          });
        } catch (err) {
          log.warn('MQTT teardown error (continuing)', { err });
        }
        client = null;
      }
      setupConfig = null;
    },

    async deliver(
      platformId: string,
      _threadId: string | null,
      _message: OutboundMessage,
    ): Promise<string | undefined> {
      // Outbound MQTT publishing isn't wired through this adapter — the
      // existing robot/chassis-move/etc. skills publish directly from their
      // Python scripts using paho-mqtt. Log + drop so an agent that
      // accidentally addresses an mqtt destination gets a visible signal.
      log.warn('MQTT adapter does not publish — outbound dropped', { platformId });
      return undefined;
    },

    async setTyping(): Promise<void> {
      // No-op — MQTT has no typing indicator.
    },
  };

  return adapter;
}

const envConfig = readEnvConfig();
registerChannelAdapter('mqtt', {
  factory: () => (envConfig ? createAdapter(envConfig) : null),
});
