import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { propagation, ROOT_CONTEXT, trace } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { NodeTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from '../db/connection.js';
import { startAgentTurn } from '../observability/turn-span.js';
import { setRequestIdentity, clearRequestIdentity } from '../request-context.js';
import { classifyIntent, confidenceAdvisory } from './classify-intent.js';

class CapturingExporter {
  readonly spans: Array<{ name: string; attributes: Record<string, unknown> }> = [];

  export(
    spans: ReadonlyArray<{ name: string; attributes?: Record<string, unknown> }>,
    cb: (r: { code: number }) => void,
  ): void {
    for (const span of spans) {
      this.spans.push({ name: span.name, attributes: { ...(span.attributes ?? {}) } });
    }
    cb({ code: 0 });
  }

  async shutdown(): Promise<void> {}
  async forceFlush(): Promise<void> {}
}

function seedWorkers(names: string[]): void {
  const stmt = getInboundDb().prepare(
    `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
     VALUES (?, ?, 'agent', NULL, NULL, ?)`,
  );
  for (const n of names) stmt.run(n, n, `ag-${n}`);
}

beforeEach(() => {
  initTestSessionDb();
  seedWorkers(['finance-worker', 'sales-worker']);
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

  it('rejects out-of-range confidence', async () => {
    const below = await classifyIntent.handler({
      userMessage: 'x',
      confidence: -0.1,
      action: 'delegate',
    });
    expect(below.isError).toBe(true);
    expect(below.content[0]?.text).toMatch(/\[0, 1\]/);

    const above = await classifyIntent.handler({
      userMessage: 'x',
      confidence: 1.5,
      action: 'delegate',
    });
    expect(above.isError).toBe(true);
  });

  it('rejects a recommendedWorker that is not a real destination', async () => {
    const result = await classifyIntent.handler({
      userMessage: 'x',
      recommendedWorker: 'nonexistent-worker',
      confidence: 0.9,
      action: 'delegate',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/not a known agent destination/);
  });

  it('allows classification without a recommendedWorker (e.g. clarify / answer_self)', async () => {
    const result = await classifyIntent.handler({
      userMessage: 'vague question',
      confidence: 0.3,
      action: 'clarify',
    });
    expect(result.isError).toBeUndefined();
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

  it('emits a TOOL span with official fields', async () => {
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
    trace.disable();
    const exporter = new CapturingExporter();
    const provider = new NodeTracerProvider();
    provider.addSpanProcessor(new SimpleSpanProcessor(exporter as never));
    provider.register();

    const turn = startAgentTurn({
      sessionId: 'sess-classify-span',
      agentGroupId: 'ag-frontdesk',
      provider: 'mock',
      routeType: 'frontdesk',
      parentContext: propagation.extract(ROOT_CONTEXT, {
        traceparent: '00-0123456789abcdef0123456789abcdef-aaaaaaaaaaaaaaaa-01',
      }),
    });

    await turn.run(async () => {
      await classifyIntent.handler({
        userMessage: 'please approve INV-001',
        recommendedWorker: 'finance-worker',
        confidence: 0.9,
        candidates: ['finance-worker'],
        reasoning: 'mentions approve + invoice',
        action: 'delegate',
      });
    });
    turn.complete();

    const span = exporter.spans.find((entry) => entry.name === 'mcp.classify');
    expect(span).toBeDefined();
    expect(span!.attributes['openinference.span.kind']).toBe('TOOL');
    expect(span!.attributes['tool.name']).toBe('classify_intent');
    expect(JSON.parse(String(span!.attributes['tool.parameters']))).toMatchObject({
      recommendedWorker: 'finance-worker',
      confidence: 0.9,
      action: 'delegate',
    });
    const metadata = JSON.parse(String(span!.attributes.metadata)) as Record<string, unknown>;
    expect(metadata.span_scope).toBe('tool');
    expect(metadata.tool_group).toBe('mcp');

    trace.disable();
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
