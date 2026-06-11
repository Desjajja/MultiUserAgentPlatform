import fs from 'fs';
import { NodeSDK, tracing } from '@opentelemetry/sdk-node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(true),
}));

vi.mock('./enterprise-autowire.js', () => ({
  maybeAutowireEnterpriseFrontdesk: vi.fn(() => false),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-router-observability' };
});

import { createAgentGroup, createMessagingGroup, createMessagingGroupAgent, closeDb, initTestDb, runMigrations } from './db/index.js';
import { findSession } from './db/sessions.js';
import type { InboundEvent } from './channels/adapter.js';
import { stopTypingRefresh } from './modules/typing/index.js';
import { RouteLabel, SpanScope } from './observability/business-tags.js';
import { endSessionRootSpan, getSessionRootSpan } from './observability/context-bridge.js';
import { SemanticConventions } from './observability/openinference.js';
import { routeInbound } from './router.js';

const TEST_DIR = '/tmp/nanoclaw-test-router-observability';

const exporter = new tracing.InMemorySpanExporter();
const sdk = new NodeSDK({
  autoDetectResources: false,
  instrumentations: [],
  spanProcessors: [new tracing.SimpleSpanProcessor(exporter)],
});

function now(): string {
  return new Date().toISOString();
}

function parseMetadata(span: { attributes: Record<string, unknown> }): Record<string, unknown> {
  const raw = span.attributes.metadata;
  if (typeof raw !== 'string') return {};
  return JSON.parse(raw) as Record<string, unknown>;
}

function seedWorkerRoute(): void {
  createAgentGroup({
    id: 'ag-worker',
    name: 'Sales Worker',
    folder: 'frontlane-sales-worker',
    agent_provider: null,
    created_at: now(),
  });
  createMessagingGroup({
    id: 'mg-worker',
    channel_type: 'mock',
    platform_id: 'chan-worker',
    name: 'Worker Channel',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  createMessagingGroupAgent({
    id: 'mga-worker',
    messaging_group_id: 'mg-worker',
    agent_group_id: 'ag-worker',
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: now(),
  });
}

function seedUnwiredGroup(): void {
  createMessagingGroup({
    id: 'mg-drop',
    channel_type: 'mock',
    platform_id: 'chan-drop',
    name: 'Unwired Channel',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
}

function inboundEvent(opts: { platformId: string; text: string; isMention: boolean; isGroup: boolean }): InboundEvent {
  return {
    channelType: 'mock',
    platformId: opts.platformId,
    threadId: null,
    message: {
      id: `msg-${opts.platformId}`,
      kind: 'chat',
      content: JSON.stringify({
        text: opts.text,
        sender: 'Test User',
        senderId: 'user-1',
      }),
      timestamp: now(),
      isMention: opts.isMention,
      isGroup: opts.isGroup,
    },
  };
}

beforeAll(() => {
  sdk.start();
});

afterAll(async () => {
  await sdk.shutdown();
});

beforeEach(() => {
  exporter.reset();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('router observability', () => {
  it('uses a single interaction.worker business root for a successful route', async () => {
    seedWorkerRoute();

    await routeInbound(
      inboundEvent({
        platformId: 'chan-worker',
        text: 'Need order help',
        isMention: false,
        isGroup: true,
      }),
    );

    const session = findSession('mg-worker', null);
    expect(session).toBeDefined();
    if (!session) return;

    expect(getSessionRootSpan(session.id)).toBeDefined();

    endSessionRootSpan(session.id, 'Order details sent');
    stopTypingRefresh(session.id);

    const spans = exporter.getFinishedSpans();
    const inputSpans = spans.filter(
      (span) => span.attributes[SemanticConventions.INPUT_VALUE] === 'Need order help',
    );

    expect(inputSpans).toHaveLength(1);
    expect(inputSpans[0]?.name).toBe('interaction.worker');
    expect(inputSpans[0]?.attributes[SemanticConventions.OUTPUT_VALUE]).toBe('Order details sent');

    const metadata = parseMetadata(inputSpans[0]!);
    expect(metadata.span_scope).toBe(SpanScope.BUSINESS);
    expect(metadata.route_label).toBe(RouteLabel.WORKER);
    expect(metadata.entrypoint).toBe('chat');
    expect(metadata.channel).toBe('mock');

    const routeSpan = spans.find((span) => span.name === 'router.route');
    if (routeSpan) {
      const routeMetadata = parseMetadata(routeSpan);
      expect(routeMetadata.span_scope).not.toBe(SpanScope.BUSINESS);
      expect(routeMetadata.route_label).toBeUndefined();
      expect(routeSpan.attributes[SemanticConventions.INPUT_VALUE]).toBeUndefined();
    }
  });

  it('emits a non-business router drop span for an unwired mention', async () => {
    seedUnwiredGroup();

    await routeInbound(
      inboundEvent({
        platformId: 'chan-drop',
        text: '@bot help',
        isMention: true,
        isGroup: true,
      }),
    );

    const spans = exporter.getFinishedSpans();
    const dropSpan = spans.find((span) => span.name === 'platform.router.drop');

    expect(dropSpan).toBeDefined();
    if (!dropSpan) return;

    const metadata = parseMetadata(dropSpan);
    expect(metadata.span_scope).toBe(SpanScope.ROUTING);
    expect(metadata.route_label).toBeUndefined();
    expect(dropSpan.attributes[SemanticConventions.INPUT_VALUE]).toBeUndefined();
    expect(dropSpan.attributes[SemanticConventions.OUTPUT_VALUE]).toBeUndefined();
  });

  it('does not create a business interaction root for filtered slash commands', async () => {
    seedWorkerRoute();

    await routeInbound(
      inboundEvent({
        platformId: 'chan-worker',
        text: '/help',
        isMention: false,
        isGroup: true,
      }),
    );

    const spans = exporter.getFinishedSpans();
    const filteredInputSpans = spans.filter(
      (span) => span.attributes[SemanticConventions.INPUT_VALUE] === '/help',
    );
    const dropSpan = spans.find((span) => span.name === 'platform.router.drop');

    expect(filteredInputSpans).toHaveLength(0);
    expect(dropSpan).toBeDefined();
    if (!dropSpan) return;

    const metadata = parseMetadata(dropSpan);
    expect(metadata.span_scope).toBe(SpanScope.ROUTING);
    expect(metadata.route_label).toBeUndefined();
    expect(dropSpan.attributes[SemanticConventions.INPUT_VALUE]).toBeUndefined();
    expect(dropSpan.attributes[SemanticConventions.OUTPUT_VALUE]).toBeUndefined();
  });
});
