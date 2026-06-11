import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

import { BusinessTagKeys, RouteLabel, SpanScope, applyBusinessTags } from '../../observability/business-tags.js';
import { getSessionRootSpan, storeSessionRootSpan } from '../../observability/context-bridge.js';
import * as tracerModule from '../../observability/tracer.js';
import { isSafeAttachmentName, routeAgentMessage } from './agent-route.js';
import { createDestination } from './db/agent-destinations.js';
import { initTestDb, closeDb, runMigrations, createAgentGroup } from '../../db/index.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { createSession, getSessionsByAgentGroup, updateSession } from '../../db/sessions.js';
import { initSessionFolder, openInboundDb, openOutboundDb, sessionDir, writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import type { Span, SpanContext } from '@opentelemetry/api';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-a2a-route',
    GROUPS_DIR: '/tmp/nanoclaw-test-a2a-route/groups',
  };
});

const TEST_DIR = '/tmp/nanoclaw-test-a2a-route';

function now(): string {
  return new Date().toISOString();
}

function writeGroupConfig(folder: string, config: Record<string, unknown>): void {
  const dir = path.join(TEST_DIR, 'groups', folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'container.json'), JSON.stringify(config, null, 2) + '\n');
}

function readInbound(agentGroupId: string, sessionId: string) {
  const db = openInboundDb(agentGroupId, sessionId);
  const columns = new Set((db.prepare("PRAGMA table_info('messages_in')").all() as Array<{ name: string }>).map((c) => c.name));
  const traceparentExpr = columns.has('traceparent') ? 'traceparent' : 'NULL as traceparent';
  const rows = db
    .prepare(
      `SELECT id, platform_id, channel_type, content, source_session_id, origin_user_id, ${traceparentExpr} FROM messages_in ORDER BY seq`,
    )
    .all() as Array<{
    id: string;
    platform_id: string | null;
    channel_type: string | null;
    content: string;
    source_session_id: string | null;
    origin_user_id: string | null;
    traceparent: string | null;
  }>;
  db.close();
  return rows;
}

function readOutbound(agentGroupId: string, sessionId: string) {
  const db = openOutboundDb(agentGroupId, sessionId);
  const rows = db
    .prepare('SELECT id, platform_id, channel_type, thread_id, content, in_reply_to FROM messages_out ORDER BY seq')
    .all() as Array<{
    id: string;
    platform_id: string | null;
    channel_type: string | null;
    thread_id: string | null;
    content: string;
    in_reply_to: string | null;
  }>;
  db.close();
  return rows;
}

function makeRootSpan(
  name = 'interaction.frontdesk',
  spanContext: SpanContext = {
    traceId: '0123456789abcdef0123456789abcdef',
    spanId: 'fedcba9876543210',
    traceFlags: 1,
    isRemote: false,
  },
): Span & {
  attributes: Record<string, unknown>;
  ended: boolean;
  name: string;
} {
  type FakeRootSpan = Span & {
    attributes: Record<string, unknown>;
    ended: boolean;
    name: string;
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

describe('isSafeAttachmentName', () => {
  it('accepts plain filenames', () => {
    expect(isSafeAttachmentName('baby-duck.png')).toBe(true);
    expect(isSafeAttachmentName('file with spaces.pdf')).toBe(true);
    expect(isSafeAttachmentName('report.v2.docx')).toBe(true);
    expect(isSafeAttachmentName('.hidden')).toBe(true);
  });

  it('rejects empty / sentinel values', () => {
    expect(isSafeAttachmentName('')).toBe(false);
    expect(isSafeAttachmentName('.')).toBe(false);
    expect(isSafeAttachmentName('..')).toBe(false);
  });

  it('rejects path separators', () => {
    expect(isSafeAttachmentName('../evil.png')).toBe(false);
    expect(isSafeAttachmentName('/etc/passwd')).toBe(false);
    expect(isSafeAttachmentName('nested/file.txt')).toBe(false);
    expect(isSafeAttachmentName('windows\\path.exe')).toBe(false);
  });

  it('rejects NUL bytes', () => {
    expect(isSafeAttachmentName('clean\0.png')).toBe(false);
  });

  it('rejects anything path.basename would strip', () => {
    expect(isSafeAttachmentName('a/b')).toBe(false);
    expect(isSafeAttachmentName('./thing')).toBe(false);
  });

  it('rejects non-string input', () => {
    expect(isSafeAttachmentName(null as unknown as string)).toBe(false);
    expect(isSafeAttachmentName(undefined as unknown as string)).toBe(false);
  });
});

/**
 * Return-path routing: when an a2a reply targets an agent group with multiple
 * sessions, it must land in the *originating* session — not the newest one.
 *
 * Setup: agent A has two active sessions S1 (older) + S2 (newer).
 * Agent B is the peer A talks to. Bidirectional destinations wired.
 */
describe('routeAgentMessage return-path', () => {
  const A = 'ag-A';
  const B = 'ag-B';
  let S1: Session;
  let S2: Session;
  let SB: Session;

  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(path.join(TEST_DIR, 'groups'), { recursive: true });

    const db = initTestDb();
    runMigrations(db);

    createAgentGroup({ id: A, name: 'A', folder: 'a', agent_provider: null, created_at: now() });
    createAgentGroup({ id: B, name: 'B', folder: 'b', agent_provider: null, created_at: now() });

    // S1 (older), S2 (newer) — both active sessions on A.
    S1 = {
      id: 'sess-A-old',
      agent_group_id: A,
      messaging_group_id: null,
      thread_id: null,
      owner_user_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: '2026-01-01T00:00:00.000Z',
    };
    S2 = {
      id: 'sess-A-new',
      agent_group_id: A,
      messaging_group_id: null,
      thread_id: null,
      owner_user_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: '2026-02-01T00:00:00.000Z',
    };
    SB = {
      id: 'sess-B',
      agent_group_id: B,
      messaging_group_id: null,
      thread_id: null,
      owner_user_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: '2026-01-15T00:00:00.000Z',
    };
    createSession(S1);
    createSession(S2);
    createSession(SB);
    initSessionFolder(A, S1.id);
    initSessionFolder(A, S2.id);
    initSessionFolder(B, SB.id);

    createDestination({
      agent_group_id: A,
      local_name: 'b',
      target_type: 'agent',
      target_id: B,
      created_at: now(),
    });
    createDestination({
      agent_group_id: B,
      local_name: 'a',
      target_type: 'agent',
      target_id: A,
      created_at: now(),
    });
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('forward direction: stamps source_session_id on the target inbound row', async () => {
    // A.S1 emits an outbound a2a to B.
    await routeAgentMessage(
      {
        id: 'msg-from-A-S1',
        platform_id: B,
        content: JSON.stringify({ text: 'hello B' }),
        in_reply_to: null,
      },
      S1,
    );

    const bRows = readInbound(B, SB.id);
    expect(bRows).toHaveLength(1);
    expect(bRows[0].platform_id).toBe(A);
    expect(bRows[0].source_session_id).toBe(S1.id); // <- the return address
  });

  it('reply direction: routes back to the originating session, not the newest', async () => {
    // A.S1 sends to B.
    await routeAgentMessage(
      {
        id: 'msg-from-A-S1',
        platform_id: B,
        content: JSON.stringify({ text: 'ping' }),
        in_reply_to: null,
      },
      S1,
    );

    // Capture the synthetic id the host stamped on B's inbound — that's what
    // B's container would reference as `in_reply_to` when replying.
    const bRows = readInbound(B, SB.id);
    const yId = bRows[0].id;

    // B replies to that message.
    await routeAgentMessage(
      {
        id: 'msg-from-B',
        platform_id: A,
        content: JSON.stringify({ text: 'pong' }),
        in_reply_to: yId,
      },
      SB,
    );

    const s1Rows = readInbound(A, S1.id);
    const s2Rows = readInbound(A, S2.id);

    // The reply lands in S1 (originator) even though S2 is newer.
    expect(s1Rows).toHaveLength(1);
    expect(s1Rows[0].platform_id).toBe(B);
    expect(JSON.parse(s1Rows[0].content).text).toBe('pong');
    expect(s2Rows).toHaveLength(0);
  });

  it('relays worker replies to the origin chat instead of waking the frontdesk again', async () => {
    createMessagingGroup({
      id: 'mg-cli',
      channel_type: 'cli',
      platform_id: 'local',
      name: 'Local CLI',
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: now(),
    });

    const userFacingFrontdesk: Session = {
      id: 'sess-A-cli',
      agent_group_id: A,
      messaging_group_id: 'mg-cli',
      thread_id: null,
      owner_user_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: '2026-01-10T00:00:00.000Z',
    };
    createSession(userFacingFrontdesk);
    initSessionFolder(A, userFacingFrontdesk.id);
    writeSessionMessage(A, userFacingFrontdesk.id, {
      id: 'cli-question',
      kind: 'chat',
      timestamp: now(),
      platformId: 'local',
      channelType: 'cli',
      threadId: null,
      content: JSON.stringify({ text: '库存状态如何查询', senderId: 'cli:local' }),
    });

    await routeAgentMessage(
      {
        id: 'frontdesk-delegates-to-worker',
        platform_id: B,
        content: JSON.stringify({ text: '请用一句话回复：库存状态如何查询' }),
        in_reply_to: 'cli-question',
        origin_user_id: 'cli:local',
      },
      userFacingFrontdesk,
    );

    const rootSpan = makeRootSpan('interaction.worker');
    applyBusinessTags(rootSpan, {
      [BusinessTagKeys.SPAN_SCOPE]: SpanScope.BUSINESS,
      [BusinessTagKeys.ROUTE_LABEL]: RouteLabel.WORKER,
      [BusinessTagKeys.ENTRYPOINT]: 'chat',
    });
    storeSessionRootSpan(SB.id, rootSpan);

    const workerRows = readInbound(B, SB.id);
    const workerInboundId = workerRows[0].id;

    await routeAgentMessage(
      {
        id: 'worker-final-answer',
        platform_id: A,
        content: JSON.stringify({ text: '库存状态可在 ERP 库存管理模块实时查询。' }),
        in_reply_to: workerInboundId,
        origin_user_id: 'cli:local',
      },
      SB,
    );

    const frontdeskRows = readInbound(A, userFacingFrontdesk.id);
    const frontdeskOutbound = readOutbound(A, userFacingFrontdesk.id);

    expect(frontdeskRows).toHaveLength(1);
    expect(frontdeskRows[0].id).toBe('cli-question');
    expect(frontdeskOutbound).toHaveLength(1);
    expect(frontdeskOutbound[0].channel_type).toBe('cli');
    expect(frontdeskOutbound[0].platform_id).toBe('local');
    expect(JSON.parse(frontdeskOutbound[0].content).text).toBe('库存状态可在 ERP 库存管理模块实时查询。');
    expect(getSessionRootSpan(SB.id)).toBeUndefined();
    expect(rootSpan.ended).toBe(true);
    expect(rootSpan.attributes['output.value']).toBe('库存状态可在 ERP 库存管理模块实时查询。');
    expect(parseMetadata(rootSpan).turn_result).toBe('answered');
  });

  it('fallback: a2a with no in_reply_to falls through to newest-session lookup', async () => {
    // No prior conversation. B initiates an a2a to A out of the blue.
    await routeAgentMessage(
      {
        id: 'msg-from-B-fresh',
        platform_id: A,
        content: JSON.stringify({ text: 'unsolicited' }),
        in_reply_to: null,
      },
      SB,
    );

    // Newest session wins (current heuristic, preserved).
    const s1Rows = readInbound(A, S1.id);
    const s2Rows = readInbound(A, S2.id);
    expect(s1Rows).toHaveLength(0);
    expect(s2Rows).toHaveLength(1);
  });

  it('root-session mode: target worker gets a dedicated session per source root session', async () => {
    writeGroupConfig('b', { a2aSessionMode: 'root-session' });

    await routeAgentMessage(
      {
        id: 'msg-from-A-root',
        platform_id: B,
        content: JSON.stringify({ text: 'route to isolated worker lane' }),
        in_reply_to: null,
      },
      S1,
    );

    const bSessions = getSessionsByAgentGroup(B).filter((s) => s.status === 'active');
    const rootScoped = bSessions.find((s) => s.root_session_id === S1.id);
    expect(rootScoped).toBeDefined();
    expect(rootScoped?.id).not.toBe(SB.id);

    const sharedRows = readInbound(B, SB.id);
    const rootRows = readInbound(B, rootScoped!.id);
    expect(sharedRows).toHaveLength(0);
    expect(rootRows).toHaveLength(1);
    expect(JSON.parse(rootRows[0].content).text).toBe('route to isolated worker lane');
  });

  it('prefers msg.origin_user_id (stamped by container at emit time) over source-session lookup', async () => {
    // Source session has TWO chat rows — Alice's (older) and Bob's (newer).
    // Under the old behavior the a2a router would read "most recent" and
    // attribute to Bob. The container correctly stamped Alice on the
    // outbound (her turn was still running when it delegated). The router
    // must honor that stamp.
    writeSessionMessage(A, S1.id, {
      id: 'chat-from-alice',
      kind: 'chat',
      timestamp: now(),
      platformId: 'feishu:p2p:ou_alice',
      channelType: 'feishu',
      threadId: null,
      content: JSON.stringify({ senderId: 'ou_alice', text: 'please handle INV-001' }),
    });
    writeSessionMessage(A, S1.id, {
      id: 'chat-from-bob',
      kind: 'chat',
      timestamp: now(),
      platformId: 'feishu:p2p:ou_bob',
      channelType: 'feishu',
      threadId: null,
      content: JSON.stringify({ senderId: 'ou_bob', text: 'unrelated, raced in mid-turn' }),
    });

    await routeAgentMessage(
      {
        id: 'msg-from-A-to-B',
        platform_id: B,
        content: JSON.stringify({ text: 'handle this' }),
        in_reply_to: null,
        origin_user_id: 'feishu:ou_alice',
      },
      S1,
    );

    const bRows = readInbound(B, SB.id);
    expect(bRows).toHaveLength(1);
    expect(bRows[0].origin_user_id).toBe('feishu:ou_alice');
  });

  it('falls back to source-session lookup when the container did not stamp origin_user_id (legacy)', async () => {
    // Seed S1's inbound with a chat message that carries the real employee id.
    writeSessionMessage(A, S1.id, {
      id: 'chat-from-employee',
      kind: 'chat',
      timestamp: now(),
      platformId: 'feishu:p2p:ou_employee',
      channelType: 'feishu',
      threadId: null,
      content: JSON.stringify({ senderId: 'ou_employee', text: 'please handle INV-001' }),
    });

    // A.S1 (frontdesk) delegates to B (worker).
    await routeAgentMessage(
      {
        id: 'msg-from-A-to-B',
        platform_id: B,
        content: JSON.stringify({ text: 'handle this' }),
        in_reply_to: null,
      },
      S1,
    );

    const bRows = readInbound(B, SB.id);
    expect(bRows).toHaveLength(1);
    // Host namespaces bare ids to `<channel>:<id>` so worker-side identity
    // resolution doesn't need to know which channel produced the hop.
    expect(bRows[0].origin_user_id).toBe('feishu:ou_employee');
  });

  it('propagates origin_user_id across N-deep chains', async () => {
    // Hop 1: employee → A.S1
    writeSessionMessage(A, S1.id, {
      id: 'chat-from-employee',
      kind: 'chat',
      timestamp: now(),
      platformId: 'feishu:p2p:ou_employee',
      channelType: 'feishu',
      threadId: null,
      content: JSON.stringify({ senderId: 'ou_employee' }),
    });

    // Hop 2: A.S1 → B
    await routeAgentMessage(
      {
        id: 'a-to-b',
        platform_id: B,
        content: JSON.stringify({ text: 'delegate' }),
        in_reply_to: null,
      },
      S1,
    );

    // Hop 3: B → A (simulating a secondary worker further in the chain).
    // Use SB as source; its inbound now has an a2a row with origin_user_id set.
    await routeAgentMessage(
      {
        id: 'b-to-a',
        platform_id: A,
        content: JSON.stringify({ text: 'question' }),
        in_reply_to: null,
      },
      SB,
    );

    // The resulting inbound on A.S2 (newest session, fallback wins in absence
    // of in_reply_to / source_session_id for this test) should still carry
    // the original employee id — origin_user_id carried across.
    const s2Rows = readInbound(A, S2.id);
    const aRows = s2Rows.length > 0 ? s2Rows : readInbound(A, S1.id);
    const a2aRow = aRows.find((r) => r.channel_type === 'agent');
    expect(a2aRow).toBeDefined();
    expect(a2aRow!.origin_user_id).toBe('feishu:ou_employee');
  });

  it('peer-affinity fallback: with no in_reply_to, routes to most recent peer-source session', async () => {
    // A.S1 sends to B (establishing affinity: B's last contact from A was via S1).
    await routeAgentMessage(
      {
        id: 'msg-from-A-S1-pre',
        platform_id: B,
        content: JSON.stringify({ text: 'context-establishing' }),
        in_reply_to: null,
      },
      S1,
    );

    // B sends a follow-up but its container forgot to set in_reply_to (e.g.
    // emitted via an MCP tool path that doesn't thread the batch's in_reply_to
    // through). The host should still route this to S1 because S1 is the
    // session most recently in conversation with B — not the chronologically
    // newest session of A.
    await routeAgentMessage(
      {
        id: 'msg-from-B-followup',
        platform_id: A,
        content: JSON.stringify({ text: 'standing by' }),
        in_reply_to: null,
      },
      SB,
    );

    const s1Rows = readInbound(A, S1.id);
    const s2Rows = readInbound(A, S2.id);
    // Affinity wins: reply to S1, not the newer S2.
    expect(s1Rows).toHaveLength(1);
    expect(JSON.parse(s1Rows[0].content).text).toBe('standing by');
    expect(s2Rows).toHaveLength(0);
  });

  it('root-session mode: worker-to-worker delegation keeps the same root lane', async () => {
    const C = 'ag-C';
    const SC: Session = {
      id: 'sess-C-shared',
      agent_group_id: C,
      messaging_group_id: null,
      thread_id: null,
      owner_user_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: '2026-03-01T00:00:00.000Z',
    };

    createAgentGroup({ id: C, name: 'C', folder: 'c', agent_provider: null, created_at: now() });
    createSession(SC);
    initSessionFolder(C, SC.id);
    createDestination({ agent_group_id: B, local_name: 'c', target_type: 'agent', target_id: C, created_at: now() });

    writeGroupConfig('b', { a2aSessionMode: 'root-session' });
    writeGroupConfig('c', { a2aSessionMode: 'root-session' });

    await routeAgentMessage(
      {
        id: 'msg-frontdesk-to-b',
        platform_id: B,
        content: JSON.stringify({ text: 'frontdesk asks B to start work' }),
        in_reply_to: null,
      },
      S1,
    );

    const bRootSession = getSessionsByAgentGroup(B).find((s) => s.root_session_id === S1.id && s.id !== SB.id);
    expect(bRootSession).toBeDefined();

    await routeAgentMessage(
      {
        id: 'msg-b-to-c',
        platform_id: C,
        content: JSON.stringify({ text: 'B delegates to C' }),
        in_reply_to: null,
      },
      bRootSession!,
    );

    const cRootSession = getSessionsByAgentGroup(C).find((s) => s.root_session_id === S1.id && s.id !== SC.id);
    expect(cRootSession).toBeDefined();

    const cSharedRows = readInbound(C, SC.id);
    const cRootRows = readInbound(C, cRootSession!.id);
    expect(cSharedRows).toHaveLength(0);
    expect(cRootRows).toHaveLength(1);
    expect(JSON.parse(cRootRows[0].content).text).toBe('B delegates to C');
  });

  it('ends source root as delegated and starts a separate worker root with traceparent', async () => {
    writeGroupConfig('b', { a2aSessionMode: 'root-session' });

    const frontdeskRoot = makeRootSpan('interaction.frontdesk');
    const workerRoot = makeRootSpan('interaction.worker', {
      traceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      spanId: '1111111111111111',
      traceFlags: 1,
      isRemote: false,
    });
    const startSpan = vi.fn().mockReturnValue(workerRoot);
    const tracerSpy = vi.spyOn(tracerModule, 'getTracer').mockReturnValue({ startSpan } as unknown as ReturnType<typeof tracerModule.getTracer>);

    applyBusinessTags(frontdeskRoot, {
      [BusinessTagKeys.SPAN_SCOPE]: SpanScope.BUSINESS,
      [BusinessTagKeys.ROUTE_LABEL]: RouteLabel.FRONTDESK,
      [BusinessTagKeys.ENTRYPOINT]: 'chat',
    });
    storeSessionRootSpan(S1.id, frontdeskRoot);

    try {
      await routeAgentMessage(
        {
          id: 'msg-transfer-root',
          platform_id: B,
          content: JSON.stringify({ text: 'delegate to worker' }),
          in_reply_to: null,
        },
        S1,
      );
    } finally {
      tracerSpy.mockRestore();
    }

    const bRootSession = getSessionsByAgentGroup(B).find((s) => s.root_session_id === S1.id && s.id !== SB.id);
    expect(bRootSession).toBeDefined();
    if (!bRootSession) return;

    expect(getSessionRootSpan(S1.id)).toBeUndefined();
    expect(frontdeskRoot.ended).toBe(true);
    expect(frontdeskRoot.name).toBe('interaction.frontdesk');

    const frontdeskMetadata = parseMetadata(frontdeskRoot);
    expect(frontdeskMetadata.span_scope).toBe('business');
    expect(frontdeskMetadata.route_label).toBe('frontdesk');
    expect(frontdeskMetadata.turn_result).toBe('delegated');
    expect(frontdeskMetadata.delegate_to).toBe(B);
    expect(frontdeskMetadata.selected_agent).toBe(B);

    expect(startSpan).toHaveBeenCalledTimes(1);
    expect(getSessionRootSpan(bRootSession.id)).toBe(workerRoot);
    expect(workerRoot.name).toBe('interaction.worker');

    const metadata = parseMetadata(workerRoot);
    expect(metadata.span_scope).toBe('business');
    expect(metadata.route_label).toBe('worker');
    expect(metadata.engage_mode).toBe('a2a');
    expect(metadata.selected_agent).toBe(B);
    expect(workerRoot.attributes['input.value']).toBe('delegate to worker');

    const bRows = readInbound(B, bRootSession.id);
    expect(bRows).toHaveLength(1);
    expect(bRows[0].traceparent).toBe('00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-1111111111111111-01');
  });

  it('stale origin fallback: closed origin session falls through to newest active', async () => {
    // A.S1 sends to B, establishing source_session_id = S1.id on B's inbound.
    await routeAgentMessage(
      { id: 'msg-fwd', platform_id: B, content: JSON.stringify({ text: 'hello' }), in_reply_to: null },
      S1,
    );
    const bRows = readInbound(B, SB.id);
    const inboundId = bRows[0].id;

    // Close S1 — simulates session cleanup or channel disconnect.
    updateSession(S1.id, { status: 'closed' });

    // B replies. origin points to S1 (closed), should fall through to S2.
    await routeAgentMessage(
      { id: 'msg-reply-stale', platform_id: A, content: JSON.stringify({ text: 'reply' }), in_reply_to: inboundId },
      SB,
    );

    const s1Rows = readInbound(A, S1.id);
    const s2Rows = readInbound(A, S2.id);
    expect(s1Rows).toHaveLength(0);
    expect(s2Rows).toHaveLength(1);
  });

  it('cross-agent-group guard: origin session belonging to wrong agent group is rejected', async () => {
    // Third agent group C sends to B, stamping source_session_id = SC on B's inbound.
    const C = 'ag-C';
    createAgentGroup({ id: C, name: 'C', folder: 'c', agent_provider: null, created_at: now() });
    const SC: Session = {
      id: 'sess-C',
      agent_group_id: C,
      messaging_group_id: null,
      thread_id: null,
      owner_user_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: '2026-03-01T00:00:00.000Z',
    };
    createSession(SC);
    initSessionFolder(C, SC.id);
    createDestination({ agent_group_id: C, local_name: 'b', target_type: 'agent', target_id: B, created_at: now() });

    await routeAgentMessage(
      { id: 'msg-from-C', platform_id: B, content: JSON.stringify({ text: 'from C' }), in_reply_to: null },
      SC,
    );
    const bRows = readInbound(B, SB.id);
    const cInboundId = bRows.find((r) => r.platform_id === C)!.id;

    // B replies to A, but in_reply_to references the C-originated row.
    // Guard rejects (SC belongs to C, not A) → falls through to newest of A.
    await routeAgentMessage(
      {
        id: 'msg-reply-tamper',
        platform_id: A,
        content: JSON.stringify({ text: 'misdirected' }),
        in_reply_to: cInboundId,
      },
      SB,
    );

    const s1Rows = readInbound(A, S1.id);
    const s2Rows = readInbound(A, S2.id);
    expect(s1Rows).toHaveLength(0);
    expect(s2Rows).toHaveLength(1);
  });

  it('in_reply_to referencing a non-a2a row falls through to newest session', async () => {
    // Write a channel message into B's inbound (no source_session_id).
    writeSessionMessage(B, SB.id, {
      id: 'channel-msg-1',
      kind: 'chat',
      timestamp: now(),
      platformId: 'user-123',
      channelType: 'slack',
      threadId: null,
      content: 'hello from slack',
    });

    // B replies to A with in_reply_to pointing to the channel message.
    // source_session_id is null → peer-affinity finds nothing → newest of A.
    await routeAgentMessage(
      {
        id: 'msg-reply-channel',
        platform_id: A,
        content: JSON.stringify({ text: 'response' }),
        in_reply_to: 'channel-msg-1',
      },
      SB,
    );

    const s1Rows = readInbound(A, S1.id);
    const s2Rows = readInbound(A, S2.id);
    expect(s1Rows).toHaveLength(0);
    expect(s2Rows).toHaveLength(1);
  });

  it('self-message is allowed without a destination row', async () => {
    // A targets itself — no agent_destinations row exists for A→A.
    await routeAgentMessage(
      { id: 'self-msg', platform_id: A, content: JSON.stringify({ text: 'self-note' }), in_reply_to: null },
      S1,
    );

    // Lands in S2 (newest active session of A via resolveSession fallback).
    const s2Rows = readInbound(A, S2.id);
    expect(s2Rows).toHaveLength(1);
    expect(JSON.parse(s2Rows[0].content).text).toBe('self-note');
  });

  it('BUG: no volume cap on a2a routing — unbounded ping-pong is allowed (#2063)', async () => {
    // Two agents can exchange unlimited messages with no rate limit or loop
    // detection. This test documents the gap — it should FAIL once #2063 lands.
    const errors: string[] = [];
    for (let i = 0; i < 20; i++) {
      try {
        await routeAgentMessage(
          { id: `ping-${i}`, platform_id: B, content: JSON.stringify({ text: `ping ${i}` }), in_reply_to: null },
          S1,
        );
        await routeAgentMessage(
          { id: `pong-${i}`, platform_id: A, content: JSON.stringify({ text: `pong ${i}` }), in_reply_to: null },
          SB,
        );
      } catch (e) {
        errors.push((e as Error).message);
        break;
      }
    }
    // BUG: all 40 messages go through — no cap, no throttle.
    // Once loop prevention lands, this should throw or reject after a threshold.
    const bRows = readInbound(B, SB.id);
    const s1Rows = readInbound(A, S1.id);
    const s2Rows = readInbound(A, S2.id);
    expect(errors).toHaveLength(0);
    expect(bRows).toHaveLength(20);
    expect(s1Rows.length + s2Rows.length).toBe(20);
  });

  it('file forwarding: copies bytes from source outbox to target inbox', async () => {
    // Place a file in S1's outbox for the message.
    const outboxDir = path.join(sessionDir(A, S1.id), 'outbox', 'msg-with-file');
    fs.mkdirSync(outboxDir, { recursive: true });
    fs.writeFileSync(path.join(outboxDir, 'report.pdf'), 'fake-pdf-bytes');

    await routeAgentMessage(
      {
        id: 'msg-with-file',
        platform_id: B,
        content: JSON.stringify({ text: 'see attached', files: ['report.pdf'] }),
        in_reply_to: null,
      },
      S1,
    );

    const bRows = readInbound(B, SB.id);
    expect(bRows).toHaveLength(1);
    const parsed = JSON.parse(bRows[0].content);
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0].name).toBe('report.pdf');
    expect(parsed.attachments[0].type).toBe('file');

    // Verify actual file bytes were copied to the target inbox.
    const targetPath = path.join(sessionDir(B, SB.id), parsed.attachments[0].localPath);
    expect(fs.existsSync(targetPath)).toBe(true);
    expect(fs.readFileSync(targetPath, 'utf-8')).toBe('fake-pdf-bytes');
  });
});
