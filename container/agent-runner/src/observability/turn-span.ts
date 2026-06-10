/**
 * Container-side agent.turn span for OpenInference semantic tracing.
 *
 * Wraps a single inference cycle (prompt -> LLM -> tools -> output)
 * inside the agent runner. This is an AI-semantic CHAIN span that
 * carries the `muap.*` business tag namespace so traces can be
 * filtered by lane, provider, and route type in Phoenix.
 */
import { SpanStatusCode, trace } from '@opentelemetry/api';

export interface TurnSpanOptions {
  sessionId: string;
  agentGroupId: string;
  provider: string;
  turnIndex?: number;
}

function createTurnSpanName(options: TurnSpanOptions): string {
  return `agent.turn${options.turnIndex !== undefined ? `-${options.turnIndex}` : ''}`;
}

function createTurnSpanAttributes(options: TurnSpanOptions): Record<string, string> {
  const attrs: Record<string, string> = {
    'openinference.span.kind': 'CHAIN',
    'session.id': options.sessionId,
    'agent.group.id': options.agentGroupId,
    'muap.layer': 'ai',
    'muap.route_type': 'worker',
    'muap.lane': 'worker',
    'muap.provider': options.provider,
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
  complete(): void;
  fail(error: unknown): void;
}

export function startAgentTurn(options: TurnSpanOptions): AgentTurnHandle {
  const tracer = trace.getTracer('agent-runner');
  const spanName = createTurnSpanName(options);
  const attrs = createTurnSpanAttributes(options);
  const span = tracer.startSpan(spanName, { attributes: attrs });
  let ended = false;

  const endOnce = (finalize: () => void): void => {
    if (ended) return;
    ended = true;
    finalize();
    span.end();
  };

  return {
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
