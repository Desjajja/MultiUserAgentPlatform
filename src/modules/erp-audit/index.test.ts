import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { queryErpAudit } from '../../db/erp-audit.js';
import { BusinessTagKeys, RouteLabel, SpanScope, applyBusinessTags } from '../../observability/business-tags.js';
import { endSessionRootSpan, storeSessionRootSpan } from '../../observability/context-bridge.js';
import type { DeliveryActionHandler } from '../../delivery.js';
import type { Session } from '../../types.js';
import type { Span, SpanContext } from '@opentelemetry/api';

const captured: Map<string, DeliveryActionHandler> = new Map();

vi.mock('../../delivery.js', () => ({
  registerDeliveryAction: (action: string, handler: DeliveryActionHandler) => {
    captured.set(action, handler);
  },
}));

// Importing the module triggers registerDeliveryAction as a side effect.
await import('./index.js');

function session(): Session {
  return {
    id: 'sess-1',
    agent_group_id: 'ag-1',
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
    traceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    spanId: 'bbbbbbbbbbbbbbbb',
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

describe('erp_audit delivery action', () => {
  it('persists a well-formed audit payload', async () => {
    const handler = captured.get('erp_audit');
    expect(handler).toBeDefined();
    await handler!(
      {
        action: 'erp_audit',
        path: '/execute',
        operation: 'finance.invoice.approve',
        userId: 'feishu:ou_1',
        requesterSource: 'session',
        status: 'ok',
        httpStatus: 200,
        durationMs: 42,
        idempotencyKey: 'idem-xyz',
        inputHash: 'deadbeef',
      },
      session(),
      // inDb is only used by schedulers; erp_audit writes central DB directly.
      {} as never,
    );

    const rows = queryErpAudit();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      session_id: 'sess-1',
      agent_group_id: 'ag-1',
      user_id: 'feishu:ou_1',
      path: '/execute',
      operation: 'finance.invoice.approve',
      requester_source: 'session',
      status: 'ok',
      http_status: 200,
      duration_ms: 42,
      idempotency_key: 'idem-xyz',
      input_hash: 'deadbeef',
    });
  });

  it('drops payloads missing required fields', async () => {
    const handler = captured.get('erp_audit')!;
    await handler({ action: 'erp_audit' }, session(), {} as never);
    expect(queryErpAudit()).toHaveLength(0);
  });

  it('coerces unknown status to error', async () => {
    const handler = captured.get('erp_audit')!;
    await handler(
      { action: 'erp_audit', path: '/execute', requesterSource: 'session', status: 'weird' },
      session(),
      {} as never,
    );
    expect(queryErpAudit()[0]!.status).toBe('error');
  });

  it('marks the live chat root with ERP metadata without renaming the interaction span', async () => {
    const handler = captured.get('erp_audit')!;
    const rootSpan = makeRootSpan('interaction.frontdesk');
    applyBusinessTags(rootSpan, {
      [BusinessTagKeys.SPAN_SCOPE]: SpanScope.BUSINESS,
      [BusinessTagKeys.ROUTE_LABEL]: RouteLabel.FRONTDESK,
      [BusinessTagKeys.ENTRYPOINT]: 'chat',
    });
    storeSessionRootSpan('sess-1', rootSpan);

    await handler(
      {
        action: 'erp_audit',
        path: '/execute',
        operation: 'finance.invoice.approve',
        requesterSource: 'session',
        status: 'ok',
      },
      session(),
      {} as never,
    );

    const metadata = parseMetadata(rootSpan);
    expect(rootSpan.name).toBe('interaction.frontdesk');
    expect(metadata.span_scope).toBe('business');
    expect(metadata.route_label).toBe('frontdesk');
    expect(metadata.used_erp).toBe(true);
    expect(metadata.biz_domain).toBe('erp');
    expect(metadata.erp_op).toBe('finance.invoice.approve');

    endSessionRootSpan('sess-1');
  });
});
