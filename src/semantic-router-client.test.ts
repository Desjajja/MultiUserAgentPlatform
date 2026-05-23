/**
 * Tests for src/semantic-router-client.ts.
 *
 * Covers the four hard constraints from the Phase B/E design:
 *   1. timeout 200ms — `tryRoute` returns null on dead URL within bounded time
 *   2. matched_skill === '_main_self' → return null (NOT a worker)
 *   3. hint text (`<router-hint .../>`) contains tier="high|med", never a
 *      raw confidence float (would invalidate prompt prefix cache)
 *   4. byte-identical hint across two identical calls (cache friendliness)
 * + Phase E:
 *   5. _XXX-prefixed intent with a defined template + conf ≥ 0.95 → short_circuit
 *   6. _XXX-prefixed intent below threshold → null (fall through to LLM)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { tryRoute, buildHintTag } from './semantic-router-client.js';

const ROUTER_URL = 'http://127.0.0.1:7103/route';

beforeEach(() => {
  process.env.SEMANTIC_ROUTER_URL = ROUTER_URL;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.SEMANTIC_ROUTER_URL;
});

function mockFetchOnce(payload: Record<string, unknown>, ok = true): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify(payload), {
        status: ok ? 200 : 500,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
}

describe('tryRoute — graceful degradation', () => {
  it('returns null when router endpoint is unreachable', async () => {
    process.env.SEMANTIC_ROUTER_URL = 'http://127.0.0.1:1/route'; // unused port
    const start = Date.now();
    const decision = await tryRoute('查 transformer 论文');
    const elapsed = Date.now() - start;
    expect(decision).toBeNull();
    // Constraint #1: must respect 200ms timeout (allow generous slack for CI).
    expect(elapsed).toBeLessThan(2000);
  });

  it('returns null when router returns non-200', async () => {
    mockFetchOnce({}, false);
    const decision = await tryRoute('hello');
    expect(decision).toBeNull();
  });

  it('returns null on JSON parse error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(new Response('not json', { status: 200 })),
    );
    const decision = await tryRoute('hello');
    expect(decision).toBeNull();
  });
});

describe('tryRoute — _main_self fallback (constraint #2)', () => {
  it('returns null for _main_self even at conf=1.0 (LLM handles dynamic content)', async () => {
    mockFetchOnce({
      matched_skill: '_main_self',
      confidence: 1.0,
      is_unambiguous: true,
      top_3: [['_main_self', 1.0]],
    });
    const decision = await tryRoute('现在几点');
    expect(decision).toBeNull();
  });
});

describe('tryRoute — short-circuit (Phase E)', () => {
  it('short_circuits _greeting at high confidence', async () => {
    mockFetchOnce({
      matched_skill: '_greeting',
      confidence: 1.0,
      is_unambiguous: true,
      top_3: [['_greeting', 1.0], ['_ack', 0.7]],
    });
    const decision = await tryRoute('你好');
    expect(decision).not.toBeNull();
    if (!decision) return;
    expect(decision.kind).toBe('short_circuit');
    if (decision.kind === 'short_circuit') {
      expect(decision.intent).toBe('_greeting');
      expect(decision.replyText).toContain('FrontLane Desk');
    }
  });

  it('falls through (returns null) when _XXX is below short-circuit threshold', async () => {
    mockFetchOnce({
      matched_skill: '_ack',
      confidence: 0.84, // below 0.95 SC threshold
      is_unambiguous: true,
      top_3: [['_ack', 0.84]],
    });
    const decision = await tryRoute('请回复 OK_PING');
    expect(decision).toBeNull();
  });

  it('returns null for _XXX without a defined template', async () => {
    mockFetchOnce({
      matched_skill: '_unknown_intent',
      confidence: 1.0,
      is_unambiguous: true,
      top_3: [['_unknown_intent', 1.0]],
    });
    const decision = await tryRoute('mystery');
    expect(decision).toBeNull();
  });
});

describe('tryRoute — worker hint', () => {
  it('returns hint at tier=high for conf ≥ 0.85', async () => {
    mockFetchOnce({
      matched_skill: 'knowledge-worker',
      confidence: 0.96,
      is_unambiguous: true,
      top_3: [['knowledge-worker', 0.96]],
    });
    const decision = await tryRoute('查 transformer 论文');
    expect(decision?.kind).toBe('hint');
    if (decision?.kind === 'hint') {
      expect(decision.worker).toBe('knowledge-worker');
      expect(decision.tier).toBe('high');
    }
  });

  it('returns hint at tier=med for 0.75 ≤ conf < 0.85', async () => {
    mockFetchOnce({
      matched_skill: 'robot-worker',
      confidence: 0.78,
      is_unambiguous: true,
      top_3: [['robot-worker', 0.78]],
    });
    const decision = await tryRoute('move chassis');
    expect(decision?.kind).toBe('hint');
    if (decision?.kind === 'hint') {
      expect(decision.tier).toBe('med');
    }
  });

  it('returns null for ambiguous match', async () => {
    mockFetchOnce({
      matched_skill: 'knowledge-worker',
      confidence: 0.96,
      is_unambiguous: false, // <-- ambiguous
      top_3: [['knowledge-worker', 0.96]],
    });
    const decision = await tryRoute('mystery');
    expect(decision).toBeNull();
  });

  it('returns null for low-confidence worker', async () => {
    mockFetchOnce({
      matched_skill: 'knowledge-worker',
      confidence: 0.5,
      is_unambiguous: true,
      top_3: [['knowledge-worker', 0.5]],
    });
    const decision = await tryRoute('vague');
    expect(decision).toBeNull();
  });
});

describe('buildHintTag — cache-friendly text (constraints #3, #4)', () => {
  const baseHint = {
    kind: 'hint' as const,
    worker: 'knowledge-worker',
    tier: 'high' as const,
    rawConfidence: 0.964,
    topK: [],
  };

  it('contains tier= but never a float confidence (constraint #3)', () => {
    const tag = buildHintTag(baseHint);
    expect(tag).toMatch(/tier="(high|med)"/);
    // Must not contain decimal-like float text.
    expect(tag).not.toMatch(/0\.\d+/);
  });

  it('is byte-identical for the same (worker, tier) tuple (constraint #4)', () => {
    const tagA = buildHintTag({ ...baseHint, rawConfidence: 0.964 });
    const tagB = buildHintTag({ ...baseHint, rawConfidence: 0.987 });
    // Different rawConfidence MUST NOT change the tag — only worker+tier do.
    expect(tagA).toBe(tagB);
  });

  it('changes when worker changes', () => {
    const tagA = buildHintTag({ ...baseHint, worker: 'knowledge-worker' });
    const tagB = buildHintTag({ ...baseHint, worker: 'robot-worker' });
    expect(tagA).not.toBe(tagB);
  });

  it('changes when tier changes', () => {
    const tagA = buildHintTag({ ...baseHint, tier: 'high' });
    const tagB = buildHintTag({ ...baseHint, tier: 'med' });
    expect(tagA).not.toBe(tagB);
  });
});
