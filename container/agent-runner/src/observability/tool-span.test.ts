import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { propagation, ROOT_CONTEXT, trace } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { NodeTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node';

import { closeSessionDb, initTestSessionDb } from '../db/connection.js';
import { clearActiveTurnTraceparent, storeActiveTurnTraceparent } from './init.js';
import { startToolSpan } from './tool-span.js';
import { startAgentTurn } from './turn-span.js';

class CapturingExporter {
  readonly spans: Array<{
    name: string;
    traceId: string;
    spanId: string;
    parentSpanId?: string;
    attributes: Record<string, unknown>;
  }> = [];

  export(
    spans: ReadonlyArray<{
      name: string;
      spanContext: () => unknown;
      parentSpanId?: string;
      attributes?: Record<string, unknown>;
    }>,
    cb: (r: { code: number }) => void,
  ): void {
    for (const span of spans) {
      const ctx = span.spanContext() as { traceId: string; spanId: string };
      this.spans.push({
        name: span.name,
        traceId: ctx.traceId,
        spanId: ctx.spanId,
        parentSpanId: span.parentSpanId,
        attributes: { ...(span.attributes ?? {}) },
      });
    }
    cb({ code: 0 });
  }

  async shutdown(): Promise<void> {}
  async forceFlush(): Promise<void> {}
}

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  clearActiveTurnTraceparent();
  closeSessionDb();
});

describe('tool span parenting', () => {
  it('parents tool spans under the active container turn', async () => {
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
    trace.disable();
    const exporter = new CapturingExporter();
    const provider = new NodeTracerProvider();
    provider.addSpanProcessor(new SimpleSpanProcessor(exporter as never));
    provider.register();

    const turn = startAgentTurn({
      sessionId: 'sess-tool-parenting',
      agentGroupId: 'agent-test',
      provider: 'mock',
      routeType: 'worker',
      parentContext: propagation.extract(ROOT_CONTEXT, {
        traceparent: '00-0123456789abcdef0123456789abcdef-1111111111111111-01',
      }),
    });

    await turn.run(async () => {
      await startToolSpan(
        {
          spanName: 'mcp.classify',
          toolName: 'classify_intent',
          toolParameters: { confidence: 0.92, action: 'delegate' },
          toolGroup: 'mcp',
        },
        async () => undefined,
      );
      await startToolSpan(
        {
          spanName: 'mcp.erp',
          toolName: 'erp_execute',
          toolParameters: { operation: 'finance.invoice.approve' },
          toolGroup: 'mcp',
          bizDomain: 'erp',
          erpOp: 'finance.invoice.approve',
        },
        async () => undefined,
      );
    });
    turn.complete();

    const turnSpan = exporter.spans.find((span) => span.name === 'platform.agent.turn');
    const classifySpan = exporter.spans.find((span) => span.name === 'mcp.classify');
    const erpSpan = exporter.spans.find((span) => span.name === 'mcp.erp');

    expect(turnSpan).toBeDefined();
    expect(classifySpan).toBeDefined();
    expect(erpSpan).toBeDefined();
    expect(classifySpan!.traceId).toBe(turnSpan!.traceId);
    expect(erpSpan!.traceId).toBe(turnSpan!.traceId);
    expect(classifySpan!.parentSpanId).toBe(turnSpan!.spanId);
    expect(erpSpan!.parentSpanId).toBe(turnSpan!.spanId);

    trace.disable();
  });

  it('uses the persisted active-turn traceparent when no in-process span is active', async () => {
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
    trace.disable();
    const exporter = new CapturingExporter();
    const provider = new NodeTracerProvider();
    provider.addSpanProcessor(new SimpleSpanProcessor(exporter as never));
    provider.register();

    const turn = startAgentTurn({
      sessionId: 'sess-tool-parenting',
      agentGroupId: 'agent-test',
      provider: 'mock',
      routeType: 'worker',
      parentContext: propagation.extract(ROOT_CONTEXT, {
        traceparent: '00-99999999999999999999999999999999-4444444444444444-01',
      }),
    });

    await turn.run(async () => {
      storeActiveTurnTraceparent();
    });
    turn.complete();

    await startToolSpan(
      {
        spanName: 'mcp.classify',
        toolName: 'classify_intent',
        toolParameters: { confidence: 0.92, action: 'delegate' },
        toolGroup: 'mcp',
      },
      async () => undefined,
    );

    const turnSpan = exporter.spans.find((span) => span.name === 'platform.agent.turn');
    const classifySpan = exporter.spans.find((span) => span.name === 'mcp.classify');

    expect(turnSpan).toBeDefined();
    expect(classifySpan).toBeDefined();
    expect(classifySpan!.traceId).toBe(turnSpan!.traceId);
    expect(classifySpan!.parentSpanId).toBe(turnSpan!.spanId);

    trace.disable();
  });
});
