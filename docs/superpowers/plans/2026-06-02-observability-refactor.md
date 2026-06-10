# MUAP Observability Refactor — AI Semantic vs Platform Telemetry Separation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separate AI semantic spans (AGENT/LLM/TOOL/PROMPT) from platform telemetry spans (routing/delivery/container lifecycle), implement missing container-side `agent.turn` span, and establish formal business tag taxonomy for route-type filtering in Phoenix.

**Architecture:** 
- **Layer A (AI Semantic)**: OpenInference-compliant spans — `router.deliver_to_agent` (AGENT), `agent.turn` (CHAIN, container-side), LiteLLM auto-spans (LLM/TOOL) — for model analytics, prompt debugging, tool usage analysis.
- **Layer B (Platform Telemetry)**: Standard OTel spans — channel receive, router route, container wake/spawn/kill, delivery drain/send — for platform engineering, latency debugging, container lifecycle observability. These keep `CHAIN` kind but are marked with `muap.layer = 'platform'`.
- **Business Tags**: Formal `muap.*` taxonomy — `route_type`, `lane`, `channel`, `intent`, `agent_group`, `session_mode`, `engage_mode` — for filtering traces by business dimension in Phoenix UI.

**Tech Stack:** TypeScript, OpenTelemetry SDK, OpenInference semantic conventions, Arize Phoenix, Bun (container-side), pnpm (host-side)

---

## File Structure

### New Files
- `src/observability/business-tags.ts` — Business tag taxonomy constants + type definitions
- `src/observability/platform-telemetry.ts` — Platform span attribute helpers (distinguishes from AI semantic)
- `container/agent-runner/src/observability/turn-span.ts` — Container-side `agent.turn` span creation
- `docs/observability-business-tags.md` — Business tag schema reference (LLM-facing)
- `docs/observability-business-tags.html` — Human-readable business tag documentation

### Modified Files
- `src/observability/openinference.ts` — Add `safeAttributeText` import, fix `rootInputAttrs` empty sessionId bug
- `src/router.ts` — Use business tag helpers, fix sessionId initialization, add route_type/lane/channel tags
- `src/delivery.ts` — Mark platform spans with `muap.layer = 'platform'`, preserve output attrs
- `src/container-runner.ts` — Mark container spans with `muap.layer = 'platform'`
- `src/channels/cli.ts` — Mark channel spans with `muap.layer = 'platform'`
- `src/channels/feishu.ts` — Mark channel spans with `muap.layer = 'platform'`
- `container/agent-runner/src/poll-loop.ts` — Wrap `processQuery` with `agent.turn` span
- `container/agent-runner/src/index.ts` — Import and initialize turn-span module
- `docs/observability-span-schema.md` — Update to v1.2: document layer separation, business tags, agent.turn

---

## Task Breakdown

### Task 1: Design Business Tag Taxonomy

**Files:**
- Create: `src/observability/business-tags.ts`
- Test: `src/observability/business-tags.test.ts` (if test infra exists, else skip and test via integration)

**Step 1: Define business tag constants and types**

```typescript
// src/observability/business-tags.ts
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

export function createBusinessTags(tags: Partial<BusinessTags>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(tags)) {
    if (value !== undefined && value !== null && value !== '') {
      result[key] = String(value);
    }
  }
  return result;
}

export function applyBusinessTags(span: any, tags: Partial<BusinessTags>): void {
  const attrs = createBusinessTags(tags);
  for (const [key, value] of Object.entries(attrs)) {
    span.setAttribute(key, value);
  }
}
```

**Step 2: Verify no compilation errors**

Run: `pnpm typecheck`
Expected: PASS (no errors from new file)

**Step 3: Commit**

```bash
git add src/observability/business-tags.ts
git commit -m "feat(obs): define business tag taxonomy constants and types"
```

---

### Task 2: Fix router.deliver_to_agent Empty sessionId Bug

**Files:**
- Modify: `src/observability/openinference.ts:104-118`
- Modify: `src/router.ts:505-531`

**Step 1: Fix rootInputAttrs to not emit empty session.id**

```typescript
// src/observability/openinference.ts
export function rootInputAttrs(params: {
  sessionId: string;
  userId: string;
  inputValue: string;
  inputMimeType?: string;
}): Record<string, AttributeValue> {
  const attrs: Record<string, AttributeValue> = {
    ...agentAttrs(),
    'user.id': params.userId,
    'input.value': safeAttributeText(params.inputValue),
    'input.mime_type': params.inputMimeType ?? 'text/plain',
  };
  
  // Only set session.id if it's a non-empty string
  if (params.sessionId && params.sessionId !== '') {
    attrs['session.id'] = params.sessionId;
  }
  
  return attrs;
}
```

**Step 2: Update router.deliver_to_agent to pass real sessionId**

```typescript
// src/router.ts:505-507
// BEFORE (bug):
// const rootAttrs = rootInputAttrs({ sessionId: '', userId, inputValue });

// AFTER (fix):
// We'll set session.id lazily after session resolution, so don't pass it initially
const rootAttrs = rootInputAttrs({ 
  sessionId: session.id,  // session is already resolved by this point
  userId, 
  inputValue 
});
```

**Step 3: Verify router.ts still compiles**

Run: `pnpm typecheck`
Expected: PASS

**Step 4: Commit**

```bash
git add src/observability/openinference.ts src/router.ts
git commit -m "fix(obs): prevent empty session.id in root span attrs"
```

---

### Task 3: Mark Platform Spans with Business Tags

**Files:**
- Modify: `src/channels/cli.ts`
- Modify: `src/channels/feishu.ts`
- Modify: `src/router.ts`
- Modify: `src/container-runner.ts`
- Modify: `src/delivery.ts`

**Step 1: Update channel spans**

```typescript
// src/channels/cli.ts:185
import { applyBusinessTags } from '../observability/business-tags.js';

// In the withSpan callback:
applyBusinessTags(getActiveSpan(), {
  [BusinessTagKeys.LAYER]: 'platform',
  [BusinessTagKeys.CHANNEL]: 'cli',
});
```

```typescript
// src/channels/feishu.ts:426
import { applyBusinessTags } from '../observability/business-tags.js';

// In the withSpan callback:
applyBusinessTags(getActiveSpan(), {
  [BusinessTagKeys.LAYER]: 'platform',
  [BusinessTagKeys.CHANNEL]: 'feishu',
});
```

**Step 2: Update router spans**

```typescript
// src/router.ts:174 (router.route)
applyBusinessTags(getActiveSpan(), {
  [BusinessTagKeys.LAYER]: 'platform',
  [BusinessTagKeys.ROUTE_TYPE]: 'frontdesk',
});

// src/router.ts:505 (router.deliver_to_agent)
applyBusinessTags(getActiveSpan(), {
  [BusinessTagKeys.LAYER]: 'ai',
  [BusinessTagKeys.ROUTE_TYPE]: 'frontdesk',
  [BusinessTagKeys.LANE]: 'frontdesk',
  [BusinessTagKeys.CHANNEL]: event.channelType,
  [BusinessTagKeys.INTENT]: Intent.CHAT,
  [BusinessTagKeys.AGENT_GROUP]: agentGroup.name,
  [BusinessTagKeys.SESSION_MODE]: effectiveSessionMode,
  [BusinessTagKeys.ENGAGE_MODE]: (session.spawn_depth ?? 0) > 0 ? 'a2a' : 'direct',
});
```

**Step 3: Update container spans**

```typescript
// src/container-runner.ts:115 (container.wake)
applyBusinessTags(getActiveSpan(), {
  [BusinessTagKeys.LAYER]: 'platform',
  [BusinessTagKeys.ROUTE_TYPE]: 'worker',
});

// src/container-runner.ts:160 (container.spawn)
applyBusinessTags(getActiveSpan(), {
  [BusinessTagKeys.LAYER]: 'platform',
  [BusinessTagKeys.ROUTE_TYPE]: 'worker',
  [BusinessTagKeys.PROVIDER]: provider,
});
```

**Step 4: Update delivery spans**

```typescript
// src/delivery.ts:281 (delivery.session.drain)
applyBusinessTags(getActiveSpan(), {
  [BusinessTagKeys.LAYER]: 'platform',
  [BusinessTagKeys.ROUTE_TYPE]: 'worker',
});

// src/delivery.ts:315 (delivery.message.deliver)
applyBusinessTags(getActiveSpan(), {
  [BusinessTagKeys.LAYER]: 'platform',
  [BusinessTagKeys.ROUTE_TYPE]: 'worker',
});

// src/delivery.ts:466 (delivery.channel.send)
applyBusinessTags(getActiveSpan(), {
  [BusinessTagKeys.LAYER]: 'platform',
  [BusinessTagKeys.ROUTE_TYPE]: 'worker',
});
```

**Step 5: Verify compilation**

Run: `pnpm typecheck`
Expected: PASS

**Step 6: Commit**

```bash
git add src/channels/cli.ts src/channels/feishu.ts src/router.ts src/container-runner.ts src/delivery.ts
-git commit -m "feat(obs): mark all platform spans with muap.layer='platform' and business tags"
```

---

### Task 4: Implement Container-Side agent.turn Span

**Files:**
- Create: `container/agent-runner/src/observability/turn-span.ts`
- Modify: `container/agent-runner/src/poll-loop.ts`
- Modify: `container/agent-runner/src/index.ts`

**Step 1: Create turn-span module**

```typescript
// container/agent-runner/src/observability/turn-span.ts
import { trace, context } from '@opentelemetry/api';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

export interface TurnSpanOptions {
  sessionId: string;
  agentGroupId: string;
  provider: string;
  turnIndex?: number;
}

export function createTurnSpanName(options: TurnSpanOptions): string {
  return `agent.turn${options.turnIndex !== undefined ? `-${options.turnIndex}` : ''}`;
}

export function createTurnSpanAttributes(options: TurnSpanOptions): Record<string, string> {
  const attrs: Record<string, string> = {
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

/**
 * Wraps a function with an agent.turn span.
 * This is the container-side semantic span that wraps the LLM call + tool execution cycle.
 */
export async function withAgentTurn<T>(
  options: TurnSpanOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const tracer = trace.getTracer('agent-runner');
  const spanName = createTurnSpanName(options);
  const attrs = createTurnSpanAttributes(options);
  
  return tracer.startActiveSpan(spanName, { attributes: attrs }, async (span) => {
    try {
      const result = await fn();
      span.setStatus({ code: 0 }); // OK
      return result;
    } catch (error) {
      span.setStatus({ code: 2, message: error instanceof Error ? error.message : String(error) }); // ERROR
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      span.end();
    }
  });
}
```

**Step 2: Update poll-loop to wrap processQuery with agent.turn**

```typescript
// container/agent-runner/src/poll-loop.ts
import { withAgentTurn } from './observability/turn-span.js';

// In the main poll loop, where processQuery is called:
// BEFORE:
// await processQuery(provider, config, db, outboundDb, groupDir, resolveIdleExitMs());

// AFTER:
const turnIndex = 0; // Or increment per turn
await withAgentTurn(
  {
    sessionId: config.sessionId,
    agentGroupId: config.agentGroupId,
    provider: config.provider,
    turnIndex,
  },
  async () => {
    await processQuery(provider, config, db, outboundDb, groupDir, resolveIdleExitMs());
  },
);
```

**Step 3: Verify container-side compilation**

Run: `cd container/agent-runner && bun run typecheck` (or equivalent)
Expected: PASS

**Step 4: Commit**

```bash
git add container/agent-runner/src/observability/turn-span.ts container/agent-runner/src/poll-loop.ts container/agent-runner/src/index.ts
git commit -m "feat(obs): implement container-side agent.turn span"
```

---

### Task 5: Update Observability Schema Documentation

**Files:**
- Modify: `docs/observability-span-schema.md`
- Modify: `docs/observability-instrumentation-methodology.md`

**Step 1: Update schema doc to v1.2**

Add new sections:
- §10: Layer Separation (AI Semantic vs Platform Telemetry)
- §11: Business Tag Taxonomy (muap.* registry)
- §12: Container-Side agent.turn Span

**Step 2: Update methodology doc**

Add:
- How to decide which layer a span belongs to
- How to apply business tags
- Examples of filtering in Phoenix UI

**Step 3: Commit**

```bash
git add docs/observability-span-schema.md docs/observability-instrumentation-methodology.md
git commit -m "docs(obs): update schema to v1.2 with layer separation and business tags"
```

---

### Task 6: Generate Human-Readable HTML Documentation

**Files:**
- Create: `docs/observability-business-tags.md` (source)
- Create: `docs/observability-business-tags.html` (generated)

**Step 1: Write markdown source**

```markdown
# MUAP Business Tag Schema

## Purpose

Business tags enable filtering traces by business dimensions in Arize Phoenix.

## Tag Registry

| Tag | Key | Values | Set On |
|---|---|---|---|
| Layer | `muap.layer` | `ai`, `platform` | All spans |
| Route Type | `muap.route_type` | `frontdesk`, `worker`, `a2a`, `system` | All spans |
| Lane | `muap.lane` | `frontdesk`, `worker` | Routing spans |
| Channel | `muap.channel` | `cli`, `feishu`, `webhook` | Ingress spans |
| Intent | `muap.intent` | `chat`, `approval`, `execute`, `system` | Agent spans |
| Agent Group | `muap.agent_group` | Any string | Agent spans |
| Session Mode | `muap.session_mode` | Any string | Agent spans |
| Engage Mode | `muap.engage_mode` | `direct`, `a2a` | Agent spans |
| Provider | `muap.provider` | `claude`, `openai`, `sdk-openai` | Container spans |

## Layer Separation

### AI Semantic Layer
Spans that represent AI application logic:
- `router.deliver_to_agent` (AGENT) — user turn
- `agent.turn` (CHAIN) — container-side turn processing
- LiteLLM auto-spans (LLM, TOOL, etc.) — model/tool calls

### Platform Telemetry Layer
Spans that represent infrastructure:
- `channel.*.receive` — ingress
- `router.route` — routing
- `container.wake/spawn/kill` — container lifecycle
- `delivery.session.drain/message.deliver/channel.send` — message delivery

## Phoenix Filtering

### UI Filter Bar (Spans tab)
```
attributes["muap.route_type"].as_string() == "frontdesk"
attributes["muap.layer"].as_string() == "ai"
```

### REST API
```
GET /v1/spans?attribute=muap.route_type:frontdesk&attribute=muap.layer:ai
```
```

**Step 2: Generate HTML from markdown**

Use a markdown-to-HTML converter or write HTML directly.

**Step 3: Commit**

```bash
git add docs/observability-business-tags.md docs/observability-business-tags.html
git commit -m "docs(obs): add human-readable business tag schema documentation"
```

---

## Test Plan

### Objective
Verify that:
1. All platform spans have `muap.layer = 'platform'`
2. All AI semantic spans have `muap.layer = 'ai'`
3. `agent.turn` span exists in container-side traces
4. Business tags appear in Phoenix and are filterable
5. No empty `session.id` attributes are emitted

### Test Cases

**TC1: Compile-Time Verification**
- Run: `pnpm typecheck`
- Expected: PASS, no errors

**TC2: Container Build**
- Run: `pnpm container:build`
- Expected: PASS, image builds successfully

**TC3: End-to-End Trace Verification**
- Run: `pnpm dev` + `pnpm chat "test business tags"`
- Wait for trace to appear in Phoenix
- Verify in Phoenix DB:
  ```sql
  SELECT name, span_kind, attributes->'muap' FROM spans WHERE name = 'router.deliver_to_agent';
  ```
- Expected: `muap.layer = 'ai'`, `muap.route_type = 'frontdesk'`, etc.

**TC4: Platform Span Verification**
- Query: `SELECT name, attributes->'muap' FROM spans WHERE name LIKE 'container.%';`
- Expected: All have `muap.layer = 'platform'`

**TC5: Filter Syntax Verification**
- In Phoenix UI Spans tab, filter: `attributes["muap.layer"].as_string() == "ai"`
- Expected: Returns `router.deliver_to_agent` and `agent.turn` spans

**TC6: Empty sessionId Bug Fix**
- Query: `SELECT name, attributes->'session.id' FROM spans WHERE name = 'router.deliver_to_agent';`
- Expected: `session.id` is a real UUID, never empty string

### Success Criteria
- ALL test cases pass
- Phoenix traces show clean layer separation
- No `CHAIN` spans incorrectly labeled as AI semantic

---

## Execution Options

**1. Subagent-Driven (recommended)**
Dispatch fresh subagent per task, review between tasks.

**2. Inline Execution**
Execute tasks in this session, batch execution with checkpoints.

**Which approach do you prefer?**
