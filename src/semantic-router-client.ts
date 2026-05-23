/**
 * Semantic router client — Phase 1 (Hint) + Phase E (short-circuit).
 *
 * Called by router.ts before persisting an inbound message. Depending on
 * the router result, the client returns one of three things:
 *
 *   - `RouterHint` (worker dispatch hint) — message gets a `<router-hint>`
 *     tag prepended; frontdesk LLM still handles routing, just faster.
 *   - `RouterShortCircuit` (template reply) — host writes a fixed reply
 *     directly to outbound.db, skipping frontdesk LLM entirely.
 *   - `null` — no action; original flow applies.
 *
 * Four hard constraints (do not relax without re-running the cache-friendliness
 * regression test in bench/results/):
 *   1. timeout 200ms — never block message ingestion
 *   2. matched_skill === '_main_self' (legacy fallback) → return null
 *      (NOT a worker; LLM handles, e.g. for "现在几点" type queries that need
 *      dynamic content)
 *   3. hint text contains a coarse tier ('high'|'med'), never a raw confidence
 *      float (would change every turn and bust the prompt prefix cache)
 *   4. caller MUST `await` this; callers that fire-and-forget defeat the
 *      purpose
 *
 * Phase E additions:
 *   5. Short-circuit only for _XXX-prefixed labels that map to fixed
 *      templates (no dynamic content). Confidence must be ≥ 0.95.
 */

const DEFAULT_URL = 'http://127.0.0.1:7103/route';
const TIMEOUT_MS = 200;
const TIER_HIGH_THRESHOLD = 0.85;
const TIER_MED_THRESHOLD = 0.75;
const SHORT_CIRCUIT_THRESHOLD = 0.95;

export type HintTier = 'high' | 'med';

export interface RouterHint {
  kind: 'hint';
  /** Nano worker short-name; guaranteed not to be `_main_self`. */
  worker: string;
  /** Coarse bucket only — never expose raw float in the hint text. */
  tier: HintTier;
  /** Raw confidence value for logging / analysis only. */
  rawConfidence: number;
  /** Top-K matches for debug logging. */
  topK: Array<[string, number]>;
}

/**
 * Short-circuit: router matched a fixed-template intent (e.g. `_greeting`)
 * with high confidence. The host writes a templated reply directly to
 * outbound.db, skipping the frontdesk LLM entirely.
 */
export interface RouterShortCircuit {
  kind: 'short_circuit';
  /** Intent label, e.g. `_greeting` / `_ack` / `_self_intro` / `_ppe_ok`. */
  intent: string;
  /** Pre-rendered reply text to write to outbound.db. */
  replyText: string;
  /** Raw confidence for logging. */
  rawConfidence: number;
}

export type RouterDecision = RouterHint | RouterShortCircuit;

interface RouteResponse {
  matched_skill?: string | null;
  confidence?: number;
  is_unambiguous?: boolean;
  top_3?: Array<[string, number]>;
}

function tierFor(confidence: number): HintTier | null {
  if (confidence >= TIER_HIGH_THRESHOLD) return 'high';
  if (confidence >= TIER_MED_THRESHOLD) return 'med';
  return null;
}

/**
 * Pre-defined templates for `_XXX`-prefixed intents. Each maps to a static
 * reply string. Adding a new template:
 *   1. Add utterances under that intent label in nano-utterances.yaml
 *   2. Rebuild index-nano.pkl
 *   3. Add entry here
 *   4. Update build_nano_index.sh allowed-labels set
 */
const SHORT_CIRCUIT_TEMPLATES: Record<string, string> = {
  _greeting: '你好，我是 FrontLane Desk，企业 ERP 助手的前台。有什么需要帮助的？',
  _ack: '收到。',
  _self_intro:
    '我是 FrontLane Desk，企业 ERP 助手的前台调度。我会把你的请求转给对应的 worker：知识查询、机器人控制、实验记录、远程桌面、飞书操作等。你直接说需求即可。',
  _ppe_ok: '收到，PPE 状态已记录。',
};

/**
 * Query semantic router for routing decision. Returns:
 *   - RouterShortCircuit if a fixed-template intent hit with conf ≥ 0.95
 *   - RouterHint if a worker hit with conf ≥ 0.75
 *   - null otherwise (router unreachable, ambiguous, low confidence,
 *     `_main_self` fallback)
 */
export async function tryRoute(userMessage: string): Promise<RouterDecision | null> {
  const url = process.env.SEMANTIC_ROUTER_URL || DEFAULT_URL;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user_message: userMessage }),
      signal: controller.signal,
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as RouteResponse;

    const skill = data.matched_skill;
    if (!skill || data.is_unambiguous === false) return null;
    const conf = typeof data.confidence === 'number' ? data.confidence : 0;

    // Short-circuit path: _XXX-prefixed intent with a known template + high conf.
    // Constraint #5: only act on _ prefixed labels that have a template defined.
    if (skill.startsWith('_') && skill !== '_main_self') {
      const template = SHORT_CIRCUIT_TEMPLATES[skill];
      if (template && conf >= SHORT_CIRCUIT_THRESHOLD) {
        return {
          kind: 'short_circuit',
          intent: skill,
          replyText: template,
          rawConfidence: conf,
        };
      }
      // _XXX matched but below short-circuit threshold OR no template — fall
      // through to LLM (no hint, no short-circuit).
      return null;
    }

    // Constraint #2: `_main_self` (legacy) → LLM handles (dynamic content).
    if (skill === '_main_self') return null;

    // Hint path: a real worker name.
    const tier = tierFor(conf);
    if (!tier) return null;

    return {
      kind: 'hint',
      worker: skill,
      tier,
      rawConfidence: conf,
      topK: Array.isArray(data.top_3) ? data.top_3 : [],
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build the hint tag to prepend to user message content.
 *
 * Constraint #3: tag is byte-identical across turns with the same (worker,
 * tier) — no float, no timestamp, no varying nonce. Same tuple → same bytes →
 * prefix cache hits.
 */
export function buildHintTag(hint: RouterHint): string {
  return `<router-hint worker="${hint.worker}" tier="${hint.tier}"/>\n`;
}
