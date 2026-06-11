import { context, SpanStatusCode, trace } from '@opentelemetry/api';

import { contextFromTraceparent, readActiveTurnTraceparent } from './init.js';
import { metadataAttributes } from './metadata.js';

const MAX_TOOL_PARAMETERS_LENGTH = 4000;

export interface ToolSpanOptions {
  spanName: string;
  toolName: string;
  toolParameters: Record<string, unknown>;
  toolGroup?: string;
  erpOp?: string;
  bizDomain?: string;
}

function serializeToolParameters(parameters: Record<string, unknown>): string {
  try {
    const json = JSON.stringify(parameters);
    return json.length > MAX_TOOL_PARAMETERS_LENGTH ? `${json.slice(0, MAX_TOOL_PARAMETERS_LENGTH)}...` : json;
  } catch {
    return '{"error":"unserializable tool parameters"}';
  }
}

function firstResultText(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const content = (result as { content?: Array<{ text?: unknown }> }).content;
  if (!Array.isArray(content) || content.length === 0) return null;
  const first = content[0]?.text;
  return typeof first === 'string' ? first : null;
}

export async function startToolSpan<T>(options: ToolSpanOptions, work: () => Promise<T> | T): Promise<T> {
  const tracer = trace.getTracer('agent-runner');
  const params = serializeToolParameters(options.toolParameters);
  const parentContext = trace.getSpan(context.active())
    ? context.active()
    : contextFromTraceparent(readActiveTurnTraceparent());
  const span = tracer.startSpan(
    options.spanName,
    {
      attributes: {
        'openinference.span.kind': 'TOOL',
        'tool.name': options.toolName,
        'tool.parameters': params,
        ...metadataAttributes({
          span_scope: 'tool',
          ...(options.toolGroup ? { tool_group: options.toolGroup } : {}),
          ...(options.erpOp ? { erp_op: options.erpOp } : {}),
          ...(options.bizDomain ? { biz_domain: options.bizDomain } : {}),
        }),
      },
    },
    parentContext,
  );

  try {
    const result = await context.with(trace.setSpan(parentContext, span), work);
    if ((result as { isError?: boolean } | undefined)?.isError) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: firstResultText(result) ?? 'tool returned isError=true',
      });
    } else {
      span.setStatus({ code: SpanStatusCode.OK });
    }
    return result;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
    span.recordException(err);
    throw error;
  } finally {
    span.end();
  }
}
