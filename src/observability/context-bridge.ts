import type { SpanContext } from '@opentelemetry/api';

/**
 * In-memory bridge: sessionId -> SpanContext
 *
 * Note: concurrent writes for the same sessionId result in last-write-wins.
 * This is an accepted lossy behavior for the current use case.
 */
const bridge = new Map<string, SpanContext>();

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
