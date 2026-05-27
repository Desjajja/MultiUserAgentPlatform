/**
 * Approval-scan module.
 *
 * For groups that opt in via container.json, install a recurring `kind=task`
 * row in the session's inbound.db. The host's existing scheduling module
 * (see src/modules/scheduling/recurrence.ts) handles re-firing the cron
 * expression — no separate timer is needed.
 *
 * Opt-in shape (groups/<folder>/container.json):
 * ```json
 * {
 *   "approvalScan": {
 *     "enabled": true,
 *     "cron": "* / 5 * * * *",
 *     "prompt": "..."        // optional override
 *   }
 * }
 * ```
 *
 * The default prompt walks the agent through the 14 pending-approval
 * endpoints from skills/xinjiulong-erp/references/approvals.md. Override
 * it per-group when the routing rules differ (e.g. a finance-only group
 * that should only watch the payment-confirmation queue).
 */
import fs from 'node:fs';
import path from 'node:path';

import { GROUPS_DIR } from '../../config.js';
import { hasTable, getDb } from '../../db/connection.js';
import { findSessionByAgentGroup } from '../../db/sessions.js';
import { log } from '../../log.js';
import { openInboundDb } from '../../session-manager.js';
import { insertTask } from '../scheduling/db.js';

const SERIES_ID_PREFIX = 'approval-scan-series';

const DEFAULT_PROMPT = `[定时任务] 现在执行**待审批扫描 + 按角色定向推送**（v4）。

## 🚨🚨🚨 一单一卡铁律（最优先 — 比静默退出还高）

**每张待审批的单据 = 一张独立的 push_card_to_user 卡片**。**严禁**把多张单合并成一张"采购单 7 笔, 总金额 ¥xxx"那种汇总卡 — 那种卡审批人无法一键批，他必须自己回 ERP 前端按单号点，**整套定向推送的意义就废了**。

**正确**（举例：拉到 7 张待审批采购单）：
- 调 7 次 push_card_to_user，每次只装 1 张单
- 每张卡按钮 ✓ 批准带 action.operation = "purchase_orders.approve" payload = { purchase_order_id: "..." }（具体 operation 名查 ai-gateway 路由表）
- 老板飞书里收到 7 条卡片消息，每条点 ✓ 就直接合规闭环走 confirm-token 写

**错误（看到自己想这么做就立刻停）**：
- 把 7 张订单的单号、金额合并成一段文字塞一张卡
- title 写"采购单 7 笔, 总金额 ¥xxx"
- 按钮写"我去审批/暂不处理"让用户去 ERP 前端按号点（这是甩锅，不是助手该干的事）
- "为了不刷屏先合并一张" — 老板宁愿收 7 条能一键批的卡，也不愿收 1 张得回前端逐个找的卡

**唯一可以发汇总的场景**：所有卡都 push 完后，发**一条** send_message 到 frontdesk session 给运营做总计（"已推送 7 张采购单卡片给老板"）。这条 send_message **不是** push_card_to_user，不是给老板的卡片。

---

## 🚨 静默退出规则（仅次于上面的一单一卡）

这是后台定时巡检，**每分钟跑一次**。绝大多数 turn 都不该有任何 message 输出。

**必须静默退出（=本 turn 完全不输出任何 \`<message>\` 块、不调 send_message）的情况**：

1. 14 个 pending 端点全部返回空 → 静默退出
2. 算 fingerprint 跟 state_get('approval_scan_last_fp') 一样 → 静默退出
3. 所有事件都被 30 分钟去重 key 拦下 → 静默退出
4. 没有可推送的 recipient（所有 role 全空 / 全没绑飞书）→ **可以**发一条到 frontdesk session 提醒运营，但只发一次：用 fingerprint 配合 \`alert:no_recipient_fp:<fp>\` key 去重，同一组事件不要每分钟提醒一次

**严禁的输出**（看到自己想写这种话就停下来）：
- "本次扫描结果与上次相同"
- "本次扫描完成"
- "未发现需要推送的事件"
- "扫描已完成"
- 任何"我做完了 / 我检查完了 / 都好的"性质的 ack

用户**永远不会**因为没收到这种 ack 觉得 agent 死了——只在有真正动作（推送 N 张卡）时才发汇总。

---

## 流程

1. 并行调以下 ERP 接口拉取**所有待人工动作的单**（不只是审批，包括已审批待执行 + 被驳回需重做）：

   **A. 待审批（找审批人 boss / finance / admin / hr）**
   - GET /api/orders/pending-receipt-confirmation （订单收款待审，权限 boss）
   - GET /api/orders?status=policy_pending_internal （政策内审，权限 boss）
   - GET /api/orders?status=policy_pending_external （政策外审，权限 厂家）
   - GET /api/purchase-orders?status=pending （采购审批，权限 finance / boss）
   - GET /api/accounts/pending-transfers （账户调拨，权限 boss）
   - GET /api/payroll/salary-records?status=pending_approval （工资审批，权限 boss / finance）
   - GET /api/attendance/leave-requests?status=pending （请假审批，权限 hr / boss）
   - GET /api/payment-requests?status=pending （付款申请，权限 finance / boss）
   - GET /api/expense-claims?status=pending （报销审批，权限 hr 或 boss 看金额）
   - GET /api/expenses?status=pending （费用审批）
   - GET /api/financing-orders/pending-repayments （融资还款，权限 finance / boss）
   - GET /api/mall/admin/payments/pending （商城凭证待确认，权限 admin / boss / finance）
   - GET /api/mall/admin/returns?status=pending （商城退货，权限 admin / boss / finance）
   - GET /api/store-returns/pending-approval （门店退货）
   - GET /api/transfers/pending-approval （仓库调拨，权限 admin / boss / finance）

   **B. 已审批待执行（找执行人 — 业务员 / 仓库 / 财务）**
   - GET /api/orders?status=approved （订单已审批待出库 → 推单上的 salesman_id）
   - GET /api/purchase-orders?status=approved （采购已审批待收货 → purchase / warehouse）
   - GET /api/orders?payment_status=unpaid&status=shipped （已发货未收款 → salesman_id 催账）

   **C. 被驳回需重做（找原提单人）**
   - GET /api/orders?status=policy_rejected （政策被驳回 → salesman_id）
   - GET /api/purchase-orders?status=rejected （采购被驳回 → 原提单人）

2. 全部空 → 静默退出（看上面静默规则）

3. **fingerprint 去重**：
   - sha256(所有事件 id 排序后) 前 12 位
   - state_get('approval_scan_last_fp') 一样 → 静默退出
   - 不一样 → 继续 4

4. **按权限路由 + push_card_to_user**：

   **A. 角色查找**：\`erp_request({ method: "GET", path: "/api/users/by-role?role=<role>&active=true", auth: "service-key" })\`
   roles: boss / finance / admin / hr / salesman / sales_manager / warehouse / purchase / store_manager / manufacturer_staff

   **B. boss / finance fallback admin**：小团队 boss 角色常常没人配。
     - role=boss 返空 → fallback role=admin
     - role=finance 返空 → fallback role=admin
     - admin 也空 → 这条 event 标记"无人可推"

   **C. 跳过未绑飞书**：feishu_open_id=null → 跳过 push，记一行到最终汇总（提醒运营让他 bind）

   **C.5. 多 recipient 必须全推**：role=admin 有 2 个人都绑了飞书 → **对每个人都调一次 push_card_to_user**。**严禁只推第一个**——审批是真实老板/财务的事，不是给随便一个 admin。哪怕你觉得"老板只有一个"，也要都推到（漏推比多推代价大）。

   **D. 去重**：每对 (event_id, recipient_open_id, status) 算 key
     - \`pushed:<event_id>:<status>:<open_id>\`
     - 30 分钟内推过 → 跳过
     - 否则 push_card_to_user → state_set 记录

   **E. 卡片必须详细**：title 只是单号，question 必须含
     - 业务对象 ID + 客户/供应商/申请人名
     - 关键金额
     - 关键内容摘要（商品+数量 / 工资属哪个月 / 报销什么用途）
     - 已挂多久（基于 created_at）
     - 风险提示（金额超阈值 / 客户欠款 / 政策超出）

     示例（政策审批）:
     \`\`\`
     title: "待审批：政策审批 SO-20260521100544"
     question: "**客户**：金宝烟酒\\n**商品**：青花郎 × 5箱 (30瓶)\\n**应收**：¥26,550\\n**政策价值**：¥7,550\\n**结算方式**：客户按指导价付\\n**业务员**：闫超建\\n**已挂**：2 小时\\n\\n确认审批通过吗？"
     \`\`\`

     示例（待出库订单）:
     \`\`\`
     title: "待出库：SO-20260521100544"
     question: "**订单**：SO-20260521100544\\n**客户**：鑫久源烟酒商行\\n**商品**：青花郎 × 5箱 (30瓶)\\n**仓库**：青花郎-主仓\\n**已批多久**：1 小时\\n\\n请去 ERP 前端按订单号扫码出库"
     \`\`\`

     **不允许**：用 "请审批/请处理" 这种空话；只放单号没有内容；让收件人自己去 ERP 翻。

   **F. 卡片按钮**（每张卡独立，不能合并）：
   - 待审批类（A）：**3 按钮 ✓ 批准 / ✗ 驳回 / 稍后处理**。✓ 按钮**必须**带 action: { operation, payload } 用合并接口（如 orders.approve_policy_with_request / purchase_orders.approve / payroll.pay_salary 等，参 ai-gateway 路由表），payload 至少含业务对象 ID。**严禁** ✓ 写成"我去审批/我去办"这种把审批权丢回 ERP 前端的措辞——本系统的卖点就是飞书一键批，丢回前端等于没做。
   - 待执行类（B）：2 按钮 ✓ 我去办 / 暂不办。✓ 不带 action（agent 不代办出库）
   - 驳回类（C）：2 按钮 ✓ 我来改 / 算了取消
   - expiresInDays: 2

   **再次强调**：A 类（待审批）卡片有 N 张就调 push_card_to_user N 次，**绝不汇总成 1 张卡**。

5. **本 turn 你不调任何写接口**——只 dispatch 卡片。

6. **完事**：
   - state_set('approval_scan_last_fp', 新fp)
   - 推送了 N (>0) 张卡 → **才能**发一条 send_message 汇总到 frontdesk session："已推送 N 张卡片：boss 收到 X 张 / finance 收到 Y 张 / 未绑飞书跳过 Z 张"
   - 推送 0 张 → 静默退出

---

**严禁**：
- **把多张待审批单合并成 1 张汇总卡推给审批人**（顶上铁律，违反等于功能作废）
- **A 类卡片 ✓ 按钮缺 action 字段或者 action.operation 不是真实 ERP 写操作**（缺了用户点了也只能干瞪眼）
- **A 类卡片按钮写"我去审批/去 ERP 前端处理"**（甩锅给前端 = 把这个定时任务的价值清零）
- 把任何审批卡片推给自己（task 没 "用户"在催；汇总用 send_message 到 frontdesk session）
- 自己调 approve / reject / ship / pay 接口
- 30 分钟内重复推同一 (event_id, status, person)
- 找不到 open_id 时瞎猜或推不相关的人——宁可漏推
- **fingerprint 一样还发任何 message**——上面"静默退出规则"已说，再违反就是 prompt 不遵守
- **推送卡片 question 只放单号不带详细内容**`;

interface ApprovalScanConfig {
  enabled: boolean;
  cron: string;
  prompt?: string;
}

function parseConfig(rawJson: string): ApprovalScanConfig | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const cfg = (parsed as { approvalScan?: unknown }).approvalScan;
  if (!cfg || typeof cfg !== 'object') return null;
  const r = cfg as Record<string, unknown>;
  if (r.enabled !== true) return null;
  const cron = typeof r.cron === 'string' && r.cron.trim() ? r.cron : '*/5 * * * *';
  const prompt = typeof r.prompt === 'string' ? r.prompt : undefined;
  return { enabled: true, cron, prompt };
}

function getAgentGroupId(rawJson: string): string | null {
  try {
    const parsed = JSON.parse(rawJson) as { agentGroupId?: unknown };
    return typeof parsed.agentGroupId === 'string' ? parsed.agentGroupId : null;
  } catch {
    return null;
  }
}

/**
 * Bootstrap approval-scan recurring tasks for every opted-in group.
 *
 * Idempotent: rows are keyed by series_id starting with SERIES_ID_PREFIX.
 * If a row already exists for the group's session in pending/paused state,
 * we skip insertion. This way restarting the host doesn't create duplicate
 * scans.
 *
 * Fail-soft: a malformed container.json or missing session is logged but
 * does not block host startup.
 */
async function bootstrapApprovalScans(): Promise<void> {
  if (!fs.existsSync(GROUPS_DIR)) return;
  // The scheduling module piggybacks on `messages_in.recurrence`; if the
  // session DB hasn't been initialized at all, defer.
  if (!hasTable(getDb(), 'sessions')) return;

  const entries = fs.readdirSync(GROUPS_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const containerJson = path.join(GROUPS_DIR, entry.name, 'container.json');
    if (!fs.existsSync(containerJson)) continue;
    let raw: string;
    try {
      raw = fs.readFileSync(containerJson, 'utf-8');
    } catch {
      continue;
    }
    const cfg = parseConfig(raw);
    if (!cfg) continue;
    const agentGroupId = getAgentGroupId(raw);
    if (!agentGroupId) {
      log.warn('approval-scan: container.json missing agentGroupId, skipping', { folder: entry.name });
      continue;
    }
    const session = findSessionByAgentGroup(agentGroupId);
    if (!session) {
      // No active session yet — nothing to bind the recurring task to.
      // The first user message wakes a session; we'd ideally rebootstrap
      // then, but that's a v2 problem.
      log.info('approval-scan: no active session for group, deferring scan bootstrap', {
        folder: entry.name,
        agentGroupId,
      });
      continue;
    }

    let inDb;
    try {
      inDb = openInboundDb(agentGroupId, session.id);
    } catch (err) {
      log.warn('approval-scan: openInboundDb failed', {
        folder: entry.name,
        sessionId: session.id,
        err: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    try {
      // Idempotency check: any live row whose series_id starts with our
      // prefix means a scan is already scheduled. BUT compare prompts —
      // if the prompt body has drifted (we updated DEFAULT_PROMPT or the
      // group changed `approvalScan.prompt`), tear down the stale series
      // and reinstall. Without this, a long-running host keeps replaying
      // the prompt that was captured at first install.
      const promptBody = cfg.prompt ?? DEFAULT_PROMPT;
      const wantedContent = JSON.stringify({ prompt: promptBody });
      const existing = inDb
        .prepare(
          `SELECT id, content FROM messages_in
           WHERE kind = 'task'
             AND series_id LIKE ?
             AND status IN ('pending', 'paused')
           ORDER BY seq DESC
           LIMIT 1`,
        )
        .get(`${SERIES_ID_PREFIX}-%`) as { id: string; content: string } | undefined;
      if (existing && existing.content === wantedContent) {
        log.info('approval-scan: recurring task already installed, skipping', {
          folder: entry.name,
          sessionId: session.id,
          existingId: existing.id,
        });
        continue;
      }
      if (existing) {
        // Prompt drift — cancel old series so the new one takes over.
        // cancelTask matches the whole series (id OR series_id).
        inDb
          .prepare(
            `UPDATE messages_in SET status = 'completed', recurrence = NULL
             WHERE (id = ? OR series_id = ?) AND kind = 'task' AND status IN ('pending', 'paused')`,
          )
          .run(existing.id, existing.id);
        log.info('approval-scan: prompt drift detected, cancelling old series', {
          folder: entry.name,
          sessionId: session.id,
          existingId: existing.id,
        });
      }

      const taskId = `${SERIES_ID_PREFIX}-${agentGroupId}-${Date.now()}`;
      // First fire shortly after host boot so the agent picks up backlog
      // without waiting a full cron tick.
      const firstRun = new Date(Date.now() + 30_000).toISOString();
      insertTask(inDb, {
        id: taskId,
        processAfter: firstRun,
        recurrence: cfg.cron,
        platformId: null,
        channelType: null,
        threadId: null,
        content: wantedContent,
      });
      // The scheduling module's recurrence sweep keys on series_id; without
      // setting it explicitly the row's id and series_id match (insertTask
      // does that for us). But because we pattern-matched series_id LIKE
      // '<prefix>-%' above for idempotency, ensure the prefix is preserved
      // — insertTask uses the row's own id, which already starts with
      // SERIES_ID_PREFIX.
      log.info('approval-scan: recurring task installed', {
        folder: entry.name,
        sessionId: session.id,
        taskId,
        cron: cfg.cron,
        firstRun,
      });
    } finally {
      try {
        inDb.close();
      } catch {
        // ignore
      }
    }
  }
}

// Run after the rest of the host has booted. Top-level await would block
// channel-adapter init; instead schedule on next tick so this doesn't
// race the central DB initialization order.
setTimeout(() => {
  bootstrapApprovalScans().catch((err) => {
    log.error('approval-scan bootstrap failed', { err });
  });
}, 5_000);
