import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getOutboundDb } from '../db/connection.js';
import { setRequestIdentity, clearRequestIdentity } from '../request-context.js';
import { classifyIntent, confidenceAdvisory } from './classify-intent.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  clearRequestIdentity();
  closeSessionDb();
});

describe('classifyIntent tool handler', () => {
  it('returns a classificationId in the tool result text', async () => {
    const result = await classifyIntent.handler({
      userMessage: 'please approve INV-001',
      recommendedWorker: 'finance-worker',
      confidence: 0.9,
      candidates: ['finance-worker'],
      reasoning: 'mentions approve + invoice',
      action: 'delegate',
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('classificationId:');
    const match = text.match(/classificationId: (cls-[a-z0-9-]+)/);
    expect(match).not.toBeNull();
  });

  it('writes a system outbound row with identity fields and de-duplicated candidates', async () => {
    setRequestIdentity({
      userId: 'feishu:ou_alice',
      channelType: 'feishu',
      platformId: 'feishu:p2p:ou_alice',
      threadId: null,
      source: 'session',
    });

    await classifyIntent.handler({
      userMessage: 'give me a summary',
      // LLM duplicates recommendedWorker inside candidates — we must dedupe.
      recommendedWorker: 'sales-worker',
      candidates: ['sales-worker', 'finance-worker', 'sales-worker'],
      confidence: 0.8,
      action: 'delegate',
    });

    const row = getOutboundDb()
      .prepare("SELECT content FROM messages_out WHERE kind = 'system' ORDER BY seq DESC LIMIT 1")
      .get() as { content: string };
    const payload = JSON.parse(row.content);
    expect(payload.action).toBe('classify_intent');
    expect(payload.userId).toBe('feishu:ou_alice');
    expect(payload.channelType).toBe('feishu');
    expect(payload.platformId).toBe('feishu:p2p:ou_alice');
    expect(payload.threadId).toBeNull();
    expect(payload.candidates).toEqual(['sales-worker', 'finance-worker']);
    expect(payload.classificationId).toMatch(/^cls-/);
  });

  it('treats a single-candidate count correctly after dedup', async () => {
    setRequestIdentity({
      userId: 'feishu:ou_bob',
      channelType: 'feishu',
      platformId: 'feishu:p2p:ou_bob',
      threadId: null,
      source: 'session',
    });

    const result = await classifyIntent.handler({
      userMessage: 'hi',
      recommendedWorker: 'finance-worker',
      // Only candidate is identical to recommendedWorker — after dedup,
      // count should be 1, NOT 2 (the old bug).
      candidates: ['finance-worker'],
      confidence: 0.65,
      action: 'delegate',
    });
    const text = result.content[0]?.text ?? '';
    // A correctly de-duped single-candidate, low-confidence classification
    // should be advised to clarify on confidence alone — not trip the
    // "multiple plausible workers" branch.
    expect(text.toLowerCase()).toContain('ask_user_question');
  });
});

describe('confidenceAdvisory', () => {
  it('treats out-of-range confidence as invalid', () => {
    expect(confidenceAdvisory(Number.NaN, 2)).toMatch(/invalid/i);
    expect(confidenceAdvisory(-0.1, 2)).toMatch(/invalid/i);
    expect(confidenceAdvisory(1.1, 2)).toMatch(/invalid/i);
  });

  it('refuses to delegate when no candidates are identified', () => {
    expect(confidenceAdvisory(0.95, 0)).toMatch(/no candidate/i);
  });

  it('asks for clarification below 0.70 confidence', () => {
    expect(confidenceAdvisory(0.5, 1)).toMatch(/ask_user_question/);
    expect(confidenceAdvisory(0.69, 1)).toMatch(/ask_user_question/);
  });

  it('asks for clarification when multiple plausible workers at moderate confidence', () => {
    expect(confidenceAdvisory(0.65, 3)).toMatch(/ask_user_question/);
  });

  it('asks for a user-side confirmation at moderate-high confidence', () => {
    const advisory = confidenceAdvisory(0.8, 1);
    expect(advisory.toLowerCase()).toContain('delegate');
    expect(advisory.toLowerCase()).toContain('confirmation');
  });

  it('allows direct delegation at ≥ 0.85', () => {
    const advisory = confidenceAdvisory(0.9, 1);
    expect(advisory.toLowerCase()).toContain('delegate directly');
  });

  it('boundary: exactly 0.70 still triggers the "moderate" branch, not clarify', () => {
    const advisory = confidenceAdvisory(0.7, 1);
    // 0.70 is NOT < 0.70, so it falls into the moderate bucket.
    expect(advisory.toLowerCase()).toContain('moderate');
  });

  it('boundary: exactly 0.85 falls into the "high" bucket', () => {
    expect(confidenceAdvisory(0.85, 1).toLowerCase()).toContain('delegate directly');
  });
});
