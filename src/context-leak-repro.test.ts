/**
 * Reproduction tests for multi-user context leakage scenarios.
 *
 * Each case models a configuration or routing path that can cause user B's
 * agent turn to read user A's conversation history. Run with:
 *   pnpm vitest run src/context-leak-repro.test.ts
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
  initTestDb,
  runMigrations,
} from './db/index.js';
import { createDestination } from './modules/agent-to-agent/db/agent-destinations.js';
import { routeAgentMessage } from './modules/agent-to-agent/agent-route.js';
import { getSessionsByAgentGroup } from './db/sessions.js';
import { updateMessagingGroupAgent } from './db/messaging-groups.js';
import { openInboundDb, resolveSession, writeSessionMessage } from './session-manager.js';

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-context-leak',
    GROUPS_DIR: '/tmp/nanoclaw-test-context-leak/groups',
  };
});

const TEST_DIR = '/tmp/nanoclaw-test-context-leak';

function now(): string {
  return new Date().toISOString();
}

function writeGroupConfig(folder: string, config: Record<string, unknown>): void {
  const dir = path.join(TEST_DIR, 'groups', folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'container.json'), `${JSON.stringify(config, null, 2)}\n`);
}

function readInboundTexts(agentGroupId: string, sessionId: string): string[] {
  const db = openInboundDb(agentGroupId, sessionId);
  const rows = db.prepare('SELECT content FROM messages_in ORDER BY seq').all() as Array<{ content: string }>;
  db.close();
  return rows.map((r) => {
    try {
      return (JSON.parse(r.content) as { text?: string }).text ?? r.content;
    } catch {
      return r.content;
    }
  });
}

function routeChat(
  routeInbound: (event: import('./channels/adapter.js').InboundEvent) => Promise<void>,
  opts: {
    senderId: string;
    sender: string;
    text: string;
    isMention?: boolean;
    messageId?: string;
  },
): Promise<void> {
  return routeInbound({
    channelType: 'discord',
    platformId: 'chan-shared',
    threadId: null,
    message: {
      id: opts.messageId ?? `msg-${opts.senderId}-${Date.now()}`,
      kind: 'chat',
      content: JSON.stringify({
        senderId: opts.senderId,
        sender: opts.sender,
        text: opts.text,
      }),
      timestamp: now(),
      isMention: opts.isMention,
    },
  });
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(path.join(TEST_DIR, 'groups'), { recursive: true });

  const db = initTestDb();
  runMigrations(db);

  createAgentGroup({
    id: 'ag-frontdesk',
    name: 'Frontdesk',
    folder: 'frontdesk',
    agent_provider: null,
    created_at: now(),
  });
  createMessagingGroup({
    id: 'mg-shared',
    channel_type: 'discord',
    platform_id: 'chan-shared',
    name: 'Shared Channel',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  createMessagingGroupAgent({
    id: 'mga-frontdesk',
    messaging_group_id: 'mg-shared',
    agent_group_id: 'ag-frontdesk',
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: now(),
  });
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('context leak reproduction — misconfiguration paths', () => {
  it('H1: session_mode=shared merges all senders into one inbound.db (LEAK)', async () => {
    const { routeInbound } = await import('./router.js');
    await import('./modules/permissions/index.js');

    await routeChat(routeInbound, {
      senderId: 'user-1',
      sender: 'User 1',
      text: 'SECRET_CODE=alpha-7734',
      messageId: 'u1-secret',
    });
    await routeChat(routeInbound, {
      senderId: 'user-2',
      sender: 'User 2',
      text: 'what did I ask before?',
      messageId: 'u2-followup',
    });

    const sessions = getSessionsByAgentGroup('ag-frontdesk');
    expect(sessions).toHaveLength(1);

    const texts = readInboundTexts('ag-frontdesk', sessions[0].id);
    expect(texts).toContain('SECRET_CODE=alpha-7734');
    expect(texts).toContain('what did I ask before?');
  });

  it('H2: worker a2aSessionMode=agent-shared shares worker context across users (LEAK)', async () => {
    createAgentGroup({
      id: 'ag-worker',
      name: 'Worker',
      folder: 'worker',
      agent_provider: null,
      created_at: now(),
    });
    writeGroupConfig('worker', {}); // default a2aSessionMode → agent-shared

    createDestination({
      agent_group_id: 'ag-frontdesk',
      local_name: 'worker',
      target_type: 'agent',
      target_id: 'ag-worker',
      created_at: now(),
    });

    const { session: user1Frontdesk } = resolveSession(
      'ag-frontdesk',
      'mg-shared',
      null,
      'per-user',
      'discord:user-1',
    );
    const { session: user2Frontdesk } = resolveSession(
      'ag-frontdesk',
      'mg-shared',
      null,
      'per-user',
      'discord:user-2',
    );
    expect(user1Frontdesk.id).not.toBe(user2Frontdesk.id);

    writeSessionMessage('ag-frontdesk', user1Frontdesk.id, {
      id: 'u1-task',
      kind: 'chat',
      timestamp: now(),
      content: JSON.stringify({ senderId: 'user-1', text: 'lookup order ORD-USER1-99' }),
    });
    writeSessionMessage('ag-frontdesk', user2Frontdesk.id, {
      id: 'u2-task',
      kind: 'chat',
      timestamp: now(),
      content: JSON.stringify({ senderId: 'user-2', text: 'lookup order ORD-USER2-42' }),
    });

    await routeAgentMessage(
      {
        id: 'a2a-u1',
        platform_id: 'ag-worker',
        content: JSON.stringify({ text: 'process ORD-USER1-99' }),
        in_reply_to: 'u1-task',
        origin_user_id: 'discord:user-1',
      },
      user1Frontdesk,
    );
    await routeAgentMessage(
      {
        id: 'a2a-u2',
        platform_id: 'ag-worker',
        content: JSON.stringify({ text: 'process ORD-USER2-42' }),
        in_reply_to: 'u2-task',
        origin_user_id: 'discord:user-2',
      },
      user2Frontdesk,
    );

    const workerSessions = getSessionsByAgentGroup('ag-worker').filter((s) => s.status === 'active');
    expect(workerSessions).toHaveLength(1);

    const workerTexts = readInboundTexts('ag-worker', workerSessions[0].id);
    expect(workerTexts).toContain('process ORD-USER1-99');
    expect(workerTexts).toContain('process ORD-USER2-42');
  });

  it('H4: mention-sticky + shared session lets user2 ride user1 sticky scope (LEAK)', async () => {
    const { routeInbound } = await import('./router.js');
    await import('./modules/permissions/index.js');
    const { wakeContainer } = await import('./container-runner.js');
    (wakeContainer as unknown as ReturnType<typeof vi.fn>).mockClear();

    updateMessagingGroupAgent('mga-frontdesk', {
      engage_mode: 'mention-sticky',
      session_mode: 'shared',
    });

    await routeChat(routeInbound, {
      senderId: 'user-1',
      sender: 'User 1',
      text: '@bot my project is Phoenix',
      isMention: true,
      messageId: 'sticky-u1',
    });
    await routeChat(routeInbound, {
      senderId: 'user-2',
      sender: 'User 2',
      text: 'summarize my project',
      messageId: 'sticky-u2',
    });

    const sessions = getSessionsByAgentGroup('ag-frontdesk');
    expect(sessions).toHaveLength(1);
    expect(wakeContainer).toHaveBeenCalledTimes(2);

    const texts = readInboundTexts('ag-frontdesk', sessions[0].id);
    expect(texts).toContain('@bot my project is Phoenix');
    expect(texts).toContain('summarize my project');
  });

  it('H5: accumulate + shared stores other users silent context (LEAK)', async () => {
    const { routeInbound } = await import('./router.js');
    await import('./modules/permissions/index.js');

    updateMessagingGroupAgent('mga-frontdesk', {
      engage_mode: 'mention',
      session_mode: 'shared',
      ignored_message_policy: 'accumulate',
    });

    await routeChat(routeInbound, {
      senderId: 'user-2',
      sender: 'User 2',
      text: 'quiet background: budget is $2M',
      messageId: 'accum-u2',
    });
    await routeChat(routeInbound, {
      senderId: 'user-1',
      sender: 'User 1',
      text: '@bot hello',
      isMention: true,
      messageId: 'accum-u1',
    });

    const sessions = getSessionsByAgentGroup('ag-frontdesk');
    expect(sessions).toHaveLength(1);

    const texts = readInboundTexts('ag-frontdesk', sessions[0].id);
    expect(texts[0]).toContain('budget is $2M');
    expect(texts[1]).toContain('@bot hello');
  });
});

describe('context leak reproduction — correct isolation controls', () => {
  it('per-user frontdesk isolates senders even under mention-sticky', async () => {
    const { routeInbound } = await import('./router.js');
    const { wakeContainer } = await import('./container-runner.js');
    await import('./modules/permissions/index.js');
    (wakeContainer as unknown as ReturnType<typeof vi.fn>).mockClear();

    updateMessagingGroupAgent('mga-frontdesk', {
      engage_mode: 'mention-sticky',
      session_mode: 'per-user',
    });

    await routeChat(routeInbound, {
      senderId: 'user-1',
      sender: 'User 1',
      text: '@bot Phoenix project',
      isMention: true,
    });
    await routeChat(routeInbound, {
      senderId: 'user-1',
      sender: 'User 1',
      text: 'follow-up without mention',
    });
    await routeChat(routeInbound, {
      senderId: 'user-2',
      sender: 'User 2',
      text: 'should not engage sticky scope of user 1',
    });

    const sessions = getSessionsByAgentGroup('ag-frontdesk');
    expect(sessions).toHaveLength(1);
    expect(sessions[0].owner_user_id).toBe('discord:user-1');
    expect(wakeContainer).toHaveBeenCalledTimes(2);
  });

  it('root-session worker isolates delegated work per frontdesk root session', async () => {
    createAgentGroup({
      id: 'ag-worker',
      name: 'Worker',
      folder: 'worker',
      agent_provider: null,
      created_at: now(),
    });
    writeGroupConfig('worker', { a2aSessionMode: 'root-session' });
    createDestination({
      agent_group_id: 'ag-frontdesk',
      local_name: 'worker',
      target_type: 'agent',
      target_id: 'ag-worker',
      created_at: now(),
    });

    const { session: user1Frontdesk } = resolveSession(
      'ag-frontdesk',
      'mg-shared',
      null,
      'per-user',
      'discord:user-1',
    );
    const { session: user2Frontdesk } = resolveSession(
      'ag-frontdesk',
      'mg-shared',
      null,
      'per-user',
      'discord:user-2',
    );

    await routeAgentMessage(
      {
        id: 'a2a-u1-root',
        platform_id: 'ag-worker',
        content: JSON.stringify({ text: 'user1 worker task' }),
        in_reply_to: null,
        origin_user_id: 'discord:user-1',
      },
      user1Frontdesk,
    );
    await routeAgentMessage(
      {
        id: 'a2a-u2-root',
        platform_id: 'ag-worker',
        content: JSON.stringify({ text: 'user2 worker task' }),
        in_reply_to: null,
        origin_user_id: 'discord:user-2',
      },
      user2Frontdesk,
    );

    const workerSessions = getSessionsByAgentGroup('ag-worker').filter((s) => s.status === 'active');
    expect(workerSessions).toHaveLength(2);
    expect(new Set(workerSessions.map((s) => s.root_session_id))).toEqual(
      new Set([user1Frontdesk.id, user2Frontdesk.id]),
    );

    const byRoot = new Map(workerSessions.map((s) => [s.root_session_id, s.id]));
    expect(readInboundTexts('ag-worker', byRoot.get(user1Frontdesk.id)!)).toEqual(['user1 worker task']);
    expect(readInboundTexts('ag-worker', byRoot.get(user2Frontdesk.id)!)).toEqual(['user2 worker task']);
  });
});
