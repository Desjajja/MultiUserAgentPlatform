/**
 * Interactive MCP tools: ask_user_question.
 *
 * NON-BLOCKING design: ask_user_question writes a card to outbound.db +
 * creates a pending_questions row, then returns immediately with
 * `{ pending: true, questionId }`. The agent's turn ends naturally.
 *
 * When the user clicks the button (could be seconds or days later), the
 * host's interactive module writes a chat-kind inbound row that wakes the
 * container. The agent's next turn sees the click in conversation history
 * and proceeds with whatever it was about to do (ship/create/approve…).
 *
 * Why non-blocking: a blocking variant keeps the container + LLM session
 * pinned open until the user clicks, which holds a container slot for
 * minutes-to-days per pending decision. With 10 container slots and many
 * concurrent users, blocking deadlocks the platform quickly.
 */
import { writeMessageOut } from '../db/messages-out.js';
import { getSessionRouting } from '../db/session-routing.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function routing() {
  return getSessionRouting();
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

export const askUserQuestion: McpToolDefinition = {
  tool: {
    name: 'ask_user_question',
    description:
      '发一张带按钮的飞书卡片让用户点选确认。**这是非阻塞工具**：调完会立刻返回 `{ pending, questionId }`，**此 turn 你必须停下不能再调写操作**。用户点了按钮以后会触发新 turn，新 turn 里 inbound 消息会告诉你用户点了什么（含 questionId），那时再 follow up 调真正的写接口（ship/create/approve）。用户不点 → 卡片默认有效 7 天，container 此期间闲置退出不占资源。' +
      '** L2 写操作的常见用法**：每个 option 里加 `action: { operation, payload }`，host 会在用户点按钮时调 ERP /api/confirm-tokens 帮你签一个一次性的 X-User-Confirm token，写进新 turn 的 inbound 里。新 turn 你直接调 `erp_execute({ operation, payload, dryRun: false, questionId, idempotencyKey })`，工具自动把 token 加到 header — 完整链路自动闭环。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: '卡片蓝色标题栏文字（如 "确认出库 SO-xxx"）' },
        question: { type: 'string', description: '卡片正文（markdown，可含表格/列表）' },
        options: {
          type: 'array',
          items: {
            oneOf: [
              { type: 'string' },
              {
                type: 'object',
                properties: {
                  label: { type: 'string', description: '按钮上显示的文字' },
                  selectedLabel: { type: 'string', description: '用户点了之后卡片上换成这个文字' },
                  value: { type: 'string', description: '返回给 agent 的 value' },
                  action: {
                    type: 'object',
                    description:
                      '可选。如果这个按钮是"确认提交某个 L2 写操作"，把对应的 operation + payload 写在这里。host 会在用户点击时调 /api/confirm-tokens 签一个一次性 token 注入下一 turn 的 inbound，agent 在新 turn 调 erp_execute 时自动用这个 token。** 用户点了不带 action 的按钮（比如"取消"）host 不会签 token，下一 turn 你不要继续走写流程。',
                    properties: {
                      operation: { type: 'string', description: 'L2 operation 名（参 ai-gateway 路由表）' },
                      payload: { type: 'object', additionalProperties: true, description: '业务字段' },
                    },
                    required: ['operation', 'payload'],
                  },
                },
                required: ['label'],
              },
            ],
          },
          description: '按钮选项列表',
        },
        expiresInDays: {
          type: 'number',
          description: '按钮有效期（天），默认 7。到期后用户点击会被忽略。',
        },
      },
      required: ['title', 'question', 'options'],
    },
  },
  async handler(args) {
    const title = args.title as string;
    const question = args.question as string;
    const rawOptions = args.options as unknown[];
    if (!title || !question || !rawOptions?.length) {
      return err('title, question, and options are required');
    }

    const options = rawOptions.map((o) => {
      if (typeof o === 'string') return { label: o, selectedLabel: o, value: o };
      const obj = o as {
        label: string;
        selectedLabel?: string;
        value?: string;
        action?: { operation?: string; payload?: Record<string, unknown> };
      };
      const out: {
        label: string;
        selectedLabel: string;
        value: string;
        action?: { operation: string; payload: Record<string, unknown> };
      } = {
        label: obj.label,
        selectedLabel: obj.selectedLabel ?? obj.label,
        value: obj.value ?? obj.label,
      };
      if (obj.action && typeof obj.action.operation === 'string' && obj.action.operation) {
        out.action = {
          operation: obj.action.operation,
          payload: (obj.action.payload && typeof obj.action.payload === 'object'
            ? obj.action.payload
            : {}) as Record<string, unknown>,
        };
      }
      return out;
    });

    // Guardrail: if an option's label / value clearly says "confirm /
    // approve / yes / 确认 / 批准 / 通过 / 同意" but it has no `action`
    // field, the L2 write path is broken — user clicks → no confirm-token
    // gets minted → agent's next-turn erp_execute hits ERP 403.
    //
    // Reject the call with a clear message so the agent has to fix the
    // call site instead of silently sending a card that can't do anything.
    //
    // Exempted (action not required by design):
    //   - "取消 / cancel / 暂不 / later / 算了" — explicit no-op
    //   - "我去办 / 知道了 / OK 收到 / ack" — pure ack, no ERP write
    // The agent intentionally omits action on these.
    const affirmativeRe = /^[\s✓✅👍]*(?:confirm|approve|✓|✅|确认|批准|通过审批|同意)/i;
    for (const opt of options) {
      const looksAffirmative = affirmativeRe.test(opt.label) || affirmativeRe.test(opt.value);
      if (!looksAffirmative) continue;
      if (opt.action) continue;
      return err(
        `按钮 "${opt.label}" 看起来是确认/批准按钮，但缺少 action 字段。L2 写操作必须给确认按钮带上 ` +
          `action: { operation, payload } 以便用户点击时签 confirm-token。否则按钮点了 agent 在下一 turn 调 ` +
          `erp_execute 会因为缺少 X-User-Confirm 被 ERP 403。\n\n` +
          `如果这张卡片只是确认"看到了 / 知道了"（B 类待执行卡），把 label 改成"我去办 / 知道了 / OK 收到 / ack"等不含 ` +
          `"确认/批准/同意/通过" 字样，工具就会放过。`,
      );
    }

    const expiresInDays =
      typeof args.expiresInDays === 'number' && Number.isFinite(args.expiresInDays) && args.expiresInDays > 0
        ? Math.min(args.expiresInDays, 30) // hard cap 30 days
        : 7;
    const expiresAt = Date.now() + expiresInDays * 24 * 60 * 60 * 1000;

    const questionId = generateId();
    const r = routing();

    const contentObj: Record<string, unknown> = {
      type: 'ask_question',
      questionId,
      title,
      question,
      options,
      expiresAt,
    };

    writeMessageOut({
      id: questionId,
      kind: 'chat-sdk',
      platform_id: r.platform_id,
      channel_type: r.channel_type,
      thread_id: r.thread_id,
      content: JSON.stringify(contentObj),
    });

    log(
      `ask_user_question (non-blocking): ${questionId} → "${question.slice(0, 40)}" [${options
        .map((o) => o.label)
        .join(', ')}] expiresInDays=${expiresInDays}`,
    );

    return ok(
      JSON.stringify({
        pending: true,
        questionId,
        expiresInDays,
        message:
          '卡片已发送。这一 turn 必须在此结束 — 不要在本 turn 调任何写接口。用户点按钮后会触发新 turn，新 turn 里你能看到点击结果，那时再 follow up。',
      }),
    );
  },
};

registerTools([askUserQuestion]);

/**
 * push_card_to_user — send an interactive ask_question card to **another
 * Feishu user's private chat** (i.e. not the current session). Used by the
 * scheduled approval-scan task to nudge the boss / finance directly: agent
 * pulls the pending-approvals list, decides each one's audience, calls this
 * tool once per recipient.
 *
 * Why a separate tool from ask_user_question:
 *   - ask_user_question routes to the current session via getSessionRouting()
 *   - push_card_to_user routes to an arbitrary feishu:p2p:<open_id>
 *   - the click event still wakes THIS session (the agent that sent the
 *     card) because pending_questions.session_id is set from the outbound
 *     row's source — see src/delivery.ts createPendingQuestion(). That
 *     means: agent here sends → boss clicks in his DM → THIS agent's next
 *     turn picks up the click and runs the follow-up write.
 *
 * Trust model:
 *   - The agent supplies open_id; this can be anyone in the company. ERP
 *     side authorization (HMAC / role check / X-User-Confirm) is what
 *     actually gates the eventual write. Pushing a card is itself benign
 *     — worst case is a user gets a card they don't have permission to
 *     approve, and the follow-up write fails 403.
 *   - expectedUserId in the button payload is set to the recipient's
 *     open_id so click events from other users (e.g. someone forwarding
 *     the card) get rejected by handleCardAction's `wrong user` check.
 */
export const pushCardToUser: McpToolDefinition = {
  tool: {
    name: 'push_card_to_user',
    description:
      '把一张审批/确认卡片**直接推送到指定飞书用户的私聊**（不在当前会话）。常用于定时审批扫描时通知老板/财务。' +
      '收到 open_id 后立即返回 { pending: true, questionId }；本 turn 必须就此结束。对方点按钮后触发新 turn 来这里处理。' +
      'open_id 形如 `ou_xxxxxxxxxxxxxx`（**不要**带 `feishu:` 前缀）。' +
      '提醒：你不能给自己 open_id 推（消息会回到你自己看不到的私聊）。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        open_id: {
          type: 'string',
          description: '收件人的飞书 open_id（如 ou_42268bc2...）',
        },
        title: { type: 'string', description: '卡片蓝色标题栏文字（如"待审批：政策审批 SO-xxx"）' },
        question: { type: 'string', description: '卡片正文（markdown，可含表格/列表）' },
        options: {
          type: 'array',
          items: {
            oneOf: [
              { type: 'string' },
              {
                type: 'object',
                properties: {
                  label: { type: 'string' },
                  selectedLabel: { type: 'string' },
                  value: { type: 'string' },
                },
                required: ['label'],
              },
            ],
          },
          description: '按钮选项列表（至少要有 ✓ 批准 / ✗ 驳回 两个）',
        },
        expiresInDays: {
          type: 'number',
          description: '按钮有效期（天），默认 7，最长 30',
        },
      },
      required: ['open_id', 'title', 'question', 'options'],
    },
  },
  async handler(args) {
    const openId = typeof args.open_id === 'string' ? args.open_id.trim() : '';
    const title = args.title as string;
    const question = args.question as string;
    const rawOptions = args.options as unknown[];

    if (!/^ou_[A-Za-z0-9]+$/.test(openId)) {
      return err('open_id 格式错误：应为 ou_xxx，不要带 feishu: 前缀');
    }
    if (!title || !question || !rawOptions?.length) {
      return err('title, question, options are required');
    }

    const options = rawOptions.map((o) => {
      if (typeof o === 'string') return { label: o, selectedLabel: o, value: o };
      const obj = o as { label: string; selectedLabel?: string; value?: string };
      return {
        label: obj.label,
        selectedLabel: obj.selectedLabel ?? obj.label,
        value: obj.value ?? obj.label,
      };
    });

    const expiresInDays =
      typeof args.expiresInDays === 'number' && Number.isFinite(args.expiresInDays) && args.expiresInDays > 0
        ? Math.min(args.expiresInDays, 30)
        : 7;
    const expiresAt = Date.now() + expiresInDays * 24 * 60 * 60 * 1000;

    const questionId = generateId();
    const contentObj: Record<string, unknown> = {
      type: 'ask_question',
      questionId,
      title,
      question,
      options,
      expiresAt,
      // Lock the card to this specific recipient so handleCardAction
      // rejects clicks from anyone else who can see it (e.g. if Feishu
      // ever supports forwarding cards or shared P2P views).
      expectedUserId: openId,
    };

    writeMessageOut({
      id: questionId,
      kind: 'chat-sdk',
      // Route to the recipient's P2P inbox. The host's Feishu adapter
      // splits this on `:` to figure out receiveIdType=open_id.
      platform_id: `feishu:p2p:${openId}`,
      channel_type: 'feishu',
      thread_id: null,
      content: JSON.stringify(contentObj),
    });

    log(
      `push_card_to_user: ${questionId} → ou_${openId.slice(3, 11)}... "${question.slice(0, 40)}" expiresInDays=${expiresInDays}`,
    );

    return ok(
      JSON.stringify({
        pending: true,
        questionId,
        recipient: openId,
        expiresInDays,
        message:
          '卡片已发往目标用户私聊。本 turn 结束。该用户点按钮后会触发你的新 turn，新 turn 里你能看到点击结果。',
      }),
    );
  },
};

registerTools([pushCardToUser]);

export const sendCard: McpToolDefinition = {
  tool: {
    name: 'send_card',
    description: 'Send a structured card (interactive or display-only) to the current conversation.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        card: {
          type: 'object',
          description: 'Card structure with title, description, and optional children/actions',
        },
        fallbackText: { type: 'string', description: 'Text fallback for platforms without card support' },
      },
      required: ['card'],
    },
  },
  async handler(args) {
    const card = args.card as Record<string, unknown>;
    if (!card) return err('card is required');

    const id = generateId();
    const r = routing();

    writeMessageOut({
      id,
      kind: 'chat-sdk',
      platform_id: r.platform_id,
      channel_type: r.channel_type,
      thread_id: r.thread_id,
      content: JSON.stringify({ type: 'card', card, fallbackText: (args.fallbackText as string) || '' }),
    });

    log(`send_card: ${id}`);
    return ok(`Card sent (id: ${id})`);
  },
};

// `send_card` defined-but-unregistered so we can flip it back on without
// resurrecting deleted code; today the frontdesk gets card rendering "for
// free" via the markdown title detection in src/channels/feishu.ts.
