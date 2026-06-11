import type { Attributes, Span, SpanContext } from '@opentelemetry/api';
import { SpanStatusCode, context, propagation, trace } from '@opentelemetry/api';

import { applyBusinessTags, interactionSpanName, type BusinessTags, type RouteLabel } from './business-tags.js';
import { rootInputAttrs } from './openinference.js';
import { getTracer } from './tracer.js';

/**
 * In-memory bridge: sessionId -> SpanContext
 *
 * Note: concurrent writes for the same sessionId result in last-write-wins.
 * This is an accepted lossy behavior for the current use case.
 */
const bridge = new Map<string, SpanContext>();

/**
 * Live root span bridge: sessionId -> Span
 *
 * Stores the actual Span instance so delivery can set output attributes
 * and end the span after all messages are delivered. The root span is
 * intentionally NOT ended by the router — its lifecycle extends until
 * delivery completes (or a safety timeout fires).
 */
const rootSpanBridge = new Map<string, Span>();

export function storeSessionSpanContext(sessionId: string, spanContext: SpanContext): void {
  bridge.set(sessionId, spanContext);
}

export function getSessionSpanContext(sessionId: string): SpanContext | undefined {
  return bridge.get(sessionId);
}

export function consumeSessionSpanContext(sessionId: string): SpanContext | undefined {
  const ctx = bridge.get(sessionId);
  if (ctx) {
    bridge.delete(sessionId);
  }
  return ctx;
}

export function clearSessionSpanContext(sessionId: string): void {
  bridge.delete(sessionId);
}

export function storeSessionRootSpan(sessionId: string, span: Span): void {
  if (!span.isRecording()) return;
  rootSpanBridge.set(sessionId, span);
}

export function getSessionRootSpan(sessionId: string): Span | undefined {
  const span = rootSpanBridge.get(sessionId);
  if (!span) return undefined;
  if (!span.isRecording()) {
    rootSpanBridge.delete(sessionId);
    return undefined;
  }
  return span;
}

function serializeTraceparent(spanContext: SpanContext): string | undefined {
  const carrier: Record<string, string> = {};
  propagation.inject(trace.setSpanContext(context.active(), spanContext), carrier);
  if (carrier.traceparent) return carrier.traceparent;

  const traceFlags = spanContext.traceFlags.toString(16).padStart(2, '0').slice(-2);
  return `00-${spanContext.traceId}-${spanContext.spanId}-${traceFlags}`;
}

export function updateSessionRootSpanTags(sessionId: string, tags: Partial<BusinessTags> | Record<string, unknown>): void {
  const span = getSessionRootSpan(sessionId);
  if (!span) return;
  applyBusinessTags(span, tags as Partial<BusinessTags>);
}

export function transferSessionRootSpan(
  fromSessionId: string,
  toSessionId: string,
  routeLabel: RouteLabel,
  tags: Partial<BusinessTags> | Record<string, unknown> = {},
): string | undefined {
  const span = getSessionRootSpan(fromSessionId);
  if (!span) return undefined;

  const existing = getSessionRootSpan(toSessionId);
  if (existing && existing !== span) {
    return serializeTraceparent(existing.spanContext());
  }

  rootSpanBridge.delete(fromSessionId);
  rootSpanBridge.set(toSessionId, span);

  const sourceContext = bridge.get(fromSessionId);
  if (sourceContext) {
    bridge.delete(fromSessionId);
    bridge.set(toSessionId, sourceContext);
  }

  span.updateName(interactionSpanName(routeLabel));
  applyBusinessTags(span, tags as Partial<BusinessTags>);

  return serializeTraceparent(span.spanContext());
}

export function startSessionRootSpan(opts: {
  sessionId: string;
  routeLabel: RouteLabel;
  inputValue: string;
  userId?: string | null;
  agentGroupId?: string;
  parentSessionId?: string;
  tags?: Partial<BusinessTags> | Record<string, unknown>;
}): string | undefined {
  const existing = getSessionRootSpan(opts.sessionId);
  if (existing) return serializeTraceparent(existing.spanContext());

  const attrs = rootInputAttrs({
    sessionId: opts.sessionId,
    userId: opts.userId,
    inputValue: opts.inputValue,
  }) as Attributes;
  if (opts.agentGroupId) attrs['agent.group.id'] = opts.agentGroupId;

  const parentSpan = opts.parentSessionId ? getSessionRootSpan(opts.parentSessionId) : undefined;
  const parentContext = parentSpan ? trace.setSpanContext(context.active(), parentSpan.spanContext()) : context.active();
  const span = getTracer().startSpan(interactionSpanName(opts.routeLabel), { attributes: attrs }, parentContext);
  span.setAttributes(attrs);
  applyBusinessTags(span, opts.tags ?? {});
  storeSessionRootSpan(opts.sessionId, span);
  storeSessionSpanContext(opts.sessionId, span.spanContext());

  return serializeTraceparent(span.spanContext());
}

/**
 * End and remove the root span for a session. Sets output attributes,
 * marks OK, and calls span.end(). Safe to call multiple times (second
 * call is a no-op since the span is already removed from the map).
 */
export function endSessionRootSpan(sessionId: string, outputValue?: string): void {
  const span = rootSpanBridge.get(sessionId);
  if (!span) return;
  rootSpanBridge.delete(sessionId);

  if (outputValue !== undefined) {
    span.setAttribute('output.value', outputValue);
    span.setAttribute('output.mime_type', 'text/plain');
  }
  span.setStatus({ code: SpanStatusCode.OK });
  span.end();
}

/**
 * Force-end a root span on failure (e.g. container wake failed).
 */
export function failSessionRootSpan(sessionId: string, error?: string): void {
  const span = rootSpanBridge.get(sessionId);
  if (!span) return;
  rootSpanBridge.delete(sessionId);

  span.setStatus({ code: SpanStatusCode.ERROR, message: error ?? 'delivery failed' });
  span.end();
}
