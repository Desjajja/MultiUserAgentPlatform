import { NodeTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { type Context, context, propagation, ROOT_CONTEXT, trace } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';

import { getOutboundDb } from '../db/connection.js';

let initialized = false;
let parentContext: Context = ROOT_CONTEXT;
const ACTIVE_TURN_TRACEPARENT_KEY = 'traceparent:active-turn';

export function initContainerOTel(sessionId: string): void {
  if (initialized) return;
  initialized = true;

  propagation.setGlobalPropagator(new W3CTraceContextPropagator());

  const provider = new NodeTracerProvider({
    resource: new Resource({
      [ATTR_SERVICE_NAME]: `agent-runner-${sessionId.slice(0, 8)}`,
    }),
  });

  const endpoint =
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ||
    'http://host.docker.internal:6006/v1/traces';

  provider.addSpanProcessor(new SimpleSpanProcessor(new OTLPTraceExporter({ url: endpoint })));
  provider.register();

  const traceparent = process.env.OTEL_TRACEPARENT;
  if (traceparent) {
    parentContext = propagation.extract(context.active(), { traceparent });
  }
}

export function injectTraceparent(headers: Record<string, string>): Record<string, string> {
  const carrier: Record<string, string> = { ...headers };
  propagation.inject(context.active(), carrier);
  if (!carrier.traceparent) {
    propagation.inject(parentContext, carrier);
  }
  return carrier;
}

export function contextFromTraceparent(traceparent?: string | null): Context {
  if (!traceparent) return parentContext;
  return propagation.extract(context.active(), { traceparent });
}

export function activeContextTraceparent(ctx: Context = context.active()): string | null {
  const carrier: Record<string, string> = {};
  propagation.inject(ctx, carrier);
  return carrier.traceparent ?? null;
}

export function storeActiveTurnTraceparent(ctx: Context = context.active()): void {
  const traceparent = activeContextTraceparent(ctx);
  if (!traceparent) return;
  try {
    getOutboundDb()
      .prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
      .run(ACTIVE_TURN_TRACEPARENT_KEY, traceparent, new Date().toISOString());
  } catch {
    // Best-effort bridge for the MCP child process. Runtime tracing should
    // still proceed even if the shared state DB is unavailable.
  }
}

export function readActiveTurnTraceparent(): string | null {
  try {
    const row = getOutboundDb()
      .prepare('SELECT value FROM session_state WHERE key = ?')
      .get(ACTIVE_TURN_TRACEPARENT_KEY) as { value: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

export function clearActiveTurnTraceparent(): void {
  try {
    getOutboundDb().prepare('DELETE FROM session_state WHERE key = ?').run(ACTIVE_TURN_TRACEPARENT_KEY);
  } catch {
    // Best-effort cleanup only.
  }
}

/**
 * Return the OTel context derived from `OTEL_TRACEPARENT` (set once by
 * `initContainerOTel`), or `ROOT_CONTEXT` if no traceparent was injected.
 *
 * Pass this as the third argument to `tracer.startSpan(name, opts, ctx)`
 * so container spans (notably `platform.agent.turn`) parent under the host trace
 * instead of becoming orphans. Without this, the host→container trace
 * tree breaks because the container process starts with `ROOT_CONTEXT`
 * as its active OTel context.
 */
export function getParentContext(): Context {
  return parentContext;
}

export function getTracer() {
  return trace.getTracer('agent-runner');
}
