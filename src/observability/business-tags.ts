/**
 * Business tag taxonomy for MUAP observability.
 *
 * Provides the `muap.*` attribute namespace used to filter traces by business
 * dimensions in Arize Phoenix.
 */

export const BusinessTagKeys = {
  LAYER: 'muap.layer',
  ROUTE_TYPE: 'muap.route_type',
  LANE: 'muap.lane',
  CHANNEL: 'muap.channel',
  INTENT: 'muap.intent',
  AGENT_GROUP: 'muap.agent_group',
  SESSION_MODE: 'muap.session_mode',
  ENGAGE_MODE: 'muap.engage_mode',
  PROVIDER: 'muap.provider',
} as const;

export type BusinessTagKey = typeof BusinessTagKeys[keyof typeof BusinessTagKeys];

export const RouteType = {
  FRONTDESK: 'frontdesk',
  WORKER: 'worker',
  A2A: 'a2a',
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
  [BusinessTagKeys.LAYER]: 'ai' | 'platform';
  [BusinessTagKeys.ROUTE_TYPE]?: RouteType;
  [BusinessTagKeys.LANE]?: Lane;
  [BusinessTagKeys.CHANNEL]?: string;
  [BusinessTagKeys.INTENT]?: Intent;
  [BusinessTagKeys.AGENT_GROUP]?: string;
  [BusinessTagKeys.SESSION_MODE]?: string;
  [BusinessTagKeys.ENGAGE_MODE]?: 'direct' | 'a2a';
  [BusinessTagKeys.PROVIDER]?: string;
}

/** Convert a BusinessTags partial into a plain string→string record. */
export function createBusinessTags(tags: Partial<BusinessTags>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(tags)) {
    if (value !== undefined && value !== null && value !== '') {
      result[key] = String(value);
    }
  }
  return result;
}

/** Apply business tags to an OpenTelemetry span. */
export function applyBusinessTags(span: { setAttribute(key: string, value: string): void } | null | undefined, tags: Partial<BusinessTags>): void {
  if (!span) return;
  const attrs = createBusinessTags(tags);
  for (const [key, value] of Object.entries(attrs)) {
    span.setAttribute(key, value);
  }
}
