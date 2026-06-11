import { describe, expect, it } from 'bun:test';
import { propagation, ROOT_CONTEXT, trace } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { NodeTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node';

import { contextFromTraceparent, initContainerOTel } from './init.js';
import { validateRouteType } from './metadata.js';
import { startAgentTurn } from './turn-span.js';

class CapturingExporter {
  readonly spans: Array<{
    name: string;
    spanContext: ReturnType<typeof captureContext>;
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
    for (const s of spans) {
      this.spans.push({
        name: s.name,
        spanContext: captureContext(s),
        parentSpanId: s.parentSpanId,
        attributes: { ...(s.attributes ?? {}) },
      });
    }
    cb({ code: 0 });
  }
  async shutdown(): Promise<void> {}
  async forceFlush(): Promise<void> {}
}

function captureContext(s: { spanContext: () => unknown }): { traceId: string; spanId: string } {
  const ctx = s.spanContext() as { traceId: string; spanId: string };
  return { traceId: ctx.traceId, spanId: ctx.spanId };
}

function metadataOf(span: { attributes: Record<string, unknown> }): Record<string, unknown> {
  return JSON.parse(String(span.attributes.metadata ?? '{}')) as Record<string, unknown>;
}

describe('startAgentTurn parent context', () => {
  it('parents under the explicitly-provided OTel context (host trace continuity)', () => {
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
    trace.disable();
    const exporter = new CapturingExporter();
    const provider = new NodeTracerProvider();
    provider.addSpanProcessor(new SimpleSpanProcessor(exporter as never));
    provider.register();

    const traceparent = '00-0123456789abcdef0123456789abcdef-fedcba9876543210-01';
    const parentCtx = propagation.extract(ROOT_CONTEXT, { traceparent });

    const handle = startAgentTurn({
      sessionId: 'sess-test',
      agentGroupId: 'agent-test',
      provider: 'mock',
      routeType: 'frontdesk',
      parentContext: parentCtx,
    });
    handle.complete();

    const turn = exporter.spans.find((s) => s.name === 'platform.agent.turn');
    expect(turn).toBeDefined();
    expect(turn!.spanContext.traceId).toBe('0123456789abcdef0123456789abcdef');
    expect(turn!.parentSpanId).toBe('fedcba9876543210');

    trace.disable();
  });

  it('uses the inbound per-turn traceparent instead of the startup fallback when present', () => {
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
    process.env.OTEL_TRACEPARENT = '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01';
    initContainerOTel('sess-startup-parent');

    trace.disable();
    const exporter = new CapturingExporter();
    const provider = new NodeTracerProvider();
    provider.addSpanProcessor(new SimpleSpanProcessor(exporter as never));
    provider.register();

    const handle = startAgentTurn({
      sessionId: 'sess-test',
      agentGroupId: 'agent-test',
      provider: 'mock',
      routeType: 'worker',
      parentContext: contextFromTraceparent('00-cccccccccccccccccccccccccccccccc-dddddddddddddddd-01'),
    });
    handle.complete();

    const turn = exporter.spans.find((s) => s.name === 'platform.agent.turn');
    expect(turn).toBeDefined();
    expect(turn!.spanContext.traceId).toBe('cccccccccccccccccccccccccccccccc');
    expect(turn!.parentSpanId).toBe('dddddddddddddddd');

    delete process.env.OTEL_TRACEPARENT;
    trace.disable();
  });

  it('emits platform metadata without route_type or lane business tags', () => {
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
    trace.disable();
    const exporter = new CapturingExporter();
    const provider = new NodeTracerProvider();
    provider.addSpanProcessor(new SimpleSpanProcessor(exporter as never));
    provider.register();

    const handle = startAgentTurn({
      sessionId: 'sess-test',
      agentGroupId: 'agent-test',
      provider: 'mock',
      routeType: 'frontdesk',
    });
    handle.complete();

    const turn = exporter.spans.find((s) => s.name === 'platform.agent.turn');
    expect(turn).toBeDefined();
    const metadata = metadataOf(turn!);
    expect(metadata.span_scope).toBe('platform');
    expect(metadata.component).toBe('agent');
    expect(metadata.provider).toBe('mock');
    expect(metadata.route_type).toBeUndefined();
    expect(metadata.lane).toBeUndefined();
    expect(metadata.session_id).toBe('sess-test');
    expect(turn!.attributes['session.id']).toBeUndefined();
    expect(turn!.attributes['input.value']).toBeUndefined();
    expect(turn!.attributes['output.value']).toBeUndefined();

    trace.disable();
  });
});

describe('validateRouteType', () => {
  it('passes through known route types', () => {
    expect(validateRouteType('frontdesk')).toBe('frontdesk');
    expect(validateRouteType('worker')).toBe('worker');
    expect(validateRouteType('erp')).toBe('erp');
    expect(validateRouteType('system')).toBe('system');
  });

  it('rejects a2a even when injected via env', () => {
    expect(validateRouteType('a2a')).toBe('worker');
  });

  it('rejects unknown values', () => {
    expect(validateRouteType('garbage')).toBe('worker');
    expect(validateRouteType('')).toBe('worker');
    expect(validateRouteType(undefined)).toBe('worker');
  });
});
