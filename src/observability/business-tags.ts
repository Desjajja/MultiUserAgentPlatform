/**
 * Business tag taxonomy for MUAP observability.
 *
 * Business dimensions are written into the OpenInference `metadata` namespace
 * (a single `metadata` JSON-string attribute per span), NOT flat `muap.*` keys.
 * Phoenix's graphical filter UI treats `metadata` as a first-class filter field
 * (`metadata["route_type"] == "frontdesk"`), whereas raw `attributes` are not
 * UI-filterable. See ADR-0017 and docs/observability-business-tags.md v1.3.
 *
 * On the host we encode via `@arizeai/openinference-core`'s
 * `getMetadataAttributes(record)` which produces `{ metadata: JSON.stringify(record) }`.
 * The call-site API (`applyBusinessTags(span, { [BusinessTagKeys.X]: ... })`) is
 * intentionally unchanged so existing emitters need no edits.
 */
import { getMetadataAttributes } from '@arizeai/openinference-core';
import type { Span } from '@opentelemetry/api';

/**
 * Span scope taxonomy for business-first tracing.
 * - business: content-bearing interaction roots (interaction.*)
 * - tool: MCP/LLM tool spans (mcp.*, erp.call)
 * - platform: runtime/platform lifecycle spans (platform.*)
 * - routing: internal routing diagnostic spans (no user-visible content)
 */
export const SpanScope = {
  BUSINESS: 'business',
  TOOL: 'tool',
  PLATFORM: 'platform',
  ROUTING: 'routing',
} as const;

export type SpanScope = typeof SpanScope[keyof typeof SpanScope];

/**
 * Route label for interaction root spans.
 * Determines which canonical root name is used: interaction.frontdesk | interaction.worker | interaction.erp
 */
export const RouteLabel = {
  FRONTDESK: 'frontdesk',
  WORKER: 'worker',
  ERP: 'erp',
} as const;

export type RouteLabel = typeof RouteLabel[keyof typeof RouteLabel];

export const BusinessTagKeys = {
  // --- legacy keys (retained for compatibility with existing callers) ---
  LAYER: 'layer',
  ROUTE_TYPE: 'route_type',
  LANE: 'lane',
  CHANNEL: 'channel',
  INTENT: 'intent',
  AGENT_GROUP: 'agent_group',
  SESSION_MODE: 'session_mode',
  ENGAGE_MODE: 'engage_mode',
  PROVIDER: 'provider',

  // --- Task 1 approved short keys ---
  SPAN_SCOPE: 'span_scope',
  ROUTE_LABEL: 'route_label',
  ENTRYPOINT: 'entrypoint',
  BIZ_DOMAIN: 'biz_domain',
  USED_ERP: 'used_erp',
  CLASSIFY_ID: 'classify_id',
  ROUTE_REASON: 'route_reason',
  ROUTE_SCORE: 'route_score',
  SELECTED_AGENT: 'selected_agent',
  AGENT_OPTIONS: 'agent_options',
  ACCESS_RESULT: 'access_result',
  TOOL_GROUP: 'tool_group',
  ERP_OP: 'erp_op',
  TURN_RESULT: 'turn_result',
  DELEGATE_TO: 'delegate_to',
  SESSION_ID: 'session_id',
} as const;

export type BusinessTagKey = typeof BusinessTagKeys[keyof typeof BusinessTagKeys];

/**
 * Route type taxonomy. `a2a` is NOT a route type — agent-to-agent delegation is
 * expressed via `engage_mode='a2a'`. `erp` is reserved (no runtime emitter yet).
 */
export const RouteType = {
  FRONTDESK: 'frontdesk',
  WORKER: 'worker',
  ERP: 'erp',
  SYSTEM: 'system',
} as const;

export type RouteType = typeof RouteType[keyof typeof RouteType];

export const Lane = {
  FRONTDESK: 'frontdesk',
  WORKER: 'worker',
} as const;

export type Lane = typeof Lane[keyof typeof Lane];

export const Intent = {
  CHAT: 'chat',
  APPROVAL: 'approval',
  EXECUTE: 'execute',
  SYSTEM: 'system',
} as const;

export type Intent = typeof Intent[keyof typeof Intent];

export interface BusinessTags {
  // --- legacy keys ---
  [BusinessTagKeys.LAYER]: 'ai' | 'platform';
  [BusinessTagKeys.ROUTE_TYPE]?: RouteType;
  [BusinessTagKeys.LANE]?: Lane;
  [BusinessTagKeys.CHANNEL]?: string;
  [BusinessTagKeys.INTENT]?: Intent;
  [BusinessTagKeys.AGENT_GROUP]?: string;
  [BusinessTagKeys.SESSION_MODE]?: string;
  [BusinessTagKeys.ENGAGE_MODE]?: 'direct' | 'a2a';
  [BusinessTagKeys.PROVIDER]?: string;

  // --- Task 1 approved short keys ---
  [BusinessTagKeys.SPAN_SCOPE]?: SpanScope;
  [BusinessTagKeys.ROUTE_LABEL]?: RouteLabel;
  [BusinessTagKeys.ENTRYPOINT]?: string;
  [BusinessTagKeys.BIZ_DOMAIN]?: string;
  [BusinessTagKeys.USED_ERP]?: boolean;
  [BusinessTagKeys.CLASSIFY_ID]?: string;
  [BusinessTagKeys.ROUTE_REASON]?: string;
  [BusinessTagKeys.ROUTE_SCORE]?: number;
  [BusinessTagKeys.SELECTED_AGENT]?: string;
  [BusinessTagKeys.AGENT_OPTIONS]?: string;
  [BusinessTagKeys.ACCESS_RESULT]?: string;
  [BusinessTagKeys.TOOL_GROUP]?: string;
  [BusinessTagKeys.ERP_OP]?: string;
  [BusinessTagKeys.TURN_RESULT]?: string;
  [BusinessTagKeys.DELEGATE_TO]?: string;
  [BusinessTagKeys.SESSION_ID]?: string;
}

/**
 * Derive the lane/route type from an agent group's folder name.
 *
 * Shared by host span tagging and the env value injected into containers so the
 * host span and the container's `agent.turn` span agree per session. Folders
 * ending in `-frontdesk` are the frontdesk lane; everything else is a worker.
 * Returns `Lane` (a subset of `RouteType`): folder derivation never yields
 * `erp`/`system` — `erp` is an explicit future override, never inferred here.
 */
export function deriveRouteType(folder: string): Lane {
  return folder.endsWith('-frontdesk') ? Lane.FRONTDESK : Lane.WORKER;
}

/**
 * Derive the RouteLabel from an agent group's folder name.
 * Uses the same `-frontdesk` suffix rule as deriveRouteType but returns the
 * business-first RouteLabel enum instead of Lane.
 */
export function deriveRouteLabel(folder: string): RouteLabel {
  return folder.endsWith('-frontdesk') ? RouteLabel.FRONTDESK : RouteLabel.WORKER;
}

/**
 * Build the canonical interaction span name from a RouteLabel.
 * e.g. RouteLabel.FRONTDESK -> 'interaction.frontdesk'
 */
export function interactionSpanName(label: RouteLabel): string {
  return `interaction.${label}`;
}

// Allowlist for platform component names — prevents arbitrary strings in span names
const VALID_PLATFORM_COMPONENTS = new Set(['delivery', 'container', 'channel', 'router', 'agent']);

// Allowlist for platform action names — prevents arbitrary strings in span names
const VALID_PLATFORM_ACTIONS = new Set([
  'wake', 'spawn', 'kill', 'drain', 'message', 'send', 'receive', 'turn', 'drop', 'deny',
]);

/**
 * Build a platform span name from component and action after validating both
 * against local allowlists.
 * e.g. ('delivery', 'drain') -> 'platform.delivery.drain'
 * @throws Error if component or action is not in the allowlist
 */
export function platformSpanName(component: string, action: string): string {
  if (!VALID_PLATFORM_COMPONENTS.has(component)) {
    throw new Error(`Unknown platform component: ${component}`);
  }
  if (!VALID_PLATFORM_ACTIONS.has(action)) {
    throw new Error(`Unknown platform action: ${action}`);
  }
  return `platform.${component}.${action}`;
}

export function createBusinessTags(tags: Partial<BusinessTags>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(tags)) {
    if (value !== undefined && value !== null && value !== '') {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Per-span accumulator of business-tag metadata.
 *
 * `metadata` is a SINGLE JSON-string attribute, so a naive
 * `span.setAttributes(getMetadataAttributes(tags))` on a span that was already
 * tagged would CLOBBER the prior `metadata` value. The router's
 * `router.deliver_to_agent` span is tagged twice (initial routing tags, then
 * session-derived tags after `resolveSession`), so we read-merge-rewrite via a
 * WeakMap keyed by span. Entries are GC'd with their span — no manual cleanup.
 */
const spanMetadataAccumulator = new WeakMap<object, Record<string, unknown>>();

/**
 * Apply business tags to an OpenTelemetry span by merging into its single
 * `metadata` JSON attribute. Repeated calls on the same span union their tags
 * (later keys win on conflict) rather than overwriting.
 */
export function applyBusinessTags(span: Span | null | undefined, tags: Partial<BusinessTags>): void {
  if (!span) return;
  const incoming = createBusinessTags(tags);
  if (Object.keys(incoming).length === 0) return;

  const merged = { ...(spanMetadataAccumulator.get(span) ?? {}), ...incoming };
  spanMetadataAccumulator.set(span, merged);

  span.setAttributes(getMetadataAttributes(merged));
}
