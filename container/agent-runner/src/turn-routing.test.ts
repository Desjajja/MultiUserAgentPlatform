import { describe, expect, it } from 'bun:test';

import type { MessageInRow } from './db/messages-in.js';
import { extractRouting } from './formatter.js';
import { splitBatchByTurn } from './request-identity.js';

function row(partial: Partial<MessageInRow> & { id: string }): MessageInRow {
  return {
    seq: 2,
    kind: 'chat',
    timestamp: '2026-05-13T00:00:00Z',
    status: 'pending',
    process_after: null,
    recurrence: null,
    tries: 0,
    trigger: 1,
    platform_id: 'feishu:p2p:ou_alice',
    channel_type: 'feishu',
    thread_id: null,
    content: JSON.stringify({ senderId: 'feishu:ou_alice' }),
    origin_user_id: null,
    ...partial,
  };
}

describe('turn routing after batch split', () => {
  it('deferred oldest row would have wrongly anchored routing without recompute', () => {
    // Scenario from the review: oldest row in the batch is an accumulated
    // Bob message (trigger=0), newest is Alice's trigger=1. Anchor
    // identity picks Alice (first trigger=1 chat row), but extractRouting
    // picks the first message in the batch — Bob. If we use pre-split
    // routing for the Alice turn, all Alice's tool calls and error
    // replies get Bob's thread / in_reply_to stamped.
    const bobAccumulated = row({
      id: 'bob-1',
      trigger: 0,
      content: JSON.stringify({ senderId: 'feishu:ou_bob' }),
      platform_id: 'feishu:p2p:ou_bob',
      thread_id: 'bob-thread',
    });
    const aliceTrigger = row({
      id: 'alice-1',
      trigger: 1,
      content: JSON.stringify({ senderId: 'feishu:ou_alice' }),
      platform_id: 'feishu:p2p:ou_alice',
      thread_id: 'alice-thread',
    });
    const batch = [bobAccumulated, aliceTrigger];

    // Pre-split routing: first row is Bob.
    const preSplit = extractRouting(batch);
    expect(preSplit.platformId).toBe('feishu:p2p:ou_bob');
    expect(preSplit.threadId).toBe('bob-thread');
    expect(preSplit.inReplyTo).toBe('bob-1');

    // Split defers Bob; keep contains only Alice.
    const split = splitBatchByTurn(batch);
    expect(split.defer.map((m) => m.id)).toEqual(['bob-1']);
    expect(split.keep.map((m) => m.id)).toEqual(['alice-1']);

    // Post-split routing must use Alice, not Bob.
    const postSplit = extractRouting(split.keep);
    expect(postSplit.platformId).toBe('feishu:p2p:ou_alice');
    expect(postSplit.threadId).toBe('alice-thread');
    expect(postSplit.inReplyTo).toBe('alice-1');
  });

  it('when batch has no split, pre and post routing agree', () => {
    const one = row({ id: 'm1' });
    const two = row({ id: 'm2' });
    const pre = extractRouting([one, two]);
    const { keep } = splitBatchByTurn([one, two]);
    const post = extractRouting(keep);
    expect(post).toEqual(pre);
  });

  it('skips a leading non-chat row (task / webhook / system) and anchors on the chat row', () => {
    // Scenario from the latest review: a due task fires in the same
    // poll tick as Alice's chat message. splitBatchByTurn keeps the
    // task with the anchor (non-chat rows ride along), so keep[0] is
    // the task — its platform_id may be null or a scheduling sentinel.
    // extractRouting must skip it and anchor on Alice's chat row.
    const dueTask = row({
      id: 't-1',
      kind: 'task',
      // Tasks may have null routing (e.g. scheduled-by-self reminders)
      // or stale routing left over from when they were created.
      platform_id: null,
      channel_type: null,
      thread_id: null,
      content: '{}',
    });
    const aliceChat = row({
      id: 'alice-1',
      kind: 'chat',
      platform_id: 'feishu:p2p:ou_alice',
      thread_id: 'alice-thread',
    });

    const routing = extractRouting([dueTask, aliceChat]);
    expect(routing.platformId).toBe('feishu:p2p:ou_alice');
    expect(routing.threadId).toBe('alice-thread');
    expect(routing.inReplyTo).toBe('alice-1');
  });

  it('falls back to head-of-batch when there is no chat row at all', () => {
    // Pure task batch (e.g. a recurrence fired with no concurrent user
    // chat). Routing comes from the task itself; in practice these
    // batches don't produce user-facing outbound, so the value is
    // mostly defensive.
    const taskOnly = row({
      id: 't-only',
      kind: 'task',
      platform_id: 'feishu:p2p:ou_alice',
      thread_id: null,
      content: '{}',
    });
    const routing = extractRouting([taskOnly]);
    expect(routing.platformId).toBe('feishu:p2p:ou_alice');
    expect(routing.inReplyTo).toBe('t-only');
  });

  it("/clear ack uses turn-anchor routing, not pre-split batch[0]", () => {
    // Bob /clear arrives in the same tick as an older Alice
    // accumulated message. Pre-split batch[0] is Alice. With the fix
    // (split happens before /clear handling), Bob's /clear is the
    // anchor of his own turn and the ack lands in Bob's thread, not
    // Alice's.
    const aliceAccum = row({
      id: 'alice-1',
      trigger: 0,
      content: JSON.stringify({ senderId: 'feishu:ou_alice', text: 'thinking aloud' }),
      platform_id: 'feishu:p2p:ou_alice',
      thread_id: 'alice-thread',
    });
    const bobClear = row({
      id: 'bob-clear',
      trigger: 1,
      content: JSON.stringify({ senderId: 'feishu:ou_bob', text: '/clear' }),
      platform_id: 'feishu:p2p:ou_bob',
      thread_id: 'bob-thread',
    });

    const split = splitBatchByTurn([aliceAccum, bobClear]);
    // Anchor is Bob (his row is trigger=1), so Alice's accumulated row
    // gets deferred and the /clear runs against Bob's surface only.
    expect(split.keep.map((m) => m.id)).toEqual(['bob-clear']);
    expect(split.defer.map((m) => m.id)).toEqual(['alice-1']);

    const turnRouting = extractRouting(split.keep);
    expect(turnRouting.platformId).toBe('feishu:p2p:ou_bob');
    expect(turnRouting.threadId).toBe('bob-thread');
    expect(turnRouting.inReplyTo).toBe('bob-clear');
  });
});
