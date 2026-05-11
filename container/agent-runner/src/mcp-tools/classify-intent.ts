/**
 * classify_intent — frontdesk-side intent classifier.
 *
 * Philosophy: classification is an explicit, observable step. Without
 * this tool, frontdesk classifies silently in its head and the host has
 * no way to see what it decided or why. With it, every routing decision
 * is a structured record: recommended worker, confidence, candidates
 * considered, reasoning, and the action taken (delegate / clarify /
 * reject / answer_self).
 *
 * The tool is NOT the router. It emits a classification event; the
 * agent still has to decide what to actually do next (call
 * send_message to the worker, or ask_user_question, or reply directly).
 * Keeping these as two separate steps is the whole point — you can
 * audit and A/B-test classification without side effects.
 *
 * Host side: see src/modules/classification-log/index.ts for the
 * delivery-action handler that persists these into classification_log.
 */
import { writeMessageOut } from '../db/messages-out.js';
import { getRequestIdentity } from '../request-context.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

function generateId(): string {
  return `classify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Lightweight rule: how should the agent interpret its own confidence?
 * Returned as part of the tool response so the prompt can just read the
 * advisory instead of re-deriving the thresholds in natural language.
 *
 * Thresholds are conservative: enterprise routing accuracy costs more
 * than a brief extra clarification, so we nudge frontdesk toward
 * `ask_user_question` below 0.70.
 */
export function confidenceAdvisory(confidence: number, candidateCount: number): string {
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return 'Invalid confidence — treat this as low and ask the user to clarify.';
  }
  if (candidateCount === 0) {
    return 'No candidate workers identified — ask the user to clarify or reject politely.';
  }
  if (candidateCount > 1 && confidence < 0.7) {
    return 'Multiple plausible workers and confidence below 0.70 — call ask_user_question before delegating.';
  }
  if (confidence < 0.7) {
    return 'Confidence below 0.70 — call ask_user_question before delegating.';
  }
  if (confidence < 0.85) {
    return 'Confidence is moderate. Delegate, but consider adding a brief one-line confirmation in your reply so the user can catch a misroute.';
  }
  return 'High confidence — delegate directly.';
}

export const classifyIntent: McpToolDefinition = {
  tool: {
    name: 'classify_intent',
    description:
      'Declare how you classified the user request before routing. Required before send_message to a worker, ' +
      'before ask_user_question used as a clarification, or before replying yourself. ' +
      'The tool records the decision (recommended worker, confidence, candidates considered, reasoning, action) ' +
      'into the central classification log, and returns a short advisory describing whether the confidence ' +
      'is high enough to delegate or whether you should clarify first.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        userMessage: {
          type: 'string',
          description: 'The user message you are classifying (a short excerpt is fine).',
        },
        recommendedWorker: {
          type: 'string',
          description:
            'Single best-match worker destination name, or null when no worker fits (in which case either answer ' +
            'directly or clarify). Must be a real destination from your current destinations list.',
        },
        confidence: {
          type: 'number',
          description: 'Your confidence in `recommendedWorker` as a number in [0, 1].',
        },
        candidates: {
          type: 'array',
          items: { type: 'string' },
          description: 'Other worker destinations you considered, in descending order of plausibility.',
        },
        reasoning: {
          type: 'string',
          description:
            'One or two sentences explaining why you picked `recommendedWorker` (or why none fit). Stored ' +
            'for later audit and regression testing.',
        },
        action: {
          type: 'string',
          enum: ['delegate', 'clarify', 'reject', 'answer_self'],
          description:
            'What you intend to do next with this classification: `delegate` (call send_message to the worker), ' +
            '`clarify` (call ask_user_question first), `reject` (politely decline), or `answer_self` (reply ' +
            'directly without routing).',
        },
      },
      required: ['userMessage', 'confidence', 'action'],
    },
  },
  async handler(args) {
    const userMessage = typeof args.userMessage === 'string' ? args.userMessage : '';
    const recommendedWorker =
      typeof args.recommendedWorker === 'string' && args.recommendedWorker.length > 0 ? args.recommendedWorker : null;
    const confidenceRaw = args.confidence;
    const confidence =
      typeof confidenceRaw === 'number' && Number.isFinite(confidenceRaw) ? confidenceRaw : Number.NaN;
    const candidatesRaw = args.candidates;
    const candidates = Array.isArray(candidatesRaw)
      ? candidatesRaw.filter((c): c is string => typeof c === 'string' && c.length > 0)
      : [];
    const reasoning = typeof args.reasoning === 'string' ? args.reasoning : null;
    const actionRaw = args.action;
    const action =
      typeof actionRaw === 'string' && ['delegate', 'clarify', 'reject', 'answer_self'].includes(actionRaw)
        ? (actionRaw as 'delegate' | 'clarify' | 'reject' | 'answer_self')
        : null;
    if (!action) return err('action must be one of delegate | clarify | reject | answer_self');
    if (!userMessage) return err('userMessage is required');
    if (Number.isNaN(confidence)) return err('confidence must be a number in [0, 1]');

    const identity = getRequestIdentity();
    writeMessageOut({
      id: generateId(),
      kind: 'system',
      content: JSON.stringify({
        action: 'classify_intent',
        userId: identity?.userId ?? null,
        userMessage: userMessage.slice(0, 500),
        recommendedWorker,
        confidence,
        candidates,
        reasoning,
        action_taken: action,
      }),
    });

    const advisory = confidenceAdvisory(confidence, candidates.length + (recommendedWorker ? 1 : 0));
    log(`classify_intent: worker=${recommendedWorker ?? 'none'} conf=${confidence.toFixed(2)} action=${action}`);
    return ok(advisory);
  },
};

registerTools([classifyIntent]);
