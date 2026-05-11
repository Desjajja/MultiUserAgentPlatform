import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb, runMigrations } from './index.js';
import { queryClassificationLog, recordClassification } from './classification-log.js';

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
});

describe('classification_log', () => {
  it('records a full row including candidates and truncates long reasoning', () => {
    const longReason = 'x'.repeat(2000);
    recordClassification({
      sessionId: 's1',
      agentGroupId: 'ag-frontdesk',
      userId: 'feishu:ou_alice',
      userMessage: 'please approve invoice INV-001',
      recommendedWorker: 'finance-worker',
      confidence: 0.82,
      candidates: ['finance-worker', 'approval-worker'],
      reasoning: longReason,
      action: 'delegate',
    });

    const rows = queryClassificationLog();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      session_id: 's1',
      agent_group_id: 'ag-frontdesk',
      user_id: 'feishu:ou_alice',
      recommended_worker: 'finance-worker',
      confidence: 0.82,
      action: 'delegate',
    });
    expect(JSON.parse(rows[0]!.candidates as string)).toEqual(['finance-worker', 'approval-worker']);
    // Reasoning was 2000 chars → truncated to 1000.
    expect((rows[0]!.reasoning as string).length).toBe(1000);
    // userMessage is capped at 500.
    recordClassification({ action: 'clarify', userMessage: 'y'.repeat(800) });
    const latest = queryClassificationLog({ limit: 1 })[0]!;
    expect((latest.user_message as string).length).toBe(500);
  });

  it('filters by recommendedWorker and action', () => {
    recordClassification({ action: 'delegate', recommendedWorker: 'finance-worker', userId: 'u1' });
    recordClassification({ action: 'delegate', recommendedWorker: 'sales-worker', userId: 'u1' });
    recordClassification({ action: 'clarify', recommendedWorker: null, userId: 'u1' });

    expect(queryClassificationLog({ recommendedWorker: 'finance-worker' })).toHaveLength(1);
    expect(queryClassificationLog({ action: 'clarify' })).toHaveLength(1);
    expect(queryClassificationLog({ userId: 'u1' })).toHaveLength(3);
  });

  it('returns most recent first under limit', () => {
    for (let i = 0; i < 5; i++) {
      recordClassification({ action: 'delegate', recommendedWorker: `w-${i}` });
    }
    const rows = queryClassificationLog({ limit: 2 });
    expect(rows).toHaveLength(2);
    expect(rows[0]!.recommended_worker).toBe('w-4');
    expect(rows[1]!.recommended_worker).toBe('w-3');
  });

  it('persists null candidates as SQL NULL, not the string "null"', () => {
    recordClassification({ action: 'reject' });
    const row = queryClassificationLog()[0]!;
    expect(row.candidates).toBeNull();
    expect(row.recommended_worker).toBeNull();
  });

  it('stores channel/platform/thread identity alongside the row', () => {
    recordClassification({
      action: 'delegate',
      classificationId: 'cls-001',
      userId: 'feishu:ou_alice',
      channelType: 'feishu',
      platformId: 'feishu:p2p:ou_alice',
      threadId: null,
      recommendedWorker: 'finance-worker',
      confidence: 0.9,
    });
    const row = queryClassificationLog()[0]!;
    expect(row.classification_id).toBe('cls-001');
    expect(row.channel_type).toBe('feishu');
    expect(row.platform_id).toBe('feishu:p2p:ou_alice');
    expect(row.thread_id).toBeNull();
  });

  it('findClassificationById returns the row by id and undefined when missing', async () => {
    const { findClassificationById } = await import('./classification-log.js');
    recordClassification({ action: 'delegate', classificationId: 'cls-findme', recommendedWorker: 'w-1' });
    const hit = findClassificationById('cls-findme');
    expect(hit?.recommended_worker).toBe('w-1');
    expect(findClassificationById('cls-does-not-exist')).toBeUndefined();
  });

  it('linkOutcome stamps outcome_ref on the first call and is idempotent thereafter', async () => {
    const { findClassificationById, linkOutcome } = await import('./classification-log.js');
    recordClassification({ action: 'delegate', classificationId: 'cls-link-1' });

    expect(linkOutcome('cls-link-1', 'msg-abc')).toBe(true);
    expect(findClassificationById('cls-link-1')?.outcome_ref).toBe('msg-abc');

    // Second link attempt must NOT overwrite — first delivery wins.
    expect(linkOutcome('cls-link-1', 'msg-different')).toBe(false);
    expect(findClassificationById('cls-link-1')?.outcome_ref).toBe('msg-abc');
  });

  it('linkOutcome returns false when classification id is unknown', async () => {
    const { linkOutcome } = await import('./classification-log.js');
    expect(linkOutcome('cls-nope', 'msg-whatever')).toBe(false);
  });
});
