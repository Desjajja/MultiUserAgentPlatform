import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { queryClassificationLog } from '../../db/classification-log.js';
import { BusinessTagKeys, RouteLabel, SpanScope, applyBusinessTags } from '../../observability/business-tags.js';
import { endSessionRootSpan, getSessionRootSpan, storeSessionRootSpan } from '../../observability/context-bridge.js';
import type { DeliveryActionHandler } from '../../delivery.js';
import type { Session } from '../../types.js';
import type { Span, SpanContext } from '@opentelemetry/api';

const captured: Map<string, DeliveryActionHandler> = new Map();

vi.mock('../../delivery.js', () => ({
  registerDeliveryAction: (action: string, handler: DeliveryActionHandler) => {
    captured.set(action, handler);
  },
}));

// Side-effect import registers the handler.
await import('./index.js');

function session(): Session {
  return {
    id: 'sess-1',
    agent_group_id: 'ag-frontdesk',
    messaging_group_id: null,
    thread_id: null,
    owner_user_id: null,
    root_session_id: 'sess-1',
    agent_provider: null,
    status: 'active',
    container_status: 'idle',
    last_active: new Date().toISOString(),
    created_at: new Date().toISOString(),
  };
}

function makeRootSpan(name = 'interaction.frontdesk'): Span & {
  attributes: Record<string, unknown>;
  ended: boolean;
  name: string;
} {
  type FakeRootSpan = Span & {
    attributes: Record<string, unknown>;
    ended: boolean;
    name: string;
  };
  const spanContext: SpanContext = {
    traceId: '0123456789abcdef0123456789abcdef',
    spanId: 'fedcba9876543210',
    traceFlags: 1,
    isRemote: false,
  };

  return {
    name,
    attributes: {},
    ended: false,
    spanContext: () => spanContext,
    setAttribute(this: FakeRootSpan, key: string, value: unknown) {
      this.attributes[key] = value;
      return this;
    },
    setAttributes(this: FakeRootSpan, attrs: Record<string, unknown>) {
      Object.assign(this.attributes, attrs);
      return this;
    },
    setStatus() {
      return this;
    },
    updateName(this: FakeRootSpan, nextName: string) {
      this.name = nextName;
      return this;
    },
    end(this: FakeRootSpan) {
      this.ended = true;
    },
    isRecording(this: FakeRootSpan) {
      return !this.ended;
    },
    recordException() {},
    addEvent() {
      return this;
    },
    addLink() {
      return this;
    },
  } as unknown as Span & { attributes: Record<string, unknown>; ended: boolean; name: string };
}

function parseMetadata(span: { attributes: Record<string, unknown> }): Record<string, unknown> {
  const raw = span.attributes.metadata;
  return typeof raw === 'string' ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
});

describe('classify_intent delivery action', () => {
  it('persists a normal classification into the log', async () => {
    const handler = captured.get('classify_intent');
    expect(handler).toBeDefined();

    await handler!(
      {
        action: 'classify_intent',
        userId: 'feishu:ou_alice',
        userMessage: 'please approve invoice INV-001',
        recommendedWorker: 'finance-worker',
        confidence: 0.91,
        candidates: ['finance-worker'],
        reasoning: 'mentions invoice + approve keywords',
        action_taken: 'delegate',
      },
      session(),
      {} as never,
    );

    const rows = queryClassificationLog();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: 'feishu:ou_alice',
      recommended_worker: 'finance-worker',
      confidence: 0.91,
      action: 'delegate',
      session_id: 'sess-1',
      agent_group_id: 'ag-frontdesk',
    });
  });

  it('defaults to action=delegate when the payload omits a recognized action_taken', async () => {
    const handler = captured.get('classify_intent')!;
    await handler(
      { action: 'classify_intent', userMessage: 'hi', confidence: 0.5 },
      session(),
      {} as never,
    );
    expect(queryClassificationLog()[0]!.action).toBe('delegate');
  });

  it('accepts each of the four action variants', async () => {
    const handler = captured.get('classify_intent')!;
    for (const a of ['delegate', 'clarify', 'reject', 'answer_self'] as const) {
      await handler(
        { action: 'classify_intent', userMessage: `msg-${a}`, confidence: 0.5, action_taken: a },
        session(),
        {} as never,
      );
    }
    const rows = queryClassificationLog();
    expect(rows.map((r) => r.action).sort()).toEqual(['answer_self', 'clarify', 'delegate', 'reject']);
  });

  it('trusts session.owner_user_id over agent-claimed userId', async () => {
    const handler = captured.get('classify_intent')!;
    const sess = session();
    sess.owner_user_id = 'feishu:ou_real';
    await handler(
      {
        action: 'classify_intent',
        userMessage: 'who am I',
        confidence: 0.9,
        action_taken: 'delegate',
        userId: 'feishu:ou_forged',
      },
      sess,
      {} as never,
    );
    const row = queryClassificationLog()[0]!;
    expect(row.user_id).toBe('feishu:ou_real');
  });

  it('persists channel/platform/thread fields from the payload', async () => {
    const handler = captured.get('classify_intent')!;
    await handler(
      {
        action: 'classify_intent',
        classificationId: 'cls-42',
        userMessage: 'hello',
        confidence: 0.8,
        action_taken: 'delegate',
        channelType: 'feishu',
        platformId: 'feishu:oc_group_1',
        threadId: 'thread-7',
      },
      session(),
      {} as never,
    );
    const row = queryClassificationLog()[0]!;
    expect(row.classification_id).toBe('cls-42');
    expect(row.channel_type).toBe('feishu');
    expect(row.platform_id).toBe('feishu:oc_group_1');
    expect(row.thread_id).toBe('thread-7');
  });

  it('merges classification metadata onto the live interaction root without clobbering existing tags', async () => {
    const handler = captured.get('classify_intent')!;
    const rootSpan = makeRootSpan();
    applyBusinessTags(rootSpan, {
      [BusinessTagKeys.SPAN_SCOPE]: SpanScope.BUSINESS,
      [BusinessTagKeys.ROUTE_LABEL]: RouteLabel.FRONTDESK,
      [BusinessTagKeys.ENTRYPOINT]: 'chat',
      [BusinessTagKeys.AGENT_GROUP]: 'frontdesk',
    });
    storeSessionRootSpan('sess-1', rootSpan);

    await handler(
      {
        action: 'classify_intent',
        classificationId: 'cls-merge-1',
        userMessage: 'please approve invoice INV-001',
        recommendedWorker: 'finance-worker',
        confidence: 0.91,
        candidates: ['finance-worker', 'ops-worker'],
        reasoning: 'x'.repeat(700),
        action_taken: 'delegate',
      },
      session(),
      {} as never,
    );

    const metadata = parseMetadata(rootSpan);
    expect(metadata.span_scope).toBe('business');
    expect(metadata.route_label).toBe('frontdesk');
    expect(metadata.entrypoint).toBe('chat');
    expect(metadata.agent_group).toBe('frontdesk');
    expect(metadata.classify_id).toBe('cls-merge-1');
    expect(metadata.selected_agent).toBe('finance-worker');
    expect(metadata.route_score).toBe(0.91);
    expect(metadata.agent_options).toEqual(['finance-worker', 'ops-worker']);
    expect(typeof metadata.route_reason).toBe('string');
    expect((metadata.route_reason as string).length).toBeLessThanOrEqual(500);

    endSessionRootSpan('sess-1');
  });

  it('persists the DB row and does not resurrect an already ended root span', async () => {
    const handler = captured.get('classify_intent')!;
    const rootSpan = makeRootSpan();
    storeSessionRootSpan('sess-1', rootSpan);
    endSessionRootSpan('sess-1');

    await expect(
      handler(
        {
          action: 'classify_intent',
          classificationId: 'cls-ended-1',
          userMessage: 'route this later',
          recommendedWorker: 'ops-worker',
          confidence: 0.42,
          reasoning: 'late classification',
          action_taken: 'delegate',
        },
        session(),
        {} as never,
      ),
    ).resolves.toBeUndefined();

    expect(queryClassificationLog()).toHaveLength(1);
    expect(getSessionRootSpan('sess-1')).toBeUndefined();
  });
});
