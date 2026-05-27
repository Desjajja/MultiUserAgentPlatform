# 政策模板 / 政策申请 / 政策兑付 / 政策到账

政策是白酒行业核心概念：厂家给经销商的优惠（赠品、回款补贴、政策物料等），经销商先承诺给客户、再向厂家申请兑付。

## 四个核心表

```
PolicyTemplate（政策模板）       厂家定义的政策规则（品牌/箱数区间/赠品/折扣）
  └─ PolicyTemplateBenefit       模板包含的权益条目

PolicyRequest（政策申请）        一个订单对应一个申请，包含"我要兑现这些权益"
  └─ PolicyRequestItem           具体权益条目（兑付状态：pending → applied/arrived → fulfilled → settled）

PolicyClaim（政策结算/理赔）     汇总多笔申请一起向厂家报账
  └─ PolicyClaimItem             理赔明细

ClaimSettlementLink              Claim 与厂家 ManufacturerSettlement 到账的关联
```

## PolicyRequestItem 的生命周期

```
pending     刚建，未出物料
  ↓ (POST /policies/fulfill-materials 从品鉴仓扣库存)
applied     物料已出库，待确认到账
  ↓ (POST /policies/requests/confirm-arrival 厂家到账确认)
arrived     已记厂家到账，待上传兑付凭证
  ↓ (POST /policies/requests/{id}/submit-voucher 提交兑付凭证 + 自动建 PENDING PaymentRequest)
fulfilled   已兑付，待财务归档
  ↓ (POST /policies/requests/confirm-fulfill 财务归档)
settled     已归档
```

**强约束**（policies.py:1397）：`submit-voucher` 只接受 `arrived/fulfilled` 前置状态。pending/applied 传过去会被 400 拒掉 —— Agent 不要跳步。

**注意**：`fulfilled` 和 `arrived` 是两件事：
- `fulfilled` = 给客户了（物料出库 or 给他让利）
- `arrived` = 厂家把兑付款打给我们了（钱进 F 类账户）
- 如果先完成兑付、后补记厂家到账，系统会保留 `fulfilled/settled` 状态，只补写 `arrival_amount / arrival_at`。

## Agent 场景 1：查政策模板

用户："青花郎现在有什么政策？"

```
GET /api/policy-templates/templates?brand_id=<青花郎 id>&is_active=true
```

返回列表，Agent 展示每个模板的：名称、箱数区间、指导价、到手价、赠品。

**注意**：销售员看不到 `internal_valuation`（内部估值），API 已自动脱敏。

## Agent 场景 2：匹配政策（建单前）

用户建单时 Agent **自动调**：

```
GET /api/policy-templates/templates/match?brand_id=X&cases=5&unit_price=900
```

后端按品牌 + 箱数区间 + 价格匹配有效模板。可能返回 0 / 1 / 多条。

- **0 条** → Agent 告诉用户"没有匹配的政策，这单无法出库。请先联系老板申请政策模板"
- **1 条** → Agent 自动选用
- **多条** → Agent 推卡片让用户挑

**铁律：匹配到模板后必须接着拉详情**，把政策项明细完整推到建单确认卡片：

```
GET /api/policy-templates/templates/{template_id}
→ 返回 benefits[] = 每条权益的「政策项名 / 数量 / 单位 / 单位价值 / 合计 / 兑付方式」
```

建单确认卡片**必须**包含这张明细表，不能只显示"匹配政策：青花郎 VIP 5-10 箱"就让用户点确认 —— 老板要的就是看清这单具体能拿到哪些赠品 / 返现 / 物料、各值多少钱、怎么兑付。详细卡片模板见 `agent-playbook.md` 场景 2.4。

`benefits[]` 的字段语义：

| 字段 | 含义 |
|---|---|
| `name` | 政策项名（"品鉴会餐费" / "品鉴酒" / "庄园之旅" / "季返" 等）|
| `quantity` | 数量 |
| `unit` | 单位（场 / 瓶 / 次 / 件）|
| `unit_value` | 单位价值（¥）|
| `total_value` | 合计（= quantity × unit_value，**Agent 不要自己算**，原样取后端返回值）|
| `fulfill_method` | 兑付方式 enum：`报账 / 物料 / 直接报销 / 现金 / 季返 / 年返` 等，**原样**展示 |

## Agent 场景 3：建政策申请

建单时前端通常自动带出一个 PolicyRequest（见 `orders.md`）。单独建：

```
POST /api/policies/requests
{
  "order_id": "...",
  "policy_template_id": "...",
  "brand_id": "...",
  "request_source": "manual",             // order / hospitality / market_activity / manual
  "approval_mode": "internal_only",       // internal_only / internal_plus_external
  "usage_purpose": "青花郎5月客情赠酒",
  "advance_payer_type": "employee",
  "advance_payer_id": "<业务员 id>"
}
```

后端会自动按 `policy_template_id` 把模板权益复制成 `PolicyRequestItem`。

限制：
- 非订单类政策申请必须绑定已激活模板
- 不允许自由录入 `request_items`
- `request_source='f_class'` 已禁用；F 类额外费用请走 `ExpenseClaim`

**advance_payer**：谁垫付政策成本。业务员自己掏钱垫给客户的礼品 → `employee + employee_id`；客户先垫付 → `customer + customer_id`；公司垫付 → `company`。

## Agent 场景 4：兑付物料（出库 — **从品牌的 tasting 仓**）

业务员/老板把政策物料发给客户。**唯一来源是该品牌的品鉴仓**（policies.py:689-697 硬编码 `Warehouse.warehouse_type='tasting' AND brand_id=pr.brand_id`），Agent 不能选别的仓。

```
POST /api/policies/requests/{request_id}/fulfill-materials
{
  "items": [
    {
      "request_item_id": "<PolicyRequestItem id>",
      "product_id": "<赠品 product id>",
      "quantity": 1,
      "quantity_unit": "箱"
      # 注意：旧版本接口示例里有 warehouse_id，**新代码完全忽略这个字段** —— 系统永远从该品牌的 tasting 仓出
    }
  ]
}
```

**前置硬约束**（policies.py:683-697）：
- 关联订单必须 `status='completed'`（即财务已确认收款）—— 没收款不能兑付物料
- 政策申请必须有 `brand_id`（绑定品牌）
- 该品牌**必须有** `warehouse_type='tasting'` 的仓库；没有 → 400 "该品牌没有品鉴物料仓库"

后端：
- 扣品鉴仓库存（StockFlow 类型 = `outbound`）
- PolicyRequestItem.fulfilled_qty += bottles
- fulfilled_qty ≥ quantity 时 status → `fulfilled`

**Agent 看到 400 "该品牌没有品鉴物料仓库"**：先帮用户去 `inventory/warehouse-center` 给该品牌建一个 `warehouse_type='tasting'` 的仓，再帮他采购品鉴酒入仓（参见 `inventory-purchase.md` 类 ①.5），再回来 fulfill-materials。

## Agent 场景 5：提交兑付凭证

物料出完，业务员提交照片凭证。Agent 引导用户发图 → 上传 → 调：

```
POST /api/policies/requests/{id}/submit-voucher
{
  "item_id": "...",
  "voucher_urls": ["..."],
  "actual_cost": 45.00      // 实际花费（可能低于 standard_total，差额是政策盈余）
}
```

后端算 `profit_loss = standard_total - total_value - actual_cost`。

## Agent 场景 6：财务确认归档（幂等）

```
POST /api/policies/requests/{request_id}/confirm-fulfill
{ "item_id": "..." }
```

**关键改动**：
- 已 settled 的直接返回 `{"detail": "该项已归档，无需重复确认"}`（幂等）
- `confirm-fulfill` 只做兑付归档，不再写 `settled_amount`

Agent 如果收到 200 + "已归档"的返回，告诉用户"该项早已归档"。

## Agent 场景 7：政策到账对账（F 类账户收款）

厂家打款到公司 F 类账户，财务登记到账。**两条路径**：单条手工登记，或 Excel 批量对账。

### 路径 A：手动登记单条

```
POST /api/policies/requests/confirm-arrival
{
  "items": [
    {
      "item_id": "<PolicyRequestItem id>",
      "arrived_amount": 45.00,
      "billcode": "银行单据号"
    }
  ],
  "salary_items": [...]    // 工资补贴到账（可选，见 payroll.md）
}
```

后端（policies.py:1270-1320）：
- 未归档的条目（applied）会推进到 `arrived`；已 `fulfilled/settled` 的条目只补 `arrival_amount/arrival_at` 字段，不改 status
- **F 类账户加钱的分支条件**：仅当 `PolicyRequest.request_source='f_class'` 时，才会写 `account_type='f_class'` 的账户 `balance += arrived_amount` + 一条 `related_type='f_class_arrival'` 的 fund_flow
- **普通政策模板（非 f_class）confirm-arrival 只写 PolicyRequestItem 的 arrival 字段，不动账户**——这种政策的厂家结算款会走政策理赔单（PolicyClaim → 厂家结算分配）单独入账
- 工资补贴 salary_items 走 `ManufacturerSalarySubsidy.confirmed` 路径（payroll.md）

**Agent 关键提醒**：用户对同一条点"确认"多次是**安全的**（后端幂等跳过），不会重复加钱。

### 路径 B：Excel 对账（推荐，大批量）

厂家发来到账单（Excel，xls/xlsx 都支持，老 OLE2 格式也行），财务在前端「财务中心 → 资金往来 → 厂家结算 Tab → 导入 Excel 对账」上传。

**Excel 列约定（前两行表头）**：
| 列号 | 字段 | 用途 |
|---|---|---|
| 1 | billcode | 单据号（落到 `arrival_billcode`） |
| 2 | pronumber | 方案号（核心匹配键，对应 `PolicyRequestItem.scheme_no`） |
| 3 | dbilldate | 单据日期（匹配 `applied_at` 同天） |
| 7 | memo | 摘要（最后一档匹配 `PolicyRequestItem.name`） |
| 8 | income | 收入金额（核心金额） |
| 11 | remarks | 备注（用 difflib 近似度 ≥0.8 匹 `notes`） |

**接口**：
```
POST /api/manufacturer-settlements/import-excel?brand_id=<brand>
Body: multipart/form-data, file=Excel
```

**只做预览，不动账**。返回结构：
```json
{
  "total_rows": 326,
  "auto_eligible_count": N, "auto_eligible_amount": ...,
  "needs_review_count":  N, "needs_review_amount":  ...,
  "unmatched_count":     N, "unmatched_amount":     ...,
  "matched":   [ {excel_row, scheme_no, amount, cost_total, diff, auto_eligible, block_reason, matched_request_item_id, ...} ],
  "unmatched": [ {excel_row, scheme_no, amount, reason, ...} ]
}
```

**五步匹配链（每行依次尝试，唯一匹中即用，多匹中或全不匹中进未匹配）**：
1. 方案号 → `scheme_no` 严格相等
2. 单据日期 → `applied_at` 同一天
3. 金额 → 关联费用合计或面值
4. 备注 → `notes` difflib 近似度 ≥0.8
5. 摘要 → `name` 严格相等或包含

**已入账过的方案号（arrival_at IS NOT NULL）直接跳过整行**，不出现在任何列表里。

**金额对比逻辑**：
- 优先：`PolicyItemExpense.cost_amount` 总和（"添加关联费用"录的实际花费）
- 回退：`PolicyRequestItem.total_value`（政策面值，比如季返直接面值就是应收）
- 相等（差额 ≤0.001）→ `auto_eligible=true`，可一键入账
- 不等 → `auto_eligible=false`，`block_reason` 写明差额，需人工

### Excel 入账（批量自动）

预览后用户点"批量入账"，调：
```
POST /api/manufacturer-settlements/apply-reconcile
{
  "brand_id": "<brand>",
  "items": [
    { "excel_row": 2, "scheme_no": "F34038480",
      "matched_request_item_id": "<item-uuid>", "amount": 1500,
      "billcode": "BX-1", "memo": "常规品鉴会" },
    ...
  ]
}
```

服务端 **不信前端**，每条再次校验：
- 政策项存在 + 属于 body 品牌
- 重新算 `cost_total`（关联费用合计），不够回退面值
- 余额对得上、状态可推进、`arrival_at` 为空
- 通过则：F 类 `+amount`、`arrival_amount=amount`、`fulfill_status: applied→arrived`、`actual_cost` 只在原本为 0 时回填、写 fund_flow（`related_type=f_class_arrival`，notes 标"Excel 对账自动入账"）、写 audit_log（`reconcile.auto_apply`）

返回：
```json
{ "applied": N, "skipped": N, "skipped_reasons": ["行 X ..."], "total_amount": ... }
```

### Excel 手动微调（匹错时）

预览结果里任何一行都能改匹配：前端有"调整匹配"按钮，调用：
```
GET /api/reconcile-candidates?brand_id=<brand>&keyword=<可选>
```
返回该品牌**未到账**的政策项（含 `ref_amount` = 关联费用合计或面值），用户选一条改完后**只更新前端预览状态**，最后还是统一走"批量入账"。

**注意路由顺序**：`reconcile-candidates` 不能挂在 `/manufacturer-settlements/` 前缀下，会被 `/manufacturer-settlements/{settlement_id}` 路由吃掉。当前是独立 `/reconcile-candidates`。

### 利润台账自动算政策盈亏

不需要额外写"政策盈亏"科目流水。利润台账 dashboard 的 `fclass_diff` 科目实时按公式聚合：

```
fclass_diff = SUM(arrival_amount) - SUM(actual_cost)
              [request_source=f_class, arrival_amount>0, arrival_at 在区间]
```

所以只要保证 `actual_cost` 真实反映成本、`arrival_amount` 反映厂家实际打款，差额就是该品牌政策盈亏。**Agent 不要替用户算这个差，让前端报表显示**。

## Agent 场景 7.5：公司垫付的政策费用（线下先付，ERP 补登记）

公司账户**真花钱**给经销商办活动（庄园之旅机票/酒店、品鉴会场地费等），不是"少收换垫付"那种。

### 业务模型

```
① 公司线下先付机票 ¥8000（财务刷公司卡）
② 财务回 ERP，在「政策申请详情 → 添加关联费用」录入：
   { name="机票", cost_amount=8000, payer_type="company" }
③ 保存即动账：
   - 品牌现金账户 -8000
   - 写 fund_flow（related_type='policy_company_expense'）
   - PolicyRequestItem.actual_cost += 8000
④ 厂家拨款回来 → 走对账场景 7 → F 类账户 +X
⑤ 利润台账自动 = arrival_amount(X) - actual_cost(8000)
```

### 接口

**新建关联费用**（payer_type='company' 时立刻扣账）：
```
POST /api/policies/request-items/<item_id>/expenses
{
  "name": "机票",
  "cost_amount": 8000,
  "payer_type": "company",       // 关键：company 才动账
  "reimburse_amount": 10000      // 厂家应报销额（仅展示用，不动账）
}
```

**修改**：
```
PUT /api/policies/expenses/<expense_id>
```
- 服务端按 `delta = new_company_amount - old_company_amount` 自动差额冲销
- 改大/改小都正确处理流水

**删除**：
```
DELETE /api/policies/expenses/<expense_id>
```
- 删 `payer_type=company` 的条目时，自动**反向**写 credit 流水，现金账户回滚

### 业务规则（强制门禁）

- 政策项 `fulfill_status='settled'` 时**禁止**新建/修改/删除关联费用（避免冲销已审到账金额）
- 品牌**必须**有 `account_type='cash' AND level='project'` 的账户，否则 400
- 现金账户**余额不足**直接 400 拒绝（不允许透支）
- `actual_cost` 累加值 `max(0, current + delta)`，永远不会为负

### 三种 payer_type 对比

| payer_type | 含义 | 录入时动账？ | 后续付款 |
|---|---|---|---|
| `company` | 公司真金白银付出去（机票/酒店/场地） | ✓ 扣品牌现金 | F 类回款时利润台账自动算盈亏 |
| `employee` | 业务员先垫 | ✗ 只登记 | submit-voucher 后自动建 PENDING `FinancePaymentRequest`，审批中心批准才扣现金 |
| `customer` | 客户先垫 | ✗ 只登记 | 同上，客户 |

详见 `fund-flows-catalog.md` 场景 23（`policy_company_expense`）。

### Agent 操作要点

- 录关联费用时**必须**问清"谁付的钱"，按答案选 `payer_type`
- `payer_type=company` 之前**先查账户余额**：`GET /api/accounts?brand_id=X&account_type=cash`，余额不够提示用户走调拨（master → 品牌 cash），别让录入接口直接 400
- 录完后告诉用户"已扣品牌现金 ¥X，等厂家拨款时利润台账自动算盈亏"
- 已到账（`arrival_at` 不空）的政策项不要再录关联费用（虽然代码只挡 settled，但业务上应该挡 arrived/fulfilled）

## Agent 场景 8：policy_claim（向厂家集中报账）

多个 PolicyRequestItem 汇总成一个 Claim 向厂家报账。

```
POST /api/policies/claims
{
  "brand_id": "...",
  "manufacturer_id": "...",      // 厂家 supplier id
  "claim_batch_period": "2026-04",
  "items": [
    { "request_item_id": "...", "declared_amount": 45.00 },
    ...
  ]
}
```

这个一般**财务/老板**在前端操作，Agent 较少主动做。

## Agent 场景 8.1：厂家总到账主账

普通模板政策的厂家总到账，当前主口径先走：

1. `POST /api/manufacturer-settlements` 记录厂家到账
2. 系统同步把金额记入品牌 F 类账户
3. 后续 `allocation-confirm` 分配到理赔单
4. `confirm-arrival` 再补记具体政策项的到账状态/金额

历史 `request_source='f_class'` 旧条目仍兼容在 `confirm-arrival` 里直接进 F 类账户。

## 垫付返还（关键业务）

如果 PolicyRequestItem 的 `advance_payer_type=employee`，政策兑现后公司要**返还业务员垫付的钱**。

后端自动触发 `_trigger_advance_refund_if_fulfilled`（条件：`fulfill_status in ('fulfilled','settled')` + 有 advance_payer），生成 `FinancePaymentRequest`（垫付返还申请）到审批中心。

Agent 告诉业务员："垫付返还申请已生成，财务批准后打款给你。" 返还的钱从 `payment_to_mfr` 账户 / 品牌现金账户扣。

## 常见错误

| detail | 解释 |
|---|---|
| "政策明细项不存在" | item_id 错或不在 RLS 可见范围 |
| "状态为 'pending'，需要先提交兑付凭证" | 要先 submit-voucher 才能 confirm-fulfill |
| "该项已归档，无需重复确认" | 幂等返回，正常 |
| "品牌未配置 F类账户" | 财务要先到账户管理建 F 类项目账户 |
| "未配置公司总资金池" | 建 master 现金账户 |

## 时间字段

- `created_at` / `updated_at` / `arrived_at` / `confirmed_at` / `fulfilled_at`：都是 UTC，展示按东八区格式化

## 特殊模板：brand_id=NULL 通用模板

`policy_templates.brand_id IS NULL` 表示**全品牌通用模板**（RLS 对所有员工可见）。Agent 查询时要注意把这种模板也纳入匹配结果。

---

## AI Agent 调用 SOP（政策类 L2 操作）

| 业务动作 | 端点 | 风险等级 | Agent 调用方式 |
|---|---|---|---|
| 查政策申请列表 | `GET /api/policies` 或 `query.policies` | L0 | 直调 |
| 提交政策审批 | `POST /api/policies/{id}/submit-internal` | L1 | 直调（推荐带 idempotencyKey） |
| 老板审批政策 | `POST /api/policies/{id}/approve-internal` | L1 | 直调（推荐 Gateway） |
| 政策物料出库 | `POST /api/policies/{id}/items/{item_id}/ship` | L1 | 直调 |
| 上传兑付凭证 | `POST /api/policies/{id}/items/{item_id}/upload-fulfill-voucher` | L0 | 直调 |
| **确认政策到账** | `policies.confirm_arrival` | **L2** | **Gateway dryRun + token** |
| **确认政策兑付归档** | `policies.confirm_fulfill` | **L2** | **Gateway dryRun + token**。前置：关联订单 `payment_status='fully_paid'`，否则 400 |
| **公司垫付费用录入** | `policies.create_item_expense (payer=company)` | **L2 不可逆** | **drafts 两阶段强制**。单笔 ≥ ¥50,000 直接 400，需拆 |
| 业务员/客户垫付费用录入 | `policies.create_item_expense (payer=employee/customer)` | L1 | 直调（不动账，仅登记） |
| 公司垫付费用改金额 | `PUT /api/policies/expenses/{id}` | **L2** | 建议走 drafts |
| 公司垫付费用删除 | `DELETE /api/policies/expenses/{id}` | **L2** | 建议走 drafts |

**关键交互模板**（公司垫付，对应剧本场景 17.5）：

```
1. drafts.create  payload={ action: "policies.create_item_expense",
                            payload: { item_id, name, cost_amount, payer_type: "company", ... } }
2. 卡片预览 draft.payload + 后端预估副作用（账户 -X、利润影响）
3. /api/confirm-tokens(action=drafts.commit, payload={draft_id})  → token
4. drafts.commit  payload={draft_id} + X-User-Confirm: <token>
```

详见 `ai-gateway.md` §5 路由表 + 范式 C、`business-rules.md` §零点五、剧本场景 17.5 / 17 / 18。


