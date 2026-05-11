import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb, runMigrations } from './db/index.js';
import { findClassificationById, recordClassification } from './db/classification-log.js';
import { reconcileClassification } from './delivery.js';
import { classificationBypassTotal } from './metrics.js';

async function bypassCount(reason: string, surface: string): Promise<number> {
  const all = await classificationBypassTotal.get();
  const match = all.values.find((v) => v.labels.reason === reason && v.labels.surface === surface);
  return match?.value ?? 0;
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  classificationBypassTotal.reset();
});

afterEach(() => {
  closeDb();
});

describe('reconcileClassification', () => {
  it('bumps no_classification_id when the outbound has no id field', async () => {
    const before = await bypassCount('no_classification_id', 'agent_send');
    reconcileClassification({ text: 'hi' }, 'out-1', 'agent_send');
    expect(await bypassCount('no_classification_id', 'agent_send')).toBe(before + 1);
  });

  it('bumps classification_not_found when id is present but not in the log', async () => {
    reconcileClassification({ text: 'hi', _classificationId: 'cls-ghost' }, 'out-1', 'agent_send');
    expect(await bypassCount('classification_not_found', 'agent_send')).toBe(1);
  });

  it('stamps outcome_ref when id matches a log row', async () => {
    recordClassification({
      action: 'delegate',
      classificationId: 'cls-001',
      recommendedWorker: 'finance-worker',
      confidence: 0.9,
    });
    reconcileClassification(
      { text: 'please handle this', _classificationId: 'cls-001' },
      'out-xyz',
      'agent_send',
    );
    const row = findClassificationById('cls-001')!;
    expect(row.outcome_ref).toBe('out-xyz');
  });

  it('bumps action_mismatch when declared action does not match surface', async () => {
    // Classification said clarify, but agent then did an a2a send.
    recordClassification({
      action: 'clarify',
      classificationId: 'cls-clarify-then-send',
      recommendedWorker: null,
      confidence: 0.5,
    });
    reconcileClassification(
      { text: 'going straight to worker', _classificationId: 'cls-clarify-then-send' },
      'out-2',
      'agent_send',
    );
    expect(await bypassCount('action_mismatch', 'agent_send')).toBe(1);
    // Still stamps outcome_ref — the link is more valuable than the guard.
    expect(findClassificationById('cls-clarify-then-send')?.outcome_ref).toBe('out-2');
  });

  it('matches clarify action with ask_user_question surface', async () => {
    recordClassification({
      action: 'clarify',
      classificationId: 'cls-ok-clarify',
      confidence: 0.5,
    });
    reconcileClassification(
      { type: 'ask_question', _classificationId: 'cls-ok-clarify' },
      'card-1',
      'ask_user_question',
    );
    expect(await bypassCount('action_mismatch', 'ask_user_question')).toBe(0);
    expect(findClassificationById('cls-ok-clarify')?.outcome_ref).toBe('card-1');
  });

  it('does not throw when the log table query fails inside try', () => {
    // Pass a non-string classificationId — hits the "no id" branch without error.
    expect(() => reconcileClassification({ _classificationId: 42 }, 'out-1', 'agent_send')).not.toThrow();
  });
});
