# 账户资金 / 资金流水 / 调拨 / 融资

## 账户模型

```
Account（账户）
├─ account_type: cash / f_class / financing / payment_to_mfr
│   ⚠️ 「master 现金池」不是独立 account_type，是 account_type='cash' AND level='master' 的组合
├─ level: master / project / store / mall
├─ brand_id: 品牌归属（master / mall 可为 NULL）
├─ warehouse_id: 门店/商城账户绑定的仓库（unit 级账户）
├─ balance: 当前余额
└─ is_active
```

### 当前系统的三层账户视图

```
master（公司总资金池）
  ├─ project（品牌账户：现金 / F类 / 融资 / 应付厂家）
  ├─ store（门店现金账户：按门店独立）
  └─ mall（商城现金账户：当前主要是统一资金池 MALL_MASTER）
```

说明：
- `store` / `mall` 账户已经在代码和财务总览页中单独展示，不再和品牌账户混在一起。
- 门店新增时会自动生成对应 `store cash` 账户，不走手工建账。
- 商城当前仍保留统一资金池思路，但在总览里属于“经营单元账户”，不是品牌账户。

### 账户类型含义

| account_type | 作用 | 谁进谁出 |
|---|---|---|
| `cash` | 现金账户 | 客户回款 / 发工资出去 / 付政策垫付出去；按 `level` 区分：`level='master'` 就是总资金池，`level='project'` 是品牌现金 |
| `f_class` | F 类账户 | 政策到账（厂家打款）进这里 |
| `financing` | 融资账户 | 融资款进，每期利息出 |
| `payment_to_mfr` | 应付给厂家 | 采购付款进（代表已付给厂家），撤销采购时返还 |

**master 现金池怎么查**：`SELECT * FROM accounts WHERE level='master' AND account_type='cash'`（finance.py:230-234 强校验，没配会 400 阻断收款入账 / 拨款 / 部分财务流程）。**没有 `master_cash` 这个 type**。

**关键**：master 账户（`level='master' AND account_type='cash'`）的可见性受 RLS policy `app_current_can_see_master()` 控制 —— salesman 角色的 JWT 落 `can_see_master=false`，policy 拦截；boss/finance/admin 的 JWT 落 `true`，可见。Agent 提示"该账户不可见"时直接说"权限不足"，不要假装账户不存在。

## Agent 场景 1：查账户余额

### 单个查
```
GET /api/accounts?brand_id=<青花郎>&account_type=cash
```

返回青花郎的现金账户列表。Agent 给 boss / finance 展示：`青花郎现金账户：¥123,456`。

### 总览（按品牌聚合）
```
GET /api/accounts/summary
```

返回：
```json
{
  "master_balance": 500000,
  "unit_balance": 88000,
  "project_total": 345000,
  "grand_total": 933000,
  "has_master_cash_account": true,
  "blocking_issues": [],
  "master_accounts": [...],
  "unit_accounts": [...],
  "brand_groups": [
    {
      "brand_id": "...",
      "brand_name": "青花郎",
      "cash_balance": 123456,
      "f_class_balance": 45000,
      "financing_balance": 0,
      "total": 168456,
      "accounts": [...]
    }
  ]
}
```

Agent 用来回答：
- “公司总资金池还有多少”
- “各品牌现金/F类/融资分别多少”
- “门店/商城经营单元资金池有没有余额”

### 单个账户流水
```
GET /api/accounts/fund-flows?account_id=<acc-id>&date_from=2026-04-01&date_to=2026-04-30&skip=0&limit=50
```

每条 FundFlow 有：`amount / flow_type(credit/debit) / balance_after / related_type / related_id / created_at`。

Agent 用于对账、追溯"这 ¥1000 是哪来的"。

## Agent 场景 2：品牌间调拨

老板说“从 master 调 10 万给青花郎现金”或“给华致门店账户拨 2 万备用金”。

### 2.1 申请调拨

```
POST /api/accounts/transfer
{
  "from_account_id": "<master cash id>",
  "to_account_id": "<青花郎 cash id 或 门店 cash id>",
  "amount": 100000,
  "reason": "4 月发工资"
}
```

返回 TransferRequest `status=pending`。

### 2.2 审批调拨

```
POST /api/accounts/transfers/{id}/approve       # 或 reject
```

只有 boss 能批。批准后：
- `from_account.balance -= amount` + FundFlow
- `to_account.balance += amount` + FundFlow
- status → `approved`

### Agent 引导

1. 用户"调 10 万到青花郎现金"
2. Agent 查一下 from/to 账户 → 确认 master 余额够
3. 卡片确认："从 Master 现金 ¥500K → 青花郎现金 / 华致门店现金（当前 ¥23K），金额 ¥100K。确认？"
4. 确认后调 `POST /api/accounts/transfer`
5. 告诉用户"已申请调拨，等老板批准"
6. 如果当前用户就是老板，Agent 再推一张审批卡片让他直接点批准

限制：
- 只能从 `master` 拨到 `project/store/mall`。
- `store/mall` 只允许 `cash` 账户接收拨款。
- `f_class` 和 `payment_to_mfr` 不能作为调拨目标账户。

### 2.3 待审批列表

```
GET /api/accounts/pending-transfers
```

Agent 推送给老板 / 财务："有 N 笔调拨待审"。

## Agent 场景 3：手工加流水（反向凭证）

财务/boss 发现账目有误，手工调整：

```
POST /api/accounts/fund-flows
{
  "account_id": "...",
  "flow_type": "credit",       // credit=加 / debit=扣
  "amount": 500,
  "notes": "补记 4 月忘记登记的小额回款",
  "related_type": "manual_adjustment",
  "related_id": null
}
```

**Agent 关键提醒**："手工加流水会直接改账户余额，**不可逆**。请确认必要（走正规业务流程更安全）。只有 boss/finance 可操作。"

## 资金流向（所有路径）

```
客户回款 ──→ Master 现金池 ──(调拨)──→ 品牌现金账户
                                       ├──→ 发工资
                                       ├──→ 付付款申请 / 垫付返还
                                       ├──→ 付稽查回收成本
                                       └──→ 采购（部分） 

厂家政策兑付 ──→ 品牌 F 类账户 ──(调拨)──→ 品牌现金 / Master

厂家工资补贴 ──→ 品牌现金账户（直接加）

采购付款 ──→ payment_to_mfr 账户（记账用，表示"已付给厂家"）
          ←── 采购撤销退回

融资款 ──→ 品牌融资账户 ──(归还本息)──→ 出去
```

## 融资单（financing_orders）

公司从融资平台借钱。

### 建融资单
```
POST /api/financing-orders
{
  "brand_id": "...",
  "financing_account_id": "<该品牌融资账户>",
  "principal": 1000000,
  "interest_rate": 0.006,          // 月利率
  "period_months": 6,
  "start_date": "2026-04-01"
}
```

后端：
- 融资账户 `balance += principal` + fund_flow
- 生成每月还款计划（FinancingRepayment）

### 查利息
```
GET /api/financing-orders/{id}/calc-interest
```

返回本息总计、已还、剩余。

### 提交还款
```
POST /api/financing-orders/{id}/submit-repayment
{
  "repayment_id": "...",
  "amount": 170000,
  "from_account_id": "<品牌现金 id>"
}
```

status=pending。

### 审批还款
```
POST /api/financing-orders/repayments/{id}/approve
```

批准后：
- 品牌现金账户扣 amount
- 融资账户扣 amount（本金部分） + 记利息支出（进利润台账"融资利息"科目）
- 如果全部还清 → FinancingOrder.status=cleared

### 退仓还款
采购退货后，厂家退款 → 抵扣融资本金：

```
POST /api/financing-orders/{id}/submit-return
{ "return_amount": 30000 }
```

Agent 一般不主动用。

## 报销申请（expense_claims）

员工向公司报销，不走工资条。**2026-05-21 起入口重组**：

| 入口 | 谁能看 | 用途 |
|---|---|---|
| ERP 顶部菜单「**报销申请**」(`/finance/expenses`) | 任意登录员工 | 自助申请 + 自查进度；普通员工只看「报销单」Tab；admin/boss/finance 多看一个「日常费用」Tab（公司直付日常开销 Expense 流程）|
| 小程序 `/pages/salesman-expense/salesman-expense` | salesman | 移动端入口 |
| ERP「审批中心 → 综合审批 → 报销待审」Tab | boss/finance/hr | **唯一审批入口**（approve / reject 按钮只在这里）|
| ERP「报销申请」页内的付款类按钮 | 仅 admin/boss/finance | 后续 L2 动账（pay / apply / confirm-arrival / fulfill / settle）|

**Agent 引导任意员工申请**：推 Form 卡片收集参数 → POST `/api/expense-claims` → 告诉用户"已提交，等审批中心审批"。不替老板审批，不直调付款类端点。

### 流程

```
建单 (pending) → 审批 (approved) → 申请厂家 (applied)
→ 厂家到账 (arrived) → 兑付给员工 (fulfilled) → 付款 (paid) → 结算 (settled)
```

### 建报销（L0，任意员工）
```
POST /api/expense-claims
{
  "claim_type": "daily",            // daily / f_class / share_out
  "brand_id": "...",                // f_class & share_out 必填；daily 可选
  "title": "去西安拜访客户出差",
  "description": "高铁+酒店",
  "amount": 500,
  "notes": ""
}
```

后端权限：`boss / finance / salesman / sales_manager / hr / warehouse / purchase / store_manager` 都能调。

### 审批（L1，只能 boss/finance 在审批中心点）

```
POST /api/expense-claims/{id}/approve   ← 不调，让用户去 /approval/finance 操作
POST /api/expense-claims/{id}/reject
```

### 付款（L2 不可逆，drafts 强制）

```
1. drafts.create  payload={ action: "expense_claims.pay",
                            payload: { claim_id, account_id, amount } }
2. 卡片预览 → /api/confirm-tokens(action=drafts.commit) → token
3. drafts.commit  payload={draft_id} + X-User-Confirm
```

## 日常费用（expenses，跟 ExpenseClaim 不要混）

公司**直付**的日常开销 —— 差旅垫公账 / 办公用品 / 水电 / 场地费 / 物料；财务直接录入，不走员工发起，不进飞书小程序。

**入口**（2026-05-21 调整）：
- ERP 顶部「报销申请」→ Tab「**日常费用**」（仅 admin/boss/finance 看得见）
- 不在小程序里出现

**关键区别**：

| 维度 | `/api/expense-claims`（员工报销）| `/api/expenses`（日常费用）|
|---|---|---|
| 谁发起 | 任意员工（提自己垫付的） | 财务/老板直接录公司付款 |
| 入口 | 顶部「报销申请」→「报销单」Tab + 小程序 | 顶部「报销申请」→「日常费用」Tab |
| brand_id | f_class/share_out 必填，daily 可选（按业务员品牌默认）| **必填**（决定从哪个品牌现金账户扣款）|
| 钱归谁 | 员工垫付 → 公司付给员工 | 公司直接付给供应商/服务方 |
| 主要流转 | pending → approved → applied → arrived → fulfilled → paid → settled（最长链）| pending → approved → paid（简短链）|

### 建日常费用（L1，仅 admin/boss/finance）
```
POST /api/expenses
{
  "brand_id": "<必填>",
  "amount": 3500,
  "description": "4 月办公室水电",
  "applicant_id": "<可选，记是谁报的>",
  "payment_date": "2026-04-15",
  "voucher_urls": ["..."],
  "category_id": "<可选>"
}
```

前端 ExpenseList「日常费用」Tab Modal **第 1 项就是「所属品牌」下拉**（必填）；右上角全局品牌过滤器若已选会自动预填。Agent 通过 API 调时记得显式传 `brand_id`。

### 审批（L1，审批中心）

```
POST /api/expenses/{id}/approve   ← 不直调，让用户去 /approval/finance 操作
POST /api/expenses/{id}/reject
```

### 付款（L2 不可逆，drafts 强制）

```
1. drafts.create  payload={ action: "finance.expenses.pay",
                            payload: { expense_id, payment_account_id, payment_voucher_urls } }
2. 卡片预览（动账：品牌现金 -amount）→ /api/confirm-tokens → token
3. drafts.commit + X-User-Confirm
```

**铁律**：
- `expense_claims.pay` 跟 `finance.expenses.pay` 是**两个不同的 draft action**，别用错。前者付给员工（payee=员工银行卡），后者付给供应商（payee=外部账户）。
- Agent 听到"录一笔水电"/"采购办公用品报销" → 走 `/api/expenses`（日常费用）；听到"业务员出差报销"/"分货费用"/"F类政策费用" → 走 `/api/expense-claims`（报销申请）。

## 资金往来页 5 个 Tab 的业务语义（**重要：Agent 必须分清**）

ERP 前端 `/finance/cash-flow` 把 5 个独立账目页合并成一个 Tabs（`CashFlowManage.tsx`），每个 Tab 业务含义不同——Agent 给老板/财务汇报数字时**严禁混用**：

| Tab | 业务语义（**用户 2026-05-21 澄清**）| 后端来源 | 总金额含义 |
|---|---|---|---|
| **客户收款** | 历史所有客户回款流水 | `Receipt`（已 confirmed 的）| 已收回的钱 |
| **对外付款** | 厂家**已经到账**了、但还**没有兑付**给客户 / 业务员 / 公司的待付账款（**厂家对账用**）| `PaymentRequest` 状态 ∈ pending/approved 的 | 待付总额 = 已从厂家收到，但内部尚未付出去的金额 |
| **应收账款** | 两类合计：(1) **已出库未收款**（销售应收：订单 shipped/delivered 但 payment_status 未 fully_paid）+ (2) **公司提前垫付厂家但厂家还未到账**（垫付应收）| `Receivable` + 待返垫付 | 公司应该从外部收回的钱 |
| **应收账龄** | 同应收账款，按到期日 / 建单账龄分档 | 同上 + aging 计算 | 用于催收优先级 |
| **厂家结算** | 厂家给到经销商的 F 类资金到账记录（核销分配前）| `ManufacturerSettlement` | 已入 F 类账户、可分配到 policy item / claim 的总额 |

### 三个跟"应收"有关的概念，**别搞混**

| 概念 | 定义 | 来源表 | 谁的钱 |
|---|---|---|---|
| **客户应收**（receivable，狭义）| 订单已出库 / 送达，但客户没付清 | `receivables` | 客户欠公司 |
| **公司垫付厂家应收** | 公司先帮客户垫付了某笔 F 类政策费用，厂家承诺还但还没到账 | `policy_item_expenses (payer_type=company)` + 关联 PolicyRequestItem 未 arrived | 厂家欠公司 |
| **业务员 / 客户垫付应收** | 业务员或客户先垫了款，等政策到账后通过 `advance_refund` 还给他们 | `payment_requests (payee_type=employee/customer)` 未付的 | 公司欠业务员 / 客户 |

**广义的"应收账款 Tab"** = 前两类合并；**第三类**走 `payment_requests` 在「对外付款」Tab 里展示。

### 对外付款 vs 厂家结算 的关系

```
厂家给经销商打钱（F 类资金）
        ↓
ManufacturerSettlement（厂家结算 Tab 显示）
        ↓ 录入到账
F 类账户 += amount（瞬间动账）
        ↓ 核销分配（apply-reconcile）
  关联到具体的 PolicyRequestItem / PolicyClaim
        ↓ 触发垫付返还（advance_refund）
PaymentRequest（对外付款 Tab 显示）
  payee_type ∈ {customer, employee, company}
        ↓ finance 在审批中心 confirm-payment（L2 走 drafts）
品牌 cash 账户 -amount 真付出去
```

**对外付款 Tab 的总金额 = 已收到厂家钱、但还没付给收款方的"代收待付"账款** —— 老板看这个数字判断"厂家结过账了，咱手上压了多少没及时分发出去"。

**代码对齐情况（2026-05-22 修复）**：

- ✅ 后端 `GET /api/payment-requests?settled_status=arrived`：返回 `request_type='advance_refund' AND status ∈ pending/approved` 的 PR，业务上即"厂家钱已到 F 类账户、但 finance 还没在审批中心 confirm-payment 真付出去"。响应里 `amount_sum` 字段直接给"代收待付总额"。
- ✅ 后端 `GET /api/receivables`：聚合两类：(1) `receivables` 表（销售应收）+ (2) `policy_item_expenses WHERE payer_type='company' AND reimburse_status != 'reimbursed'`（公司垫付未到账）。响应里 `sale_amount` / `company_advance_amount` 两个字段分别给两类合计；items 数组里每条带 `source` ∈ `sale` / `company_advance` + `source_label` 区分。
- ✅ 前端 PaymentList 顶部加摘要卡片（代收待付金额 + 笔数）；ReceivableList 顶部加 3 列摘要（销售应收 / 公司垫付未到账 / 合计），表格加"来源"列。
- 老 PaymentList 表格保留（仅显示 `request_type='general_payment'` 手工建的付款申请）—— Tab label 改为「对外付款（代收待付）」让用户主要看顶部摘要数字。

### Agent 行为约束

- 用户问"我家欠人家多少钱" → 通常指**对外付款**待付总额（公司代收的、还没分发出去的）
- 用户问"人家欠我多少钱" → 通常指**应收账款**总额（销售应收 + 公司垫付应收）
- 用户问"厂家给我们打了多少" → 指**厂家结算** Tab 的累计 settlement_amount
- 任何金额 Agent **不要自己算**，调对应 GET 端点（`/api/payment-requests`、`/api/receivables`、`/api/finance/manufacturer-settlements`）拿后端 total，原样展示

## 应收账款（端点细节）

```
GET /api/receivables?customer_id=X&status=overdue
GET /api/receivables/aging
```

Aging 现在把**未到期**单据单独列示；有到期日的按**逾期天数**分组（0-30/30-60/60-90/90+），没有到期日的按**建单账龄**分组。Agent 给 finance 汇报时不要把未到期金额说成逾期。

## 常见错误

| detail | 解释 |
|---|---|
| "账户余额不足 ¥X" | 付钱时余额不够 |
| "两账户属于不同品牌，不能直接调拨" | 要经 master 中转 |
| "该调拨单已审批，不能重复" | 幂等保护 |
| "你没有查看该账户的权限" | RLS 挡（salesman 看不到 master） |

## Agent 关键提醒

- **所有动账的操作推卡片确认**，不要自动执行
- **手工加流水**要二次确认（"你确定要手工调整账户 X 的余额吗？这不可逆"）
- 涉及**大额（> ¥10 万）** 调拨，Agent 提示"该金额较大，建议告知 boss 当面复核"
- RLS 屏蔽的账户，Agent 不要说"该账户不存在"——说"你的角色没有查看权限"

---

## AI Agent 调用 SOP（账户 / 资金流 / 调拨 / 报销 / 融资）

| 业务动作 | 端点 / operation | 风险等级 | Agent 调用方式 |
|---|---|---|---|
| 查账户列表 | `GET /api/accounts` 或 `query.accounts` | L0 | 直调 |
| 查账户流水 | `GET /api/accounts/{id}/flows` | L0 | 直调（RLS 自动按角色过滤） |
| **品牌内调拨**（免审） | `accounts.transfer (within brand)` | **L2** | **Gateway dryRun + token** |
| **跨品牌调拨**（必审） | `POST /api/accounts/transfer-requests` | L1 | 直调建申请，后续审批走 L1 |
| **审批跨品牌调拨**（动账） | `accounts.approve_transfer` | **L2** | **Gateway dryRun + token** |
| 手工录入流水（调账） | `POST /api/accounts/{id}/manual-entry` | **L2** | **Gateway dryRun + token**（不可逆，老板复核）|
| 查融资单 | `GET /api/financing-orders` | L0 | 直调 |
| 建融资单 | `POST /api/financing-orders` | L1 | 直调 |
| **融资单付款**（动账） | `financing.pay` | **L2 不可逆** | **drafts 两阶段** |
| 查应收 | `GET /api/receivables` | L0 | 直调 |
| 应收注销/坏账 | `POST /api/receivables/{id}/write-off` | **L2** | **Gateway dryRun + token** |
| 查报销列表 | `GET /api/expense-claims` | L0 | 直调 |
| 审批报销（仅状态） | `POST /api/expense-claims/{id}/approve` | L1 | 直调 |
| **报销付款**（员工垫付→公司还）| draft action `expense_claims.pay` | **L2 不可逆** | **drafts 两阶段** |
| 查日常费用列表 | `GET /api/expenses` | L0 | 直调 |
| 录日常费用（公司直付） | `POST /api/expenses` | L1 | 直调（必传 brand_id；仅 boss/finance）|
| 审批日常费用 | `POST /api/expenses/{id}/approve` | L1 | 直调（推荐审批中心人工点）|
| **日常费用付款**（动账） | draft action `finance.expenses.pay` | **L2 不可逆** | **drafts 两阶段** |
| 查利润台账 | `GET /api/finance/profit-ledger` | L0 | 直调 |

**关键交互模板**（同品牌调拨 master→品牌现金，对应剧本场景 22）：

```
# 1. 查 from / to 余额（L0）
query.accounts → 检查 from 余额 ≥ amount

# 2. dryRun 拿动账预览
POST /api/agent/execute
  operation=accounts.transfer
  payload={ from_account_id, to_account_id, amount: 100000, reason }
  dryRun=true

# 3. 卡片预览 → /api/confirm-tokens → 真执行
POST /api/agent/execute
  Headers: { x-user-confirm: <token> }
  operation=accounts.transfer
  payload={ ... }
  dryRun=false
  idempotencyKey=<uuid>
```

**跨品牌调拨**：Agent 不能"一气呵成"——先建调拨申请（L1，业务员/finance 都能建），等 boss 在审批中心确认后才落账。Agent 帮 boss 审批时仍走 L2 范式 B。

**报销付款**（场景 27 扩展）：

```
1. drafts.create  payload={ action: "expense_claims.pay",
                            payload: { claim_id, account_id, amount } }
2. 卡片预览 → /api/confirm-tokens(action=drafts.commit) → token
3. drafts.commit  payload={draft_id} + X-User-Confirm
```

**资金流闭环原则**（重读 `business-rules.md` §十七）：
- 客户回款 → master 现金池
- master → 品牌现金（调拨，L2）
- 品牌现金 → 报销 / 工资 / 政策垫付 / 稽查扣款 / 融资付款（全 L2 不可逆，走 drafts）
- 厂家补贴 → 品牌现金（L2）
- F 类资金 → 品牌 F 账户（L2）

详见 `ai-gateway.md` §5、剧本场景 22 / 17.5 / 27、`business-rules.md` §零点五 + §十四。

