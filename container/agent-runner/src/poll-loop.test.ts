import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from './db/connection.js';
import { clearRequestIdentity, setRequestIdentity } from './request-context.js';
import { getPendingMessages, markCompleted, markProcessing } from './db/messages-in.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { formatMessages, extractRouting } from './formatter.js';
import { processQuery, selectTurnTraceparent, dispatchResultText } from './poll-loop.js';
import { MockProvider } from './providers/mock.js';

beforeEach(() => {
  initTestSessionDb();
  try {
    getInboundDb().prepare('ALTER TABLE messages_in ADD COLUMN traceparent TEXT').run();
  } catch {
    // Already present in newer test schemas.
  }
});

afterEach(() => {
  clearRequestIdentity();
  closeSessionDb();
});

function insertMessage(
  id: string,
  kind: string,
  content: object,
  opts?: {
    processAfter?: string;
    trigger?: 0 | 1;
    platformId?: string | null;
    channelType?: string | null;
    threadId?: string | null;
    traceparent?: string | null;
  },
) {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, process_after, trigger, platform_id, channel_type, thread_id, traceparent, content)
     VALUES (?, ?, datetime('now'), 'pending', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      kind,
      opts?.processAfter ?? null,
      opts?.trigger ?? 1,
      opts?.platformId ?? null,
      opts?.channelType ?? null,
      opts?.threadId ?? null,
      opts?.traceparent ?? null,
      JSON.stringify(content),
    );
}

function sessionIdentity() {
  return {
    userId: 'feishu:ou_alice',
    channelType: 'feishu',
    platformId: 'feishu:p2p:ou_alice',
    threadId: null,
    source: 'session' as const,
  };
}

describe('formatter', () => {
  it('should format a single chat message', () => {
    insertMessage('m1', 'chat', { sender: 'John', text: 'Hello world' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('sender="John"');
    expect(prompt).toContain('Hello world');
  });

  it('should format multiple chat messages as XML block', () => {
    insertMessage('m1', 'chat', { sender: 'John', text: 'Hello' });
    insertMessage('m2', 'chat', { sender: 'Jane', text: 'Hi there' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('<messages>');
    expect(prompt).toContain('</messages>');
    expect(prompt).toContain('sender="John"');
    expect(prompt).toContain('sender="Jane"');
  });

  it('should format task messages', () => {
    insertMessage('m1', 'task', { prompt: 'Review open PRs' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('<task');
    expect(prompt).toContain('Review open PRs');
  });

  it('should format webhook messages', () => {
    insertMessage('m1', 'webhook', { source: 'github', event: 'push', payload: { ref: 'main' } });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('<webhook');
    expect(prompt).toContain('source="github"');
    expect(prompt).toContain('event="push"');
  });

  it('should format system messages', () => {
    insertMessage('m1', 'system', { action: 'register_group', status: 'success', result: { id: 'ag-1' } });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('<system_response');
    expect(prompt).toContain('action="register_group"');
  });

  it('should handle mixed kinds', () => {
    insertMessage('m1', 'chat', { sender: 'John', text: 'Hello' });
    insertMessage('m2', 'system', { action: 'test', status: 'ok', result: null });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('sender="John"');
    expect(prompt).toContain('<system_response');
  });

  it('should escape XML in content', () => {
    insertMessage('m1', 'chat', { sender: 'A<B', text: 'x > y && z' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('A&lt;B');
    expect(prompt).toContain('x &gt; y &amp;&amp; z');
  });
});

describe('accumulate gate (trigger column)', () => {
  it('getPendingMessages returns both trigger=0 and trigger=1 rows', () => {
    // trigger=0 rides along as context, trigger=1 is the wake-eligible row.
    // The poll loop's gate depends on this data contract.
    insertMessage('m1', 'chat', { sender: 'A', text: 'chit chat' }, { trigger: 0 });
    insertMessage('m2', 'chat', { sender: 'B', text: 'actual mention' }, { trigger: 1 });
    const messages = getPendingMessages();
    expect(messages).toHaveLength(2);
    const byId = Object.fromEntries(messages.map((m) => [m.id, m]));
    expect(byId.m1.trigger).toBe(0);
    expect(byId.m2.trigger).toBe(1);
  });

  it('trigger=0-only batch: gate predicate `some(trigger===1)` is false', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'noise' }, { trigger: 0 });
    insertMessage('m2', 'chat', { sender: 'B', text: 'more noise' }, { trigger: 0 });
    const messages = getPendingMessages();
    // This is the exact predicate the poll loop uses to skip accumulate-only
    // batches — gate should be false, so the loop sleeps without waking the agent.
    expect(messages.some((m) => m.trigger === 1)).toBe(false);
  });

  it('mixed batch: gate is true → loop proceeds, accumulated rows ride along', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'earlier chatter' }, { trigger: 0 });
    insertMessage('m2', 'chat', { sender: 'B', text: 'the real mention' }, { trigger: 1 });
    const messages = getPendingMessages();
    expect(messages.some((m) => m.trigger === 1)).toBe(true);
    // Both messages are present for the formatter → agent sees the prior context.
    expect(messages.map((m) => m.id).sort()).toEqual(['m1', 'm2']);
  });

  it('trigger column defaults to 1 for legacy inserts without explicit value', () => {
    // The schema default is 1 (see src/db/schema.ts INBOUND_SCHEMA) — existing
    // rows / tests without the column set are effectively wake-eligible.
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, content)
         VALUES ('m1', 'chat', datetime('now'), 'pending', '{"text":"hi"}')`,
      )
      .run();
    const [msg] = getPendingMessages();
    expect(msg.trigger).toBe(1);
  });
});

describe('routing', () => {
  it('should extract routing from messages', () => {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES ('m1', 'chat', datetime('now'), 'pending', 'chan-123', 'discord', 'thread-456', '{"text":"hi"}')`,
      )
      .run();

    const messages = getPendingMessages();
    const routing = extractRouting(messages);
    expect(routing.platformId).toBe('chan-123');
    expect(routing.channelType).toBe('discord');
    expect(routing.threadId).toBe('thread-456');
    expect(routing.inReplyTo).toBe('m1');
  });
});

describe('origin metadata (from= attribute)', () => {
  function seedDestination(name: string, channelType: string, platformId: string): void {
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES (?, ?, 'channel', ?, ?, NULL)`,
      )
      .run(name, name, channelType, platformId);
  }

  function insertWithRouting(id: string, kind: string, content: object, channelType: string | null, platformId: string | null): void {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, content)
         VALUES (?, ?, datetime('now'), 'pending', ?, ?, ?)`,
      )
      .run(id, kind, platformId, channelType, JSON.stringify(content));
  }

  it('chat message includes from= when destination matches', () => {
    seedDestination('discord-main', 'discord', 'chan-1');
    insertWithRouting('m1', 'chat', { sender: 'Alice', text: 'hi' }, 'discord', 'chan-1');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('from="discord-main"');
  });

  it('chat message falls back to raw routing when no destination matches', () => {
    insertWithRouting('m1', 'chat', { sender: 'Alice', text: 'hi' }, 'telegram', 'chat-999');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('from="unknown:telegram:chat-999"');
  });

  it('chat message omits from= when routing is null', () => {
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'hi' });
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).not.toContain('from=');
  });

  it('task message includes from= when destination matches', () => {
    seedDestination('slack-ops', 'slack', 'C-OPS');
    insertWithRouting('t1', 'task', { prompt: 'check status' }, 'slack', 'C-OPS');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('<task');
    expect(prompt).toContain('from="slack-ops"');
  });

  it('task message omits from= when routing is null', () => {
    insertMessage('t1', 'task', { prompt: 'check status' });
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('<task');
    expect(prompt).not.toContain('from=');
  });

  it('webhook message includes from= when destination matches', () => {
    seedDestination('github-ch', 'github', 'repo-1');
    insertWithRouting('w1', 'webhook', { source: 'github', event: 'push', payload: {} }, 'github', 'repo-1');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('<webhook');
    expect(prompt).toContain('from="github-ch"');
  });

  it('system message includes from= when destination matches', () => {
    seedDestination('discord-main', 'discord', 'chan-1');
    insertWithRouting('s1', 'system', { action: 'test', status: 'ok', result: null }, 'discord', 'chan-1');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('<system_response');
    expect(prompt).toContain('from="discord-main"');
  });
});

describe('mock provider', () => {
  it('should produce init + result events', async () => {
    const provider = new MockProvider({}, (prompt) => `Echo: ${prompt}`);
    const query = provider.query({
      prompt: 'Hello',
      cwd: '/tmp',
    });

    const events: Array<{ type: string }> = [];
    setTimeout(() => query.end(), 50);

    for await (const event of query.events) {
      events.push(event);
    }

    const typed = events.filter((e) => e.type !== 'activity');
    expect(typed.length).toBeGreaterThanOrEqual(2);
    expect(typed[0].type).toBe('init');
    expect(typed[1].type).toBe('result');
    expect((typed[1] as { text: string }).text).toBe('Echo: Hello');
  });

  it('should handle push() during active query', async () => {
    const provider = new MockProvider({}, (prompt) => `Re: ${prompt}`);
    const query = provider.query({
      prompt: 'First',
      cwd: '/tmp',
    });

    const events: Array<{ type: string; text?: string }> = [];

    setTimeout(() => query.push('Second'), 30);
    setTimeout(() => query.end(), 60);

    for await (const event of query.events) {
      events.push(event);
    }

    const results = events.filter((e) => e.type === 'result');
    expect(results).toHaveLength(2);
    expect(results[0].text).toBe('Re: First');
    expect(results[1].text).toBe('Re: Second');
  });
});

describe('traceparent turn selection', () => {
  it('uses the newest trigger row traceparent for the active turn parent', () => {
    const messages = [
      {
        id: 'older-trigger',
        seq: 1,
        kind: 'chat',
        timestamp: '2026-06-09T00:00:00Z',
        status: 'pending',
        process_after: null,
        recurrence: null,
        tries: 0,
        trigger: 1 as const,
        platform_id: 'feishu:p2p:ou_alice',
        channel_type: 'feishu',
        thread_id: null,
        content: JSON.stringify({ senderId: 'feishu:ou_alice', text: 'older' }),
        origin_user_id: null,
        traceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-1111111111111111-01',
      },
      {
        id: 'context-only',
        seq: 2,
        kind: 'chat',
        timestamp: '2026-06-09T00:00:01Z',
        status: 'pending',
        process_after: null,
        recurrence: null,
        tries: 0,
        trigger: 0 as const,
        platform_id: 'feishu:p2p:ou_alice',
        channel_type: 'feishu',
        thread_id: null,
        content: JSON.stringify({ senderId: 'feishu:ou_alice', text: 'context' }),
        origin_user_id: null,
        traceparent: '00-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-2222222222222222-01',
      },
      {
        id: 'newest-trigger',
        seq: 3,
        kind: 'chat',
        timestamp: '2026-06-09T00:00:02Z',
        status: 'pending',
        process_after: null,
        recurrence: null,
        tries: 0,
        trigger: 1 as const,
        platform_id: 'feishu:p2p:ou_alice',
        channel_type: 'feishu',
        thread_id: null,
        content: JSON.stringify({ senderId: 'feishu:ou_alice', text: 'newest' }),
        origin_user_id: null,
        traceparent: '00-cccccccccccccccccccccccccccccccc-3333333333333333-01',
      },
    ];

    expect(selectTurnTraceparent(messages)).toBe('00-cccccccccccccccccccccccccccccccc-3333333333333333-01');
  });
});

describe('result message routing', () => {
  function seedChannelDestination(name: string, channelType: string, platformId: string): void {
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES (?, ?, 'channel', ?, ?, NULL)`,
      )
      .run(name, name, channelType, platformId);
  }

  function seedAgentDestination(name: string, agentGroupId: string): void {
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES (?, ?, 'agent', NULL, NULL, ?)`,
      )
      .run(name, name, agentGroupId);
  }

  it('dispatches message blocks with extra attributes to the requested destination', async () => {
    seedChannelDestination('local-cli', 'cli', 'local');
    seedAgentDestination('access-worker', 'ag-access-worker');
    insertMessage(
      'm1',
      'chat',
      { senderId: 'cli:local', sender: 'cli', text: '请把这个问题转给合适的 worker' },
      { platformId: 'local', channelType: 'cli' },
    );

    const messages = getPendingMessages();
    const routing = extractRouting(messages);
    markProcessing(['m1']);

    const query = {
      push() {},
      end() {},
      abort() {},
      events: {
        async *[Symbol.asyncIterator]() {
          yield { type: 'init' as const, continuation: 'extra-message-attrs-test' };
          yield {
            type: 'result' as const,
            text: '<message to="access-worker" from="local-cli" context="接到用户请求：库存状态如何查询">用户询问：库存状态如何查询。请用一句话回复。</message>',
          };
        },
      },
    };

    await processQuery(query, routing, ['m1'], 'mock');

    const [outbound] = getUndeliveredMessages();
    expect(outbound.channel_type).toBe('agent');
    expect(outbound.platform_id).toBe('ag-access-worker');
    expect(JSON.parse(outbound.content).text).toBe('用户询问：库存状态如何查询。请用一句话回复。');
    expect(JSON.parse(outbound.content).text).not.toContain('<message');
  });
});

describe('follow-up traceparent guard', () => {
  it('ends the active query and releases rows when a follow-up carries a new traceparent', async () => {
    setRequestIdentity(sessionIdentity());
    insertMessage(
      'm1',
      'chat',
      { senderId: 'feishu:ou_alice', sender: 'Alice', text: 'first turn' },
      {
        trigger: 1,
        platformId: 'feishu:p2p:ou_alice',
        channelType: 'feishu',
        threadId: null,
        traceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-1111111111111111-01',
      },
    );
    const initialMessages = getPendingMessages();
    const routing = extractRouting(initialMessages);
    markProcessing(['m1']);

    let endCalls = 0;
    let waiting: (() => void) | null = null;
    const pushed: string[] = [];
    let ended = false;
    const query = {
      push(message: string) {
        pushed.push(message);
      },
      end() {
        endCalls += 1;
        ended = true;
        waiting?.();
      },
      abort() {
        ended = true;
        waiting?.();
      },
      events: {
        async *[Symbol.asyncIterator]() {
          yield { type: 'init' as const, continuation: 'followup-traceparent-test' };
          while (!ended) {
            await new Promise<void>((resolve) => {
              waiting = resolve;
            });
            waiting = null;
          }
        },
      },
    };

    const processPromise = processQuery(query, routing, ['m1'], 'mock', {
      activeTurnTraceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-1111111111111111-01',
    });

    await Bun.sleep(50);
    insertMessage(
      'm2',
      'chat',
      { senderId: 'feishu:ou_alice', sender: 'Alice', text: 'delegated follow-up' },
      {
        trigger: 1,
        platformId: 'feishu:p2p:ou_alice',
        channelType: 'feishu',
        threadId: null,
        traceparent: '00-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-2222222222222222-01',
      },
    );

    await Promise.race([
      processPromise,
      Bun.sleep(2000).then(() => {
        throw new Error('timed out waiting for processQuery to end');
      }),
    ]);

    expect(endCalls).toBe(1);
    expect(pushed).toHaveLength(0);
    expect(getPendingMessages().map((message) => message.id)).toContain('m2');
  });
});

describe('end-to-end with mock provider', () => {
  it('should read messages_in, process with mock provider, write messages_out', async () => {
    // Insert a chat message into inbound DB
    insertMessage('m1', 'chat', { sender: 'User', text: 'What is 2+2?' });

    // Read and process
    const messages = getPendingMessages();
    expect(messages).toHaveLength(1);

    const routing = extractRouting(messages);
    const prompt = formatMessages(messages);

    // Create mock provider and run query
    const provider = new MockProvider({}, () => 'The answer is 4');
    const query = provider.query({
      prompt,
      cwd: '/tmp',
    });

    // Process events — simulate what poll-loop does
    const { markProcessing } = await import('./db/messages-in.js');
    const { writeMessageOut } = await import('./db/messages-out.js');

    markProcessing(['m1']);

    setTimeout(() => query.end(), 50);

    for await (const event of query.events) {
      if (event.type === 'result' && event.text) {
        writeMessageOut({
          id: `out-${Date.now()}`,
          in_reply_to: routing.inReplyTo,
          kind: 'chat',
          platform_id: routing.platformId,
          channel_type: routing.channelType,
          thread_id: routing.threadId,
          content: JSON.stringify({ text: event.text }),
        });
      }
    }

    markCompleted(['m1']);

    // Verify: message was processed (not pending, acked in processing_ack)
    const processed = getPendingMessages();
    expect(processed).toHaveLength(0);

    // Verify: response was written to outbound DB
    const outMessages = getUndeliveredMessages();
    expect(outMessages).toHaveLength(1);
    expect(JSON.parse(outMessages[0].content).text).toBe('The answer is 4');
    expect(outMessages[0].in_reply_to).toBe('m1');
  });
});

describe('dispatchResultText', () => {
  it('delivers bare text via routing-context fallback when destinations map is empty', () => {
    dispatchResultText('Hello from sdk-openai', {
      channelType: 'cli',
      platformId: 'local',
      threadId: null,
      inReplyTo: 'm-cli-1',
    });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0]!.channel_type).toBe('cli');
    expect(out[0]!.platform_id).toBe('local');
    expect(out[0]!.in_reply_to).toBe('m-cli-1');
    expect(JSON.parse(out[0]!.content).text).toBe('Hello from sdk-openai');
  });
});
