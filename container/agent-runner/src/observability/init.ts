import { NodeTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { type Context, context, propagation, ROOT_CONTEXT, trace } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';

let initialized = false;
let parentContext: Context = ROOT_CONTEXT;

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
    parentContext = propagation.extract(ROOT_CONTEXT, { traceparent });
  }
}

export function injectTraceparent(headers: Record<string, string>): Record<string, string> {
  const carrier: Record<string, string> = { ...headers };
  propagation.inject(parentContext, carrier);
  return carrier;
}

export function getTracer() {
  return trace.getTracer('agent-runner');
}
