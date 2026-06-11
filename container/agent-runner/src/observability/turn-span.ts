/**
 * Container-side platform.agent.turn span for OpenInference semantic tracing.
 *
 * Wraps a single inference cycle (prompt -> LLM -> tools -> output)
 * inside the agent runner. This is a platform/runtime CHAIN span that
 * keeps tool + model work parented under the correct host/container trace
 * without pretending to be the user-visible business root.
 */
import { context, type Context, SpanStatusCode, trace } from '@opentelemetry/api';

import { getParentContext } from './init.js';
import { metadataAttributes } from './metadata.js';

export interface TurnSpanOptions {
  sessionId: string;
  agentGroupId: string;
  provider: string;
  routeType: string;
  turnIndex?: number;
  /**
   * OTel context the span should parent under. Defaults to `getParentContext()`
   * (the host-injected `OTEL_TRACEPARENT`). Tests inject an explicit context
   * to verify host→container trace continuity without depending on the
   * global init guard in `initContainerOTel`.
   */
  parentContext?: Context;
}

function createTurnSpanName(options: TurnSpanOptions): string {
  return `platform.agent.turn${options.turnIndex !== undefined ? `-${options.turnIndex}` : ''}`;
}

function createTurnSpanAttributes(options: TurnSpanOptions): Record<string, string> {
  const attrs: Record<string, string> = {
    'openinference.span.kind': 'CHAIN',
    // session.id is intentionally omitted: Phoenix Sessions groups any span
    // carrying the OpenInference session.id key, which would create empty
    // HUMAN/AI bubbles for this platform CHAIN (no input.value/output.value).
    // Correlate via metadata.session_id + W3C traceparent instead (ADR-0018).
    'agent.group.id': options.agentGroupId,
    ...metadataAttributes({
      span_scope: 'platform',
      component: 'agent',
      provider: options.provider,
      session_id: options.sessionId,
    }),
  };

  if (options.turnIndex !== undefined) {
    attrs['agent.turn.index'] = String(options.turnIndex);
  }

  return attrs;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export interface AgentTurnHandle {
  run<T>(work: () => Promise<T> | T): Promise<T>;
  complete(): void;
  fail(error: unknown): void;
}

export function startAgentTurn(options: TurnSpanOptions): AgentTurnHandle {
  const tracer = trace.getTracer('agent-runner');
  const spanName = createTurnSpanName(options);
  const attrs = createTurnSpanAttributes(options);
  const ctx = options.parentContext ?? getParentContext();
  const span = tracer.startSpan(spanName, { attributes: attrs }, ctx);
  const activeSpanContext = trace.setSpan(ctx, span);
  let ended = false;

  const endOnce = (finalize: () => void): void => {
    if (ended) return;
    ended = true;
    finalize();
    span.end();
  };

  return {
    run<T>(work: () => Promise<T> | T): Promise<T> {
      return Promise.resolve(context.with(activeSpanContext, work));
    },
    complete() {
      endOnce(() => {
        span.setStatus({ code: SpanStatusCode.OK });
      });
    },
    fail(error: unknown) {
      const err = toError(error);
      endOnce(() => {
        span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
        span.recordException(err);
      });
    },
  };
}
