/**
 * Classification-log delivery-action handler.
 *
 * Frontdesk's `classify_intent` MCP tool emits a system outbound with
 * `action='classify_intent'`. We persist it into the classification_log
 * table so you can:
 *
 *   - see what frontdesk is routing (and why)
 *   - build a regression test corpus of real user messages + the
 *     classifier's decision
 *   - correlate downstream worker failures back to the intent
 *
 * Best-effort writes (same pattern as erp_audit): a DB failure logs and
 * drops — don't block the container's message flow on metric bookkeeping.
 */
import { registerDeliveryAction } from '../../delivery.js';
import { recordClassification, type ClassificationLogEntry } from '../../db/classification-log.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';

const ACTIONS: ReadonlyArray<ClassificationLogEntry['action']> = ['delegate', 'clarify', 'reject', 'answer_self'];

function readString(content: Record<string, unknown>, key: string): string | undefined {
  const value = content[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readNumber(content: Record<string, unknown>, key: string): number | undefined {
  const value = content[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readStringArray(content: Record<string, unknown>, key: string): string[] | undefined {
  const value = content[key];
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((v): v is string => typeof v === 'string');
  return out.length > 0 ? out : undefined;
}

function toAction(raw: unknown): ClassificationLogEntry['action'] {
  return typeof raw === 'string' && (ACTIONS as readonly string[]).includes(raw)
    ? (raw as ClassificationLogEntry['action'])
    : 'delegate';
}

async function handleClassifyIntent(content: Record<string, unknown>, session: Session): Promise<void> {
  const action = toAction(content.action_taken);

  const entry: ClassificationLogEntry = {
    sessionId: session.id,
    agentGroupId: session.agent_group_id,
    userId: readString(content, 'userId') ?? null,
    userMessage: readString(content, 'userMessage') ?? null,
    recommendedWorker: readString(content, 'recommendedWorker') ?? null,
    confidence: readNumber(content, 'confidence') ?? null,
    candidates: readStringArray(content, 'candidates') ?? null,
    reasoning: readString(content, 'reasoning') ?? null,
    action,
    outcomeRef: readString(content, 'outcomeRef') ?? null,
  };

  try {
    recordClassification(entry);
  } catch (err) {
    log.error('classification_log write failed', { sessionId: session.id, err });
  }
}

registerDeliveryAction('classify_intent', handleClassifyIntent);
