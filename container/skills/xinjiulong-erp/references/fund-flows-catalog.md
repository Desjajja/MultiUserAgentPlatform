# 资金流完全手册

每一笔账户变动的场景、公式、反向操作。Agent 操作动账类功能前必须先确认这个表。

**账户命名速记**：
- **master**：总资金池（全公司一个，level='master'）
- **品牌 cash**：品牌现金账户（account_type='cash', level='project'）
- **品牌 F 类**：政策返款账户（account_type='f_class'）
- **品牌 financing**：融资账户（account_type='financing'）
- **payment_to_mfr**：应付给厂家账户（account_type='payment_to_mfr'）

---

## 场景总览（24 个场景）

```
┌─ 收款类 ─────────────────────────────────────┐
│  1. 客户回款 → master                         │
│  2. 政策/F类到账 → 品牌 F 类                  │
│  3. 厂家工资补贴到账 → 品牌 cash              │
│  4. 融资放款 → 品牌 financing                 │
│  5. 分货收款（share_out）→ master             │
│  6. 稽查 B1 回售收入 → 品牌 cash              │
└───────────────────────────────────────────────┘
┌─ 支出类 ─────────────────────────────────────┐
│  7. 采购付款 → 扣品牌 cash/F类/financing      │
│  8. 发工资 → 扣品牌 cash                      │
│  9. 调拨 master → 品牌 cash                   │
│ 10. 报销付款 → 扣指定账户                     │
│ 11. 还融资 → 扣品牌 cash（+F类）              │
│ 12. 垫付返还 → 扣品牌 cash（advance_refund）  │
│ 13. 稽查付款（A1/A2 回收）→ 扣品牌 cash       │
│ 14. 稽查罚款 → 扣品牌 cash                    │
│ 15. 稽查 B2 买入付款 → 扣品牌 cash            │
│ 23. 公司垫付政策费用 → 扣品牌 cash（关联费用）│
└───────────────────────────────────────────────┘
┌─ 调账类 ─────────────────────────────────────┐
│ 16. 采购通过 → 写 payment_to_mfr（代记应付）  │
│ 17. 撤销采购 → 反扣 payment_to_mfr            │
│ 18. A3 被转码扣回款 → 扣 payment_to_mfr       │
│ 19. B2 转码入库加回款 → 加 payment_to_mfr    │
│ 20. 分货扣回款 → 扣 payment_to_mfr            │
│ 21. 公司垫付回收 → F类→品牌 cash 内转         │
│ 22. 手工加流水（反向凭证） → 任意账户         │
│ 24. advance_refund 同步 actual_cost           │
│     （仅记账副作用，不再独立动账，配合场景 12）│
└───────────────────────────────────────────────┘
```

---

## AI Agent 调用 SOP 速查（24 场景按风险等级分类）

**所有动账类（16 / 24）都是 L2，必须走 `/api/agent/execute`**。下表标注每个场景的 Agent 调用方式：

| # | 场景 | 风险 | Agent 调用方式 |
|---|---|---|---|
| 1 | 客户回款 → master | **L2** | Gateway dryRun + token（`orders.confirm_payment`）|
| 2 | 政策/F 类到账 | **L2** | Gateway dryRun + token（`policies.confirm_arrival`）|
| 3 | 厂家工资补贴到账 | **L2** | Gateway dryRun + token（`payroll.confirm_subsidy_arrival`）|
| 4 | 融资放款 | **L2** | Gateway dryRun + token（`financing.confirm_arrival`）|
| 5 | 分货收款 | **L2** | Gateway dryRun + token（`orders.confirm_payment` 同入口）|
| 6 | 稽查 B1 回售 | **L2** | Gateway dryRun + token（`inspections.execute_case`）|
| 7 | 采购付款 | **L2 不可逆** | **drafts 两阶段**（`purchase.approve` 触发动账）|
| 8 | 发工资 | **L2 不可逆** | **drafts 两阶段**（`payroll.batch_pay`，单批 ≤ 20）|
| 9 | 调拨 master → 品牌 | **L2** | Gateway dryRun + token（`accounts.transfer`）|
| 10 | 报销付款 | **L2 不可逆** | **drafts 两阶段**（`expense_claims.pay`）|
| 11 | 还融资 | **L2 不可逆** | **drafts 两阶段**（`financing.repay`）|
| 12 | 垫付返还 advance_refund | **L2** | Gateway dryRun + token（`policies.refund_advance`）|
| 13 | 稽查付款（A1/A2） | **L2** | Gateway dryRun + token（`inspections.execute_case`）|
| 14 | 稽查罚款 | **L2** | Gateway dryRun + token（同 13）|
| 15 | 稽查 B2 买入 | **L2** | Gateway dryRun + token（同 13）|
| 16 | 采购通过 → payment_to_mfr | L1 | 直调（`POST /api/purchase-orders/{id}/approve`，记应付不直接动现金）|
| 17 | 撤销采购 | **L2** | Gateway dryRun + token（反扣应付）|
| 18 | A3 转码扣回款 | **L2** | Gateway dryRun + token（同稽查 execute）|
| 19 | B2 转码入库 | **L2** | Gateway dryRun + token（同稽查 execute）|
| 20 | 分货扣回款 | **L2** | Gateway dryRun + token（订单确认收款触发）|
| 21 | 公司垫付回收 F→cash | **L2** | Gateway dryRun + token（`policies.refund_advance` 配合）|
| 22 | 手工加流水（反向凭证） | **L2** | Gateway dryRun + token + 老板签批（`accounts.manual_entry`）|
| 23 | 公司垫付政策费用 | **L2 不可逆** | **drafts 两阶段**（`policies.create_item_expense (payer=company)`，单笔 < ¥50,000）|
| 24 | advance_refund 同步 | L1 | 内部副作用，不独立动账 |

**铁律**：上表 L2 行 Agent **绝不能直打** REST 端点 —— 必须走 `/api/agent/execute`。直打会被 `dependencies=[risk_l2]` 后端拒（如果绕开就违反了 SKILL.md §5 + business-rules.md §零点五）。

详见 `ai-gateway.md`、`business-rules.md` §零点五、`state-machines.md` §14（DraftAction）。

---

## 1. 客户回款 → master

**触发**：财务在审批中心点"确认收款"（`POST /orders/{id}/confirm-payment`）。

**金额**：每笔 pending Receipt 的 `amount`。

**动账**：
```
master.balance += Receipt.amount
fund_flow: type=credit, related_type='receipt', related_id=Receipt.id
```

**关联**：
- Receipt.status: pending_confirmation → confirmed
- Order.payment_status: unpaid/partial → partial/fully_paid
- Receivable.paid_amount 按比例分摊（apply_per_receipt_effects）
- 首次 fully_paid 时自动生成 Commission

**反向**：财务驳回凭证 → Receipt.status=rejected（**不动账**，因为本来就没动过）。

**幂等**：Receipt.status='confirmed' 的不能被再次 confirm（后端状态校验）。

**查 SUM 必过滤 status='confirmed'**（重要）。

---

## 2. 政策/F 类到账 → 品牌 F 类

**触发**：财务 `POST /policies/requests/confirm-arrival`。

**金额**：`arrival_amount`（厂家实际打款额）。

**动账**：
```
品牌 F 类.balance += arrival_amount
fund_flow: type=credit, related_type='policy_arrival', related_id=PolicyRequestItem.id
```

**关联**：
- PolicyRequestItem.fulfill_status: → `arrived`
- 仅 `request_source='f_class'` 的才动 F 类账户

**幂等**：已 `arrived` 的 item 跳过（重要，历史 bug 已修）。

**反向**：理论上冲正，实际不支持反向端点，需手工加 `debit` 流水。

---

## 3. 厂家工资补贴到账 → 品牌 cash

**触发**：`POST /payroll/manufacturer-subsidies/confirm-arrival`。

**金额**：`arrived_amount`，必须**精确等于**该品牌该期 `(pending + advanced)` 合计（否则 400）。

**动账**：
```
品牌 cash.balance += arrived_amount
fund_flow: type=credit, related_type='manufacturer_salary_arrival'
```

**关联**：
- ManufacturerSalarySubsidy.status: pending/advanced → `reimbursed`
- 如果之前是 advanced（公司已垫付），返还公司

**反向**：无（手工建反向凭证）。

---

## 4. 融资放款 → 品牌 financing

**触发**：`POST /financing-orders`。

**金额**：`amount`（本金）。

**动账**：
```
品牌 financing.balance += amount
fund_flow: type=financing_drawdown, related_type='financing_order'
```

**反向**：还款时 `balance -= principal_amount`。

---

## 5. 分货收款（share_out）→ master

**触发**：`POST /expense-claims/{id}/approve` 且 `claim_type='share_out'`。

**动账**：
```
master.balance += amount           # 总资金池入账
品牌 payment_to_mfr.balance -= amount  # 从应付厂家账户扣出
两笔 fund_flow: credit + debit
```

**铁律**：两个账户**都必须存在**才执行（否则 400），避免半做（历史 bug 已修）。

**反向**：只能驳回 pending 的，approved 后的要走反向凭证。

---

## 6. 稽查 B1 回售收入 → 品牌 cash

**触发**：execute 案件 `case_type='inflow_resell'`。

**金额**：`resell_price × bottles`。

**动账**：
```
品牌 cash.balance += income
fund_flow: type=credit, related_type='inspection_income'
```

**同时**：从备用仓库出库（扣库存）。

---

## 7. 采购付款 → 扣品牌 cash/F类/financing

**触发**：`POST /purchase-orders/{id}/approve`。

**金额**：`cash_amount + f_class_amount + financing_amount`（之和 = `SUM(items.quantity × unit_price)`，前端校验浮点误差 0.01）。

**动账**（三账户分别）：
```
品牌 cash.balance -= cash_amount
品牌 F 类.balance -= f_class_amount
品牌 financing.balance -= financing_amount

+ 同时 payment_to_mfr.balance += cash_amount + financing_amount  # 记应付
三笔或四笔 fund_flow
```

**余额不足**：400 拒绝整笔审批。

**反向**：`POST /purchase-orders/{id}/cancel`（仅 paid 状态） — 各账户 += 当初扣的值，payment_to_mfr 反扣 cash+financing。

**幂等 + 并发**：cancel 走 `SELECT FOR UPDATE` 锁 payment_to_mfr 账户。

---

## 8. 发工资 → 扣品牌 cash

**触发**：`POST /payroll/salary-records/{id}/pay`。

**金额**：`actual_pay`。

**动账**：
```
品牌 cash.balance -= actual_pay
fund_flow: type=debit, related_type='salary_pay'
```

**余额不足**：400（先调拨）。

**并发**：需 `SELECT FOR UPDATE` 锁 SalaryRecord。

**反向**：无端点，需手工 debit 反向流水 + 把 SalaryRecord status 改回。

---

## 9. 调拨 master → 品牌 cash

**触发**：`POST /accounts/transfer` + `POST /transfers/{id}/approve`。

**金额**：`amount`。

**动账**：
```
from_account.balance -= amount
to_account.balance   += amount
两笔 fund_flow: debit + credit
```

**权限**：**仅 boss 能批准**。

**反向**：反向调拨（一条新的 TransferRequest）。

---

## 10. 报销付款（日常）→ 扣指定账户

**触发**：`POST /expense-claims/{id}/pay?account_id=X`（仅 claim_type='daily'）。

**动账**：
```
account.balance -= claim.amount
fund_flow: type=debit, related_type='daily_expense'
```

**并发**：需 `SELECT FOR UPDATE` 锁 claim + account。

**反向**：delete claim 需走状态校验（只能删 pending/rejected，paid 的走反向凭证）。

---

## 11. 还融资 → 扣品牌 cash（+F 类）

**触发**：`POST /financing-orders/repayments/{id}/approve`（boss 批）。

**金额**：`principal_amount + interest_amount`（退仓 `return_warehouse` 只付利息）。

**动账**：
```
品牌 cash.balance    -= cash_needed     # principal + interest
品牌 financing.balance -= principal_amount  # 销账
品牌 F 类.balance    -= f_class_amount  # 可选（如果有 F 类结算）
多笔 fund_flow
```

**铁律**：
- F 类余额不足 **必须整体 400 拒绝**（历史 bug：静默跳过让现金已扣 F 类没扣，账务失衡）
- `SELECT FOR UPDATE` 锁 repayment + order（防并发 `repaid_principal +=` 覆盖）
- 校验 `pay_acc.brand_id == order.brand_id`（防跨品牌串账）

**自动驳回**：现金余额不足时直接设 rep.status='rejected' 不动账。

---

## 12. 垫付返还 → 扣品牌现金（advance_refund）

**触发**：`POST /payment-requests/{id}/confirm-payment`。**前置必须 status=approved**（需先 PUT `/payment-requests/{id}` `{"status":"approved"}` 让财务批一道）。

**金额**：request.amount（等于 PolicyRequestItem 应还垫付额）。

**动账**（finance.py:1689-1697）：
```
品牌 cash 账户 (account_type='cash' AND level='project').balance -= amount
fund_flow: type=debit, related_type='advance_refund'
（同事务）若 request_type='advance_refund' AND source_request_item_id AND payee_type ∈ {customer, employee}：
    PolicyRequestItem.actual_cost += amount   # 见场景 24
```

**强校验**：付款账户必须是 cash + project 这条品牌现金账户，不接受 master / F 类 / financing。余额不足 → 400 不动账。

**关联**：PolicyRequestItem.fulfill_status in (fulfilled, settled) + advance_payer_type ∈ {employee, customer} → submit-voucher 自动建 PENDING PaymentRequest。`payee_type='company'` 走的是场景 23（关联费用立扣），不走这条。

**不动 payment_to_mfr**：历史文档曾写"扣 payment_to_mfr"，已废止。实际扣的是品牌现金账户。

---

## 13-15. 稽查 execute 时的动账

### 13. A1/A2 回收付款 → 扣品牌 cash

**触发**：execute `outflow_malicious` 或 `outflow_nonmalicious`。

**金额**：`purchase_price × bottles`（回收价 × 瓶数）。

**动账**：
```
品牌 cash.balance -= pay_amt
fund_flow: type=debit, related_type='inspection_payment'
```

### 14. 稽查罚款 → 扣品牌 cash

**触发**：execute `outflow_*` 且 `penalty_amount > 0`。

**动账**：
```
品牌 cash.balance -= penalty_amount
fund_flow: type=debit, related_type='inspection_penalty'
```

### 15. B2 转码入库付款 → 扣品牌 cash

**触发**：execute `inflow_transfer`。

**金额**：`purchase_price × bottles`（买入价）。

**动账**：同 13。

**铁律**：execute 开头预算 `total_debit` 校验品牌 cash 余额，不够整体 400。

---

## 16-17. 采购 payment_to_mfr 记账

### 16. 采购审批通过 → payment_to_mfr +=

**触发**：`POST /purchase-orders/{id}/approve`。

**金额**：`cash_amount + financing_amount`（**不包含 f_class_amount**，因为 F 类是已有款）。

**动账**：
```
payment_to_mfr.balance += cash + financing
fund_flow: type=credit, related_type='purchase_payment'
```

含义：代表"已付给厂家"的累计额度。

### 17. 撤销采购 → payment_to_mfr -=

**触发**：`POST /purchase-orders/{id}/cancel`。

**动账**：反转第 16 步。

**并发**：`SELECT FOR UPDATE` + 余额校验（不够 400）。

---

## 18-19. 稽查 A3/B2 的 payment_to_mfr 动账

### 18. A3 被转码扣回款 → payment_to_mfr -=

**触发**：execute `outflow_transfer`（已挪到 execute，历史在 create 阶段）。

**金额**：`transfer_amount`（被转码抵扣的金额）。

**动账**：
```
payment_to_mfr.balance -= transfer_amount
fund_flow: type=debit, related_type='transfer_deduction'
```

**余额校验**：不足整体 400。

### 19. B2 转码入库加回款 → payment_to_mfr +=

**触发**：execute `inflow_transfer`。

**金额**：`purchase_price × bottles`。

**动账**：
```
payment_to_mfr.balance += amt
fund_flow: type=credit, related_type='transfer_credit'
```

---

## 20. 分货扣回款（同 #5 的双记账一半）

见场景 5，同一笔 share_out 动两个账户：master += 和 payment_to_mfr -=。

---

## 21. 公司垫付回收 → F 类→品牌 cash 内转

**触发**：`confirm_settlement_allocation` 时某 claim item 的 `advance_payer_type='company'`。

**金额**：item 的 `share`（按 declared_amount 比例分摊的厂家结算额）。

**动账**：
```
品牌 F 类.balance   -= share
品牌 cash.balance   += share
两笔 fund_flow: debit + credit, related_type='company_advance'
```

含义：厂家打了政策款到 F 类，公司把垫过的钱从 F 类转回现金。

**关键校验**（已修）：`settlement.brand_id == claim.brand_id`，防跨品牌串账。

---

## 22. 手工加流水（反向凭证）→ 任意账户

**触发**：`POST /accounts/fund-flows`（仅 boss/finance）。

**用途**：冲正历史错账 / 非业务流程的调账。

**动账**：
```
account.balance += amount  # credit
account.balance -= amount  # debit
对应方向 fund_flow
```

**Agent 绝对提醒**："这是手工操作账户，不可逆。请再次确认金额和方向。"

---

## 23. 公司垫付政策费用 → 扣品牌 cash（线下补登）

**触发**：财务在「政策申请详情 → 添加关联费用」录入，`payer_type='company' AND cost_amount > 0`。

**业务语义**：公司线下已经付过钱（机票/酒店/场地费），这个动作只是**回 ERP 补登记**，不发起对外打款。

**接口**：
```
POST /api/policies/request-items/{item_id}/expenses
{
  "name": "机票",
  "cost_amount": 8000,
  "payer_type": "company",
  "reimburse_amount": 10000      // 厂家应报销额，仅展示用
}
```

**动账（保存即生效）**：
```
品牌 cash.balance -= cost_amount
fund_flow:
  flow_type = 'debit'
  related_type = 'policy_company_expense'
  related_id = expense.id      # PolicyItemExpense.id
  notes = "政策项关联费用录入: {item.name}（{expense.name}）/ 政策项 {ri.id[:8]}"
PolicyRequestItem.actual_cost += cost_amount   # 累加，让利润台账 fclass_diff 对得上
```

**修改（PUT /api/policies/expenses/{id}）**：按 delta 差额补/退；同步反向流水 + actual_cost 调整。

**删除（DELETE /api/policies/expenses/{id}）**：
```
品牌 cash.balance += cost_amount
fund_flow:
  flow_type = 'credit'
  related_type = 'policy_company_expense'
  related_id = expense.id
  notes = "政策项关联费用撤销: ..."
PolicyRequestItem.actual_cost -= cost_amount  # 不会为负
```

**业务门禁**：
- `PolicyRequestItem.fulfill_status='settled'` → 400 "已归档不能变更关联费用"
- 品牌缺 `account_type='cash' AND level='project'` → 400 "未配置现金账户"
- 余额不足 → 400 "账户余额不足"
- `payer_type` ≠ `company` → 不动账（仅做 PolicyItemExpense 登记）

**Agent 关键提醒**：
- 录入前必须问清"谁付的钱"，按答案选 `payer_type`
- `company` 一旦保存就实际扣账，**不可"草稿保存"**；不确定先别录
- 改/删的反向流水会写在 `fund_flows`，账目可追溯

详见 `policies.md` 场景 7.5。

---

## 24. advance_refund 批准 → 同步 actual_cost（不动账，调账目）

**触发**：`POST /api/payment-requests/{id}/confirm-payment`（advance_refund 类型，且关联政策项）。

**问题背景**：客户/业务员垫付场景，财务批准还垫付时**已经在场景 12 扣过品牌 cash**了。但利润台账 `fclass_diff = arrival_amount - actual_cost`，actual_cost 留 0 → 误以为公司净赚那笔垫付额。

**额外动作（在场景 12 扣账之外）**：
```
if obj.request_type == 'advance_refund'
   and obj.source_request_item_id is not None
   and obj.payee_type in ('customer', 'employee'):
    PolicyRequestItem.actual_cost += obj.amount
```

**注意**：
- 这个**不写新 fund_flow**（场景 12 已写）。只是补一个会计科目数。
- `payee_type='company'` 不走这条 —— 公司垫付的 actual_cost 已在场景 23 录关联费用时累加了。
- 字段：`payment_requests.source_request_item_id`（FK → policy_request_items.id），由 `_trigger_advance_refund_if_fulfilled` 创建 PaymentRequest 时回填。

**结果**：客户垫付 1350、厂家拨 1350、还客户 1350：
```
arrival_amount = 1350
actual_cost   = 1350 (这一步加上)
fclass_diff   = 0 ✓ （公司净影响 0，符合"经手"语义）
```

详见 `policies.md` 场景 7。

---

## 资金流向图（agent 记忆图）

```
          ┌─────────────── 客户回款 ────────────────┐
          │                                         ▼
          │                                     ┌────────────┐
          │           厂家政策到账 ───────────→│ 品牌 F 类  │
          │                                     └─────┬──────┘
          │                                           │ 内转
          │                                           ▼
  ┌─────────────┐  调拨   ┌──────────────┐  扣款   ┌──────────┐
  │   master    │───────→│  品牌 cash   │────────→│  业务员  │
  │  现金池     │        │              │  工资   │          │
  └──────┬──────┘        └──────┬───────┘         │  (垫付)  │
         │                       │                  │  返还   │
         │                       ├──→ 发工资        └────┬─────┘
         │                       ├──→ 付政策垫付         │
         │                       ├──→ 付稽查回收         │
         │                       ├──→ 还融资利息         │
         │                       └──→ 还融资本金         │
         │                                               │
         │        分货收款（share_out）← 扣 payment_to_mfr
         │
         │                          ┌──────────────────┐
         └──(采购付款记录)────────→│  payment_to_mfr  │←──(撤销采购反扣)
                                    └──────────────────┘
                                          ▲
                                          │ A3 扣 / B2 加
                                          │
                                    ┌──────────────┐
                                    │  InspectionCase  │
                                    │  execute 时动  │
                                    └──────────────┘

  ┌─────────────┐            ┌────────────────────┐
  │ 品牌 financing│──还款──→│   品牌 cash         │
  └─────────────┘            └────────────────────┘
       ▲
       │ 融资放款（每月本金）
       │
```

---

## Agent 行动前的资金流自检清单

每次准备调"动账"接口，Agent 必须在**确认卡片里列清**：

1. ✅ 哪个账户（master / 品牌 cash / F 类 / financing / payment_to_mfr）
2. ✅ 加还是减（credit / debit）
3. ✅ 多少钱
4. ✅ 关联什么实体（related_type + related_id）
5. ✅ 是否可逆（如不可逆，强调给用户）
6. ✅ 余额够不够（预先调 `GET /accounts/{id}` 看）

示例卡片内容：
```
【确认执行】财务批准 5 笔收款
订单：SO-20260428-xxx 张三烟酒店
动账：master 现金池 +¥23,000（credit × 5 条流水）
触发：5 条 Receipt 转 confirmed
连带：订单状态 → fully_paid + completed，生成 Commission ¥920
不可逆：批准后 Receipt 只能红冲不可撤销
[确认批准] [驳回]
```

---

## 动账失败恢复的业务准则

Agent 调动账接口时遇到错误：

| 错误 detail 里的关键词 | 含义 | Agent 应对 |
|---|---|---|
| "余额不足" | 账户钱不够 | 建议用户先调拨，提示缺口 |
| "未配置 master 现金账户" | seed 没跑 | 提示联系管理员跑 seed |
| "品牌 F 类账户不存在" | 该品牌缺账户配置 | 提示财务去"账户管理"建 |
| "该订单提成已被其他工资单领取" | 唯一约束冲突 | 告诉用户不要自动重试 |
| "账户 XXX 余额不足 ¥YYY" | 可计算缺口 | 展示缺口，建议调拨 |
| "需要先审批付款才能收货" | 采购流程错 | 提示财务去审批采购 |
| "金额不符" | 精确匹配失败 | 告诉用户明细不匹配，不要调整规模 |

**铁律**：Agent 不要自动重试动账接口（可能重复动账）。报错后必须重新收集用户意图。
