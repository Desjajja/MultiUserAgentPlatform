import { context } from '@opentelemetry/api';
import { getAttributesFromContext } from '@arizeai/openinference-core';
import { NodeSDK, tracing } from '@opentelemetry/sdk-node';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { getActiveSpan } from './tracer.js';
import {
  MAX_OPENINFERENCE_TEXT_CHARS,
  MimeType,
  OpenInferenceSpanKind,
  SemanticConventions,
  applyContextAttrsToSpan,
  createSessionContext,
  outputAttrs,
  rootInputAttrs,
  runInDetachedRoot,
  safeAttributeText,
  setOutputAttrs,
  setRootAttrs,
  setSpanKind,
} from './openinference.js';
import {
  BusinessTagKeys,
  RouteLabel,
  SpanScope,
  applyBusinessTags,
  createBusinessTags,
  deriveRouteLabel,
  interactionSpanName,
  platformSpanName,
} from './business-tags.js';
import { withSpan } from './with-span.js';

const exporter = new tracing.InMemorySpanExporter();
const sdk = new NodeSDK({
  autoDetectResources: false,
  instrumentations: [],
  spanProcessors: [new tracing.SimpleSpanProcessor(exporter)],
});

beforeAll(() => {
  sdk.start();
});

afterAll(async () => {
  await sdk.shutdown();
});

beforeEach(() => {
  exporter.reset();
});

describe('openinference helper', () => {
  test('createSessionContext adds session.id and optional user.id to context attributes', () => {
    const withUser = getAttributesFromContext(
      createSessionContext({ sessionId: 'sess-42', userId: 'user-7' }),
    );

    expect(withUser[SemanticConventions.SESSION_ID]).toBe('sess-42');
    expect(withUser[SemanticConventions.USER_ID]).toBe('user-7');

    const withoutUser = getAttributesFromContext(
      createSessionContext({ sessionId: 'sess-43', userId: null }),
    );

    expect(withoutUser[SemanticConventions.SESSION_ID]).toBe('sess-43');
    expect(withoutUser[SemanticConventions.USER_ID]).toBeUndefined();
  });

  test('safeAttributeText leaves short text unchanged', () => {
    const value = 'hello openinference';
    const result = safeAttributeText(value);

    expect(result).toEqual({ value, redacted: false });
  });

  test('safeAttributeText truncates long text and marks redaction', () => {
    const source = 'x'.repeat(4200);
    const result = safeAttributeText(source);

    expect(result.redacted).toBe(true);
    expect(result.value).toBe(`${source.slice(0, MAX_OPENINFERENCE_TEXT_CHARS)}…`);
    expect(result.value).toHaveLength(MAX_OPENINFERENCE_TEXT_CHARS + 1);
  });

  test('rootInputAttrs returns required root attrs and redaction only when truncated', () => {
    const shortAttrs = rootInputAttrs({
      sessionId: 'sess-42',
      userId: 'user-7',
      inputValue: 'hello PR-O2 phase 2 verify',
    });

    expect(shortAttrs[SemanticConventions.OPENINFERENCE_SPAN_KIND]).toBe(
      OpenInferenceSpanKind.AGENT,
    );
    expect(shortAttrs[SemanticConventions.SESSION_ID]).toBe('sess-42');
    expect(shortAttrs[SemanticConventions.USER_ID]).toBe('user-7');
    expect(shortAttrs[SemanticConventions.INPUT_VALUE]).toBe('hello PR-O2 phase 2 verify');
    expect(shortAttrs[SemanticConventions.INPUT_MIME_TYPE]).toBe(MimeType.TEXT);
    expect(shortAttrs['attribute.redacted']).toBeUndefined();

    const longAttrs = rootInputAttrs({
      sessionId: 'sess-99',
      userId: 'user-9',
      inputValue: 'x'.repeat(4200),
    });

    expect(longAttrs['attribute.redacted']).toBe(true);
    expect(String(longAttrs[SemanticConventions.INPUT_VALUE])).toHaveLength(
      MAX_OPENINFERENCE_TEXT_CHARS + 1,
    );
  });

  test('outputAttrs returns CHAIN kind plus output text attrs', () => {
    const textAttrs = outputAttrs('assistant reply');

    expect(textAttrs[SemanticConventions.OPENINFERENCE_SPAN_KIND]).toBe(
      OpenInferenceSpanKind.CHAIN,
    );
    expect(textAttrs[SemanticConventions.OUTPUT_VALUE]).toBe('assistant reply');
    expect(textAttrs[SemanticConventions.OUTPUT_MIME_TYPE]).toBe(MimeType.TEXT);
    expect(textAttrs['attribute.redacted']).toBeUndefined();

    const jsonAttrs = outputAttrs('{"ok":true}', 'json');

    expect(jsonAttrs[SemanticConventions.OUTPUT_MIME_TYPE]).toBe(MimeType.JSON);
  });

  test('span attribute helpers apply context, root input, output, and kind attrs', async () => {
    await context.with(
      createSessionContext({ sessionId: 'sess-ctx', userId: 'user-ctx' }),
      async () => {
        await withSpan('test.openinference.helpers', undefined, async () => {
          const span = getActiveSpan();

          expect(span).toBeDefined();
          if (!span) return;

          setSpanKind(span, OpenInferenceSpanKind.CHAIN);
          applyContextAttrsToSpan(span);
          setRootAttrs(span, {
            sessionId: 'sess-ctx',
            userId: 'user-ctx',
            inputValue: 'input payload',
          });
          setOutputAttrs(span, 'output payload');
        });
      },
    );

    const helperSpan = exporter
      .getFinishedSpans()
      .find((span) => span.name === 'test.openinference.helpers');

    expect(helperSpan).toBeDefined();
    expect(helperSpan?.attributes[SemanticConventions.OPENINFERENCE_SPAN_KIND]).toBe(
      OpenInferenceSpanKind.CHAIN,
    );
    expect(helperSpan?.attributes[SemanticConventions.SESSION_ID]).toBe('sess-ctx');
    expect(helperSpan?.attributes[SemanticConventions.USER_ID]).toBe('user-ctx');
    expect(helperSpan?.attributes[SemanticConventions.INPUT_VALUE]).toBe('input payload');
    expect(helperSpan?.attributes[SemanticConventions.OUTPUT_VALUE]).toBe('output payload');
  });

  test('runInDetachedRoot starts a detached span in a separate trace from the active outer span', async () => {
    let outerTraceId: string | undefined;
    let outerSpanId: string | undefined;
    let innerTraceId: string | undefined;
    let restoredSpanId: string | undefined;

    await withSpan('test.openinference.outer', undefined, async () => {
      const outer = getActiveSpan();
      outerTraceId = outer?.spanContext().traceId;
      outerSpanId = outer?.spanContext().spanId;

      await runInDetachedRoot(() =>
        withSpan('test.openinference.inner', undefined, async () => {
          innerTraceId = getActiveSpan()?.spanContext().traceId;
        }),
      );

      restoredSpanId = getActiveSpan()?.spanContext().spanId;
    });

    expect(outerTraceId).toBeDefined();
    expect(innerTraceId).toBeDefined();
    expect(innerTraceId).not.toBe(outerTraceId);
    expect(restoredSpanId).toBe(outerSpanId);
  });
});

describe('business-first taxonomy helpers', () => {
  describe('SpanScope and RouteLabel enums', () => {
    test('SpanScope has the four approved values', () => {
      expect(SpanScope.BUSINESS).toBe('business');
      expect(SpanScope.TOOL).toBe('tool');
      expect(SpanScope.PLATFORM).toBe('platform');
      expect(SpanScope.ROUTING).toBe('routing');
    });

    test('RouteLabel has the three approved values', () => {
      expect(RouteLabel.FRONTDESK).toBe('frontdesk');
      expect(RouteLabel.WORKER).toBe('worker');
      expect(RouteLabel.ERP).toBe('erp');
    });
  });

  describe('deriveRouteLabel', () => {
    test('returns frontdesk for folders ending in -frontdesk', () => {
      expect(deriveRouteLabel('frontlane-template-frontdesk')).toBe(RouteLabel.FRONTDESK);
      expect(deriveRouteLabel('myapp-frontdesk')).toBe(RouteLabel.FRONTDESK);
    });

    test('returns worker for non-frontdesk folders', () => {
      expect(deriveRouteLabel('frontlane-access-worker')).toBe(RouteLabel.WORKER);
      expect(deriveRouteLabel('frontlane-sales-worker')).toBe(RouteLabel.WORKER);
      expect(deriveRouteLabel('some-unknown-folder')).toBe(RouteLabel.WORKER);
    });
  });

  describe('interactionSpanName', () => {
    test('returns interaction.<label> for each RouteLabel', () => {
      expect(interactionSpanName(RouteLabel.FRONTDESK)).toBe('interaction.frontdesk');
      expect(interactionSpanName(RouteLabel.WORKER)).toBe('interaction.worker');
      expect(interactionSpanName(RouteLabel.ERP)).toBe('interaction.erp');
    });
  });

  describe('platformSpanName', () => {
    const VALID_COMPONENTS = ['delivery', 'container', 'channel', 'router', 'agent'] as const;
    const VALID_ACTIONS = [
      'wake', 'spawn', 'kill', 'drain', 'message', 'send', 'receive', 'turn',
    ] as const;

    test('returns platform.<component>.<action> for valid inputs', () => {
      expect(platformSpanName('delivery', 'drain')).toBe('platform.delivery.drain');
      expect(platformSpanName('container', 'wake')).toBe('platform.container.wake');
      expect(platformSpanName('channel', 'receive')).toBe('platform.channel.receive');
      expect(platformSpanName('router', 'drop')).toBe('platform.router.drop');
      expect(platformSpanName('agent', 'turn')).toBe('platform.agent.turn');
    });

    test('throws for unknown component', () => {
      expect(() => platformSpanName('unknown', 'wake')).toThrow('Unknown platform component');
    });

    test('throws for unknown action', () => {
      expect(() => platformSpanName('delivery', 'unknown')).toThrow('Unknown platform action');
    });
  });

  describe('BusinessTagKeys short names', () => {
    test('approved keys are short (≤3 snake_case words)', () => {
      const keys = Object.values(BusinessTagKeys);
      for (const key of keys) {
        const words = key.split('_').length;
        expect(words).toBeLessThanOrEqual(3);
      }
    });

    test('span_scope key exists and is short', () => {
      expect(BusinessTagKeys.SPAN_SCOPE).toBe('span_scope');
    });

    test('route_label key exists and is short', () => {
      expect(BusinessTagKeys.ROUTE_LABEL).toBe('route_label');
    });

    test('entrypoint key exists', () => {
      expect(BusinessTagKeys.ENTRYPOINT).toBe('entrypoint');
    });

    test('biz_domain key exists and is short', () => {
      expect(BusinessTagKeys.BIZ_DOMAIN).toBe('biz_domain');
    });

    test('used_erp key exists and is short', () => {
      expect(BusinessTagKeys.USED_ERP).toBe('used_erp');
    });

    test('classify_id key exists and is short', () => {
      expect(BusinessTagKeys.CLASSIFY_ID).toBe('classify_id');
    });

    test('route_reason key exists and is short', () => {
      expect(BusinessTagKeys.ROUTE_REASON).toBe('route_reason');
    });

    test('route_score key exists and is short', () => {
      expect(BusinessTagKeys.ROUTE_SCORE).toBe('route_score');
    });

    test('selected_agent key exists and is short', () => {
      expect(BusinessTagKeys.SELECTED_AGENT).toBe('selected_agent');
    });

    test('agent_options key exists and is short', () => {
      expect(BusinessTagKeys.AGENT_OPTIONS).toBe('agent_options');
    });

    test('access_result key exists and is short', () => {
      expect(BusinessTagKeys.ACCESS_RESULT).toBe('access_result');
    });

    test('tool_group key exists and is short', () => {
      expect(BusinessTagKeys.TOOL_GROUP).toBe('tool_group');
    });

    test('erp_op key exists and is short', () => {
      expect(BusinessTagKeys.ERP_OP).toBe('erp_op');
    });

    test('turn_result key exists and is short', () => {
      expect(BusinessTagKeys.TURN_RESULT).toBe('turn_result');
    });

    test('delegate_to key exists and is short', () => {
      expect(BusinessTagKeys.DELEGATE_TO).toBe('delegate_to');
    });
  });

  describe('forbidden long field names are NOT present', () => {
    const FORBIDDEN = [
      'observability_scope',
      'route_rationale_summary',
      'route_confidence',
      'selected_agent_group',
      'candidate_agents',
      'classification_id',
      'business_domain',
      'access_gate_result',
    ];

    test('none of the forbidden long names appear in BusinessTagKeys', () => {
      const keyValues = Object.values(BusinessTagKeys);
      for (const forbidden of FORBIDDEN) {
        expect(keyValues).not.toContain(forbidden);
      }
    });
  });

  describe('createBusinessTags emits span_scope and route_label', () => {
    test('createBusinessTags includes span_scope in output', () => {
      const tags = createBusinessTags({
        [BusinessTagKeys.SPAN_SCOPE]: SpanScope.BUSINESS,
      });
      expect(tags[BusinessTagKeys.SPAN_SCOPE]).toBe('business');
    });

    test('createBusinessTags includes route_label in output', () => {
      const tags = createBusinessTags({
        [BusinessTagKeys.ROUTE_LABEL]: RouteLabel.FRONTDESK,
      });
      expect(tags[BusinessTagKeys.ROUTE_LABEL]).toBe('frontdesk');
    });

    test('createBusinessTags includes both span_scope and route_label together', () => {
      const tags = createBusinessTags({
        [BusinessTagKeys.SPAN_SCOPE]: SpanScope.BUSINESS,
        [BusinessTagKeys.ROUTE_LABEL]: RouteLabel.WORKER,
        [BusinessTagKeys.ROUTE_REASON]: 'matched sales worker pattern',
        [BusinessTagKeys.ROUTE_SCORE]: 0.95,
        [BusinessTagKeys.SELECTED_AGENT]: 'frontlane-sales-worker',
      });
      expect(tags[BusinessTagKeys.SPAN_SCOPE]).toBe('business');
      expect(tags[BusinessTagKeys.ROUTE_LABEL]).toBe('worker');
      expect(tags[BusinessTagKeys.ROUTE_REASON]).toBe('matched sales worker pattern');
      expect(tags[BusinessTagKeys.ROUTE_SCORE]).toBe(0.95);
      expect(tags[BusinessTagKeys.SELECTED_AGENT]).toBe('frontlane-sales-worker');
    });

    test('createBusinessTags emits short keys only (no forbidden long names)', () => {
      const tags = createBusinessTags({
        [BusinessTagKeys.SPAN_SCOPE]: SpanScope.PLATFORM,
        [BusinessTagKeys.ROUTE_LABEL]: RouteLabel.FRONTDESK,
        [BusinessTagKeys.USED_ERP]: true,
        [BusinessTagKeys.CLASSIFY_ID]: 'cls-123',
        [BusinessTagKeys.BIZ_DOMAIN]: 'erp',
        [BusinessTagKeys.TURN_RESULT]: 'answered',
        [BusinessTagKeys.DELEGATE_TO]: 'frontlane-ops-worker',
      });
      const keys = Object.keys(tags);
      for (const key of keys) {
        const words = key.split('_').length;
        expect(words).toBeLessThanOrEqual(3);
      }
      expect(keys).not.toContain('observability_scope');
      expect(keys).not.toContain('route_rationale_summary');
      expect(keys).not.toContain('classification_id');
      expect(keys).not.toContain('business_domain');
    });
  });

  describe('applyBusinessTags writes metadata JSON with correct types on a real span', () => {
    test('applyBusinessTags writes span_scope as string value in metadata JSON', async () => {
      await withSpan('test.apply.business', undefined, async () => {
        const span = getActiveSpan();
        expect(span).toBeDefined();
        if (span) applyBusinessTags(span, { [BusinessTagKeys.SPAN_SCOPE]: SpanScope.BUSINESS });
      });

      const span = exporter.getFinishedSpans().find((s) => s.name === 'test.apply.business');
      expect(span).toBeDefined();
      const metaAttr = span?.attributes['metadata'];
      expect(metaAttr).toBeDefined();
      const meta = JSON.parse(String(metaAttr));
      expect(meta[BusinessTagKeys.SPAN_SCOPE]).toBe('business');
    });

    test('applyBusinessTags writes route_label as string value in metadata JSON', async () => {
      await withSpan('test.apply.route_label', undefined, async () => {
        const span = getActiveSpan();
        expect(span).toBeDefined();
        if (span) applyBusinessTags(span, { [BusinessTagKeys.ROUTE_LABEL]: RouteLabel.FRONTDESK });
      });

      const span = exporter.getFinishedSpans().find((s) => s.name === 'test.apply.route_label');
      expect(span).toBeDefined();
      const metaAttr = span?.attributes['metadata'];
      const meta = JSON.parse(String(metaAttr));
      expect(meta[BusinessTagKeys.ROUTE_LABEL]).toBe('frontdesk');
    });

    test('applyBusinessTags writes route_score as a number, not a string', async () => {
      await withSpan('test.apply.score', undefined, async () => {
        const span = getActiveSpan();
        expect(span).toBeDefined();
        if (span)
          applyBusinessTags(span, {
            [BusinessTagKeys.SPAN_SCOPE]: SpanScope.BUSINESS,
            [BusinessTagKeys.ROUTE_SCORE]: 0.95,
          });
      });

      const span = exporter.getFinishedSpans().find((s) => s.name === 'test.apply.score');
      expect(span).toBeDefined();
      const metaAttr = span?.attributes['metadata'];
      const meta = JSON.parse(String(metaAttr));
      expect(typeof meta[BusinessTagKeys.ROUTE_SCORE]).toBe('number');
      expect(meta[BusinessTagKeys.ROUTE_SCORE]).toBeCloseTo(0.95);
    });

    test('applyBusinessTags writes used_erp as a boolean, not a string', async () => {
      await withSpan('test.apply.used_erp', undefined, async () => {
        const span = getActiveSpan();
        expect(span).toBeDefined();
        if (span)
          applyBusinessTags(span, {
            [BusinessTagKeys.SPAN_SCOPE]: SpanScope.BUSINESS,
            [BusinessTagKeys.USED_ERP]: true,
          });
      });

      const span = exporter.getFinishedSpans().find((s) => s.name === 'test.apply.used_erp');
      expect(span).toBeDefined();
      const metaAttr = span?.attributes['metadata'];
      const meta = JSON.parse(String(metaAttr));
      expect(typeof meta[BusinessTagKeys.USED_ERP]).toBe('boolean');
      expect(meta[BusinessTagKeys.USED_ERP]).toBe(true);
    });

    test('metadata JSON contains span_scope, route_label, route_score (numeric), used_erp (boolean) together', async () => {
      await withSpan('test.apply.all_types', undefined, async () => {
        const span = getActiveSpan();
        expect(span).toBeDefined();
        if (span)
          applyBusinessTags(span, {
            [BusinessTagKeys.SPAN_SCOPE]: SpanScope.BUSINESS,
            [BusinessTagKeys.ROUTE_LABEL]: RouteLabel.WORKER,
            [BusinessTagKeys.ROUTE_SCORE]: 0.87,
            [BusinessTagKeys.USED_ERP]: false,
            [BusinessTagKeys.ROUTE_REASON]: 'matched ops worker pattern',
          });
      });

      const span = exporter.getFinishedSpans().find((s) => s.name === 'test.apply.all_types');
      expect(span).toBeDefined();
      const metaAttr = span?.attributes['metadata'];
      const meta = JSON.parse(String(metaAttr));
      expect(meta[BusinessTagKeys.SPAN_SCOPE]).toBe('business');
      expect(meta[BusinessTagKeys.ROUTE_LABEL]).toBe('worker');
      expect(typeof meta[BusinessTagKeys.ROUTE_SCORE]).toBe('number');
      expect(meta[BusinessTagKeys.ROUTE_SCORE]).toBeCloseTo(0.87);
      expect(typeof meta[BusinessTagKeys.USED_ERP]).toBe('boolean');
      expect(meta[BusinessTagKeys.USED_ERP]).toBe(false);
      expect(meta[BusinessTagKeys.ROUTE_REASON]).toBe('matched ops worker pattern');
    });
  });
});
