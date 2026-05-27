# Agent 剧本：员工怎么说 → Agent 怎么做

**这份文档的角色**：Agent 听到员工一句自然语言时，按这份剧本**一步一步地**翻译成 API 调用序列。

**使用方式**：Agent 先识别意图（关键词匹配 + 语义判断），找到对应场景，然后**严格按照**剧本里的步骤执行。

**公共前置**（所有场景共用）：
1. 拿当前 `open_id` 调 `/api/feishu/exchange-token` 换 JWT（未绑定则推卡片让**员工本人**填 ERP 用户名+密码，调 `/api/feishu/bind` 绑定后再 exchange）
2. 从 JWT payload 拿 `user_id / role / brand_ids / store_ids / employee_id`
3. 根据角色过滤能做什么（见 `business-rules.md` §一）
4. **身份隔离铁律**：Agent 永远用**当前对话用户**的 JWT 调 ERP，**不复用、不越权、不代别人操作**。详见 `business-rules.md` §零。

**L2 写入类调用通用 SOP**（动账 / 跨模块 / 批量 / 强写 → 详见 `ai-gateway.md`）：

```
1. POST /api/agent/execute  operation=X  dryRun=true     ← 试跑拿 preview
2. 给用户飞书卡片展示 preview，"确认 / 取消"按钮
3. 用户点确认 → IM 后端调 POST /api/confirm-tokens 拿一次性 token
4. POST /api/agent/execute  operation=X  dryRun=false
       Headers: X-User-Confirm: <token>
       Body: { ..., idempotencyKey: <uuid> }                ← 防重复扣账
```

**不可逆动账 SOP**（公司垫付 / 工资发放 / 报销付款 → drafts 两阶段）：

```
1. POST /api/agent/execute  operation=drafts.create  payload={action, payload}  ← 不动账
2. 给用户卡片预览 draft.payload
3. 用户点确认 → /api/confirm-tokens
4. POST /api/agent/execute  operation=drafts.commit  payload={draft_id}  + X-User-Confirm
```

**场景标注**：本剧本里每个写入场景**注明 L0/L1/L2 + 是否需要 drafts**。L0/L1 仍可直调 REST（`POST /api/xxx`），L2 强制走 Gateway。

---

## 场景 1：建客户

**用户话术**（示例）：
- "帮我建个客户，名字叫张三烟酒店"
- "把李四的店录进来，他在青花郎渠道"
- "新客户王五便利店，联系电话 138xxx"

**Agent 步骤**：

1. **识别并收集必填字段**（缺则问用户）：
   - `name` 客户名（必）
   - `customer_type` channel / group_purchase
   - `settlement_mode` cash / credit
   - `brand_id` **salesman 必传**（从全局品牌拿，没选就问）
   - `contact_name / contact_phone`

2. **推飞书 Form 卡片**让用户确认：
   ```json
   {
     "header": {"title": "新建客户"},
     "elements": [
       {"tag": "form", "name": "new_customer", "elements": [
         {"tag": "input", "name": "name", "placeholder": "客户名称 *"},
         {"tag": "select_static", "name": "customer_type", "options": [
           {"text": "渠道客户", "value": "channel"},
           {"text": "团购客户", "value": "group_purchase"}
         ]},
         {"tag": "select_static", "name": "settlement_mode", "options": [
           {"text": "现结", "value": "cash"},
           {"text": "赊销", "value": "credit"}
         ]},
         {"tag": "select_static", "name": "brand_id", "placeholder": "归属品牌 *",
          "options": "<从 GET /api/products/brands>"},
         {"tag": "input", "name": "contact_name"},
         {"tag": "input", "name": "contact_phone"},
         {"tag": "button", "text": "确认建客户", "action_type": "form_submit"}
       ]}
     ]
   }
   ```

3. **用户提交** → Agent 调：
   ```
   POST /api/customers
   {
     "name": "...",
     "customer_type": "channel",
     "settlement_mode": "cash",
     "brand_id": "...",
     "contact_name": "...",
     "contact_phone": "..."
   }
   ```

4. **后端自动**建 `CustomerBrandSalesman` 把客户绑到当前 salesman 身上。

5. **反馈**：`update_card` 改为"✅ 已建客户 {name}，编号 {code}"。

**常见错误**：
- salesman 不传 brand_id → 400 "业务员创建客户必须指定 brand_id"
- brand_id 不在 salesman 品牌范围 → 400

---

## 场景 2：建订单

**用户话术**：
- "给张三烟酒店下 5 箱青花郎，按指导价"
- "李四这单 10 箱五粮液，业务员垫差"
- "王五订 3 箱汾酒，公司让利模式"

**Agent 步骤**：

### 2.1 收集参数

- `customer_id`（模糊搜 `GET /api/customers?keyword=张三`）
- `brand_id`（从全局品牌或客户的 CBS 绑定拿）
- `settlement_mode`（**必须明确**问用户三选一）
- `items[]`（product_id + quantity + quantity_unit + unit_price + deal_unit_price?）
- `policy_template_id`（可选，优先 match）

### 2.2 政策匹配（**必须把匹配到的模板内容完整展示给用户**）

```
GET /api/policy-templates/templates/match?brand_id=X&cases=N&unit_price=P
```

- 0 条 → Agent 告诉用户"没有匹配政策，无法下单" **（重要：不要硬建）**
- 1 条 → 自动选用，但**必须**接着拉模板详情展示
- 多条 → 推卡片让用户选

匹配到模板后，**接着调**：

```
GET /api/policy-templates/templates/{template_id}
```

返回模板完整结构，包含：
- 政策名 + 编号 + 适用品牌 / 箱数区间 / 单价区间
- `benefits[]`：每条权益的「政策项名 / 数量 / 单位 / 单位价值 / 合计 / 兑付方式」

**Agent 不要**只把模板名 / 总金额展示给用户就让确认 —— 必须把**所有政策项明细**也推到卡片里，让用户看清"这单具体能拿到哪些赠品 / 返现 / 物料"。详见 2.4 卡片模板。

### 2.3 预览

```
POST /api/orders/preview
{
  "customer_id": "...",
  "brand_id": "...",
  "settlement_mode": "customer_pay",  // 或 employee_pay / company_pay
  "items": [...],
  "policy_template_id": "..."
}
```

返回：指导价总额 / 到手价总额 / 公司应收 / 业务员垫付 / 政策差 / 预估提成。

### 2.4 确认卡片（**含政策模板明细表**）

```
【确认建单】
客户：张三烟酒店
品牌：青花郎
结算模式：客户按指导价付（customer_pay）

商品：
  - 青花郎 53度 500ml × 5箱（指导价 ¥900/瓶）

匹配政策：5件青花郎模板（20260101）
┌──────────────┬────┬────┬──────────┬────────┬────────┐
│ 政策项         │ 数量 │ 单位 │ 单位价值   │ 合计    │ 兑付方式 │
├──────────────┼────┼────┼──────────┼────────┼────────┤
│ 品鉴会餐费     │ 1   │ 场  │ ¥1,500   │ ¥1,500 │ 报账    │
│ 品鉴酒         │ 3   │ 瓶  │ ¥400     │ ¥1,200 │ 物料    │
│ 庄园之旅       │ 1   │ 次  │ ¥2,000   │ ¥2,000 │ 直接报销 │
│ 季返           │ 1   │ 次  │ ¥1,350   │ ¥1,350 │ 报账    │
│ ……            │ …   │ …  │ …        │ …      │ …      │
└──────────────┴────┴────┴──────────┴────────┴────────┘
政策项合计：¥7,550

财务摘要：
  - 客户价：¥650/瓶
  - 公司应收：¥26,550
  - 到手价合计：¥19,500
  - 政策价值：¥7,550
  - 政策差：¥7,050
  - 政策盈余：¥500

[确认建单] [取消]
```

**铁律**：
- 政策项的「合计」和「兑付方式」必须**原样**从 `policy_templates.benefits` 取，**不要** Agent 自己换算或简化
- 兑付方式 enum：`报账 / 物料 / 直接报销 / 现金 / 季返 / 年返` 等，**原样**展示后端返回的字段
- 商品多于 1 种时表头加「品类」一列，逐行列；不能把多个商品合并展示
- 政策项明细表行数太多（>10）时用滚动 / 折叠，**不能裁剪只显示前几行** —— 老板要的就是"全看清"

### 2.5 执行（**用合并接口，禁用裸 `POST /api/orders`**）

```
POST /api/orders/create-with-policy
（同 preview 参数 + policy_template_id）
```

**铁律**：必须用 `/create-with-policy`（一个事务里同时建 Order + PolicyRequest + items + submit-policy → status=policy_pending_internal）。**禁用裸 `POST /api/orders`**——它只建 Order 不建 PolicyRequest，后续出库会被 `ship_order` 拦下："无法出库：该订单没有已审批的政策申请"（详见 SKILL.md §4.6）。

### 2.6 反馈 + 下一步

"✅ 订单 SO-xxx 已创建，状态 pending。下一步：[提交政策审批]"

**错误处理**：
- 客户未绑定品牌 → 引导用户先建 CBS
- 产品不属于该品牌 → 提示
- 政策匹配 0 条 → 不允许建单
- deal_unit_price 缺失（company_pay / employee_pay）→ 提示必填

---

## 场景 3：提交政策审批

**用户话术**：
- "把 SO-xxx 提交审批"
- "这单该审了"

**Agent 步骤**：

1. 确认订单状态 == `pending`（其他状态 400）
2. 调 `POST /api/orders/{id}/submit-policy`
3. 订单 → `policy_pending_internal`
4. 自动通知 boss

---

## 场景 4：老板审批订单（L1 → 推荐走 Gateway，**用合并 operation**）

**用户话术**（boss 说）：
- "看看待审的订单"
- "批了"
- "驳回 SO-xxx，理由：价格太低"

**风险等级**：L1（状态推进 + 触发提成 / 库存扣减下游）—— 推荐走 `/api/agent/execute` 拿 dryRun + idempotency。

**Agent 步骤**：

1. **列出**（L0 只读）：`POST /api/agent/execute operation=query.orders payload={status:"policy_pending_internal", brand_id:X}`
2. 推卡片展示每条的：客户、金额、政策、业务员
3. boss 点批准 →
   ```
   POST /api/agent/execute  operation=orders.approve_policy_with_request
     payload={ order_id, need_external? }  dryRun=true
   ```
   展示 dryRun.result（关联政策、提成预估）→ 用户再点"确认" → `/api/confirm-tokens` → `dryRun=false + X-User-Confirm + idempotencyKey`。
4. boss 点驳回 → 推"输入驳回原因"的 input 卡片 → 同上四步走 `orders.reject_policy_with_request`（驳回也建议带 token，以便审计）。

**铁律：用合并 operation `*_with_request`，禁用裸 `orders.approve_policy` / `orders.reject_policy`**（详见 SKILL.md §4.6）。裸 operation 只动 Order.status，PolicyRequest.status 还停在 pending —— 后续出库 ship_order 校验 PR 必失败。

**关键校验**：
- `policies.confirm_fulfill` 需要前置：关联订单 `payment_status=fully_paid`，否则后端 400。Agent 在驳回 / 关闭订单前先查这一条。

---

## 场景 5：出库

**用户话术**（warehouse 说）：
- "SO-xxx 要出库了"

**Agent 步骤**：

**Agent 一般不代操作出库**（需要扫码枪），提示用户："请到仓库扫码页面 `/orders/{id}/ship` 完成出库。"

如果是非扫码场景：
```
POST /api/orders/{id}/ship
（后端扣库存 + 生成 StockFlow）
```

---

## 场景 6：送达确认

**用户话术**：
- "货送到客户那了"
- "这单送达了，有照片"

**Agent 步骤**：

1. 引导用户发送货照片 → 飞书拿 image_key → 下载 → `POST /api/uploads` 拿 URL
2. 调：
   ```
   POST /api/orders/{id}/upload-delivery
   { "voucher_urls": ["..."] }
   ```
3. 调 `POST /api/orders/{id}/confirm-delivery`
4. 订单 → `delivered`

---

## 场景 7：上传收款凭证（业务员最常用）

**用户话术**：
- "SO-xxx 客户打款了，凭证在我手机上"
- "张三付了 3 万"

**Agent 步骤**：

### 7.1 引导发图

回复文本："请把收款凭证图片直接发给我"。

### 7.2 接收图片

用户发图 → Agent 收 `im.message.receive_v1` 事件 → 提取 `message_id + image_key`。

### 7.3 上传到 ERP

```python
# scripts/feishu_image_to_upload.py
url = feishu_image_to_erp(message_id, image_key, erp_jwt)
# url = "/api/uploads/files/2026-04/uuid.jpg"
```

### 7.4 收集金额

如果用户没说，问"本次收多少？全款还是部分？"

### 7.5 确认卡片

```
【确认登记收款】
订单：SO-xxx 张三烟酒店
应收：¥27,000
本次收款：¥27,000（全款）
凭证：[图片缩略图]

[确认登记] [修改金额] [取消]
```

### 7.6 执行

```
POST /api/orders/{order_id}/upload-payment-voucher
{
  "amount": 27000,
  "voucher_urls": ["/api/uploads/files/..."]
}
```

### 7.7 反馈

"✅ 凭证已提交，等待财务审批（预计 1-2 小时内）。审批通过后你会收到通知。"

**重要说明**（Agent 必须告诉业务员）：
- 这**不是**真的"已收款"，只是凭证登记
- 财务审批前订单不会变"已付款"
- 不会生成提成
- 如果有误可以让财务驳回

---

## 场景 8：财务审批收款（L2 → 强制 Gateway + dryRun + token）

**用户话术**（finance/boss 说）：
- "看看待审的收款"
- "张三的 SO-xxx 批了"
- "驳回凭证，金额不对"

**风险等级**：**L2**（动 master 现金池 + 生成 Commission + 刷新 Receivable）。**禁止**直打 `POST /api/orders/{id}/confirm-payment` —— 必须走 Gateway。

**Agent 步骤**：

### 8.1 列出（L0）

```
POST /api/agent/execute  operation=query.orders
  payload={ pending_receipt_confirmation: true }
```

或仍可直调 `GET /api/orders/pending-receipt-confirmation`（只读，无副作用）。

### 8.2 展示单个订单

推卡片：
```
【收款审批】
订单：SO-xxx 张三烟酒店
应收：¥27,000（customer_pay）
本次上传：3 张凭证，合计 ¥27,000（全款）
上传时间：2026-04-28 10:30
凭证：[图 1] [图 2] [图 3]

[批准全部] [驳回全部]
```

### 8.3 批准（L2 范式 B：dryRun → token → execute）

```
# 第 1 步：试跑
POST /api/agent/execute
  operation=orders.confirm_payment
  payload={ order_id: "SO-xxx" }
  dryRun=true
# 拿 result：master 现金 + 多少、生成多少 Commission、Receivable 还剩多少

# 第 2 步：用户在卡片点确认 → IM 后端
POST /api/confirm-tokens
  { action: "orders.confirm_payment", payload: { order_id: "SO-xxx" } }
  → token

# 第 3 步：真执行
POST /api/agent/execute
  Headers: { x-user-confirm: <token> }
  operation=orders.confirm_payment
  payload={ order_id: "SO-xxx" }
  dryRun=false
  idempotencyKey=<uuid-本次审批批次>
```

**铁律**：all-or-nothing，该订单**所有** pending Receipt 一次性转 confirmed。

**后端自动**（dryRun 在事务里走完后 ROLLBACK，preview 看到的就是真执行后的样子）：
- master_cash.balance += 每笔 Receipt 金额
- Receipt.status → confirmed
- Receivable 分摊
- 首次 fully_paid → 生成 Commission + 刷新 KPI + 推里程碑

### 8.4 驳回（L1）

驳回不动账，直调即可：
```
POST /api/orders/{id}/reject-payment-receipts
{ "reason": "凭证金额与订单对不上" }
```

**反馈**：通知业务员重新上传。

---

## 场景 9：查订单状态

**用户话术**：
- "SO-xxx 现在啥状态"
- "这单客户收到了没"
- "这单还欠多少"

**Agent 步骤**：

```
GET /api/orders/{id}
```

展示：订单号 / 客户 / 金额字段（按结算模式展示） / 订单状态 / 付款状态 / 已收/欠款。

**计算"欠款"**：`customer_paid_amount - SUM(confirmed Receipt.amount)`。

---

## 场景 10：查我的月度业绩

**用户话术**（salesman 说）：
- "我本月完成多少了"
- "这个月到手多少"

**Agent 步骤**：

### 10.1 本月回款 + 销售

```
GET /api/performance/me?period=2026-04
```

返回：
- 销售额
- 回款额（仅 confirmed Receipt 合计）
- KPI 考核项完成率
- 预估本月绩效 + 提成

### 10.2 展示

```
【李四 2026-04 业绩】
销售：¥120,000 / 目标 ¥100,000（120% ✅）
回款：¥95,000 / 目标 ¥100,000（95%）
KPI：
  - 回款额：¥95K / ¥100K → 95%
  - 新客户：3 / 5 → 60%
  - 拜访次数：25 / 20 → 125%

预估本月薪资：¥8,500
  - 底薪：¥5,000
  - 浮动：¥1,200（考核完成率 ×）
  - 提成：¥2,100（95% KPI 系数）
  - 全勤：¥200（本月请 0 天）
```

---

## 场景 11：查本月审批队列

**用户话术**（boss 说）：
- "今天有啥要审的"
- "看看待办"

**Agent 步骤**：

并行调：

```python
orders_recv = GET /api/orders/pending-receipt-confirmation
orders_policy = GET /api/orders?status=policy_pending_internal
purchases = GET /api/purchase-orders?status=pending
transfers = GET /api/accounts/pending-transfers
salaries = GET /api/payroll/salary-records?status=pending_approval
leaves = GET /api/attendance/leave-requests?status=pending
advances = GET /api/payment-requests?status=pending
claims = GET /api/expense-claims?status=pending
financing = GET /api/financing-orders/pending-repayments
expenses = GET /api/expenses?status=pending
```

推汇总卡片：

```
【审批中心 4 月 28 日】
📝 收款确认 5 单（¥58,000）
🎯 政策审批 3 单
🛒 采购审批 2 单（¥120,000）
💰 调拨申请 1 笔（¥50,000）
📅 请假 1 条
💸 报销 3 笔（¥3,500）

[按顺序处理] [稍后]
```

---

## 场景 12：生成月度工资（L2 → 批量上限 + draft 落账）

**用户话术**（HR 说）：
- "生成 4 月工资单"

**风险等级**：**L2**（批量 + 后续 batch-pay 是不可逆动账）。Agent 必须：
- 批量生成时 `payroll.batch_pay_salary` 单次 > 20 人会被后端 400 拒绝，需要拆批。
- **真正发放阶段 → drafts 两阶段**（公司垫付 / 工资发放 / 报销付款 全归不可逆动账，必走 draft.commit）。

**Agent 步骤**：

### 12.1 生成草稿工资单（L1，仅入 `pending_approval`，不动账）

1. 确认卡片：
   ```
   【确认生成 2026-04 工资单】
   覆盖员工：15 人（所有在职）
   底薪来源：主属品牌 × 岗位的薪酬方案
   提成基数：本月新全款订单
   KPI 系数：按品牌 kpi_coefficient_rules 当前规则
   本月 pay_cutoff_date：2026-04-30

   [确认生成] [取消]
   ```

2. 执行（直调即可，因为只入 draft 状态、不动账）：
   ```
   POST /api/payroll/salary-records/generate
   {
     "period": "2026-04",
     "pay_cutoff_date": "2026-04-30",
     "overwrite": false
   }
   ```

3. 返回 `{created: 15, skipped: [...]}`，展示 skipped 列表（一般是"未设主属品牌"）。

### 12.2 真正发放（L2 范式 C：drafts 两阶段）

```
# 1. 建 draft
POST /api/agent/execute
  operation=drafts.create
  payload={
    action: "payroll.batch_pay",
    payload: { period: "2026-04", employee_ids: [...] }
  }
# 返回 draft.id, draft.status='pending'，账户没动

# 2. 给用户卡片预览：本批发多少人、合计扣品牌现金多少、对应账户余额够不够

# 3. 用户点确认 → /api/confirm-tokens(action=drafts.commit, draft_id)

# 4. commit
POST /api/agent/execute
  Headers: { x-user-confirm: <token> }
  operation=drafts.commit
  payload={ draft_id }
```

**限额**：单次 employee_ids > 20 → 400，Agent 自动拆批，每批一个 draft。

---

## 场景 13：提成规则（KPI 系数）配置

**用户话术**（boss 说）：
- "把青花郎的 KPI 规则改一下"
- "完成 100% 以上的要加倍"

**Agent 步骤**：

1. 查当前规则：`GET /api/payroll/kpi-coefficient-rules?brand_id=X`
2. 理解用户要改什么：
   - 改现有规则的 min_rate / max_rate / mode / fixed_value
   - 新增规则覆盖新的区间
   - 停用规则
3. 如果有区间冲突，引导用户先编辑现有规则缩小范围

典型对话：

```
用户："青花郎完成 120% 以上的系数改成 1.5"

Agent 步骤：
1. 查现有规则 → 发现 [50%, +∞) linear 覆盖 120%
2. 告诉用户："当前规则是 ≥50% 按完成率线性（完成 150% 系数就是 1.5）。
              你是想 ≥120% 统一系数 1.5（而不是按完成率）吗？"
3. 确认后：
   - 编辑现有 [0.5, +∞) → 缩到 [0.5, 1.2)
   - 新增 [1.2, +∞) mode=fixed fixed_value=1.5
4. 显示新的规则组合
```

**权限**：仅 boss + admin。

---

## 场景 14：工资单重算

**用户话术**（boss 说）：
- "KPI 规则变了，4 月工资重算一下"

**Agent 步骤**：

1. 确认只对 `draft / rejected` 状态的工资单有效
2. 查询本期 draft 工资单列表
3. 批量调：
   ```
   POST /api/payroll/salary-records/{id}/recompute
   ```
4. 展示变化：
   ```
   【重算完成】
   共刷新 12 份工资单
   提成总额：¥23,400 → ¥28,100（+¥4,700）
   已归档工资单不受影响（需走反向凭证）
   ```

---

## 场景 15：政策兑付物料出库

**用户话术**（业务员说）：
- "SO-xxx 的政策赠品给客户了"

**Agent 步骤**：

1. 查政策 request + item
2. 收集出库明细：`request_item_id / product_id / quantity / quantity_unit / warehouse_id`
3. 确认卡片展示库存影响
4. 调：
   ```
   POST /api/policies/requests/{request_id}/fulfill-materials
   { "items": [{...}] }
   ```
5. item.fulfilled_qty 递增，达到 quantity 时 fulfill_status → fulfilled

---

## 场景 16：提交政策兑付凭证

**用户话术**：
- "把政策兑付的照片传一下"
- "实际花了 ¥450"

**Agent 步骤**：

1. 引导发图 → uploads
2. 收集 `actual_cost`（实际花费）
3. 调：
   ```
   POST /api/policies/requests/{id}/submit-voucher
   {
     "item_id": "...",
     "voucher_urls": ["..."],
     "actual_cost": 450
   }
   ```
4. 后端算 `profit_loss = standard_total - total_value - actual_cost`

---

## 场景 17：财务确认政策到账（含 Excel 对账 v2）

**用户话术**（finance / boss 说）：
- "厂家政策款到了 ¥500"
- "青花郎 4 月厂家费用表来了，帮我对一下"
- "把这张 Excel 跑一下匹配"（用户在飞书里直接发 .xls / .xlsx 附件）

### 17a. 单条手动确认（小批量、用户口报）

```
POST /api/policies/requests/confirm-arrival
{
  "items": [{"item_id": "...", "arrived_amount": 500, "billcode": "..."}]
}
```

后端：
- F 类账户 += arrived_amount
- 政策项 fulfill_status: applied → arrived（已 fulfilled/settled 的只补 arrival 字段）
- **幂等**：已写 arrival_at 的跳过（不会重复加钱）

**Agent 怎么做**：
1. 用户报"¥500 到账"先 GET 政策项确认，避免猜方案号
2. 推确认卡片：把"哪条 item / 多少钱 / 入哪个账户"列清
3. 用户点确认才调接口

### 17b. Excel 批量对账（厂家给 100+ 条流水时，必走）

**触发**：用户发 Excel 附件 + 说"对账" / "匹配" / "厂家给的费用表"。

**Agent 步骤**：

1. **上传文件**：飞书 Agent 拿到附件流，转发给：
   ```
   POST /api/manufacturer-settlements/import-excel?brand_id=<品牌>
   Content-Type: multipart/form-data
   file=@<excel-file>
   ```
   不需要 Agent 解析 Excel 内容，后端会按方案号 / 单据日期 / 金额 / 备注 / 摘要五步匹配。

2. **拿三段预览结果**：
   ```json
   {
     "auto_eligible_count": 12, "auto_eligible_amount": 18500.0,
     "needs_review_count":  2,  "needs_review_amount":   3700.0,
     "unmatched_count":     5,  "unmatched_amount":      9540.0,
     "matched": [...],
     "unmatched": [...]
   }
   ```

3. **推卡片给用户**（必须！不能直接入账）：
   ```
   【厂家对账预览 - 青花郎】
   ✅ 可自动入账：12 条 / ¥18,500（方案号 + 金额完全匹中）
   ⚠️  需人工核对：2 条 / ¥3,700（金额对不上，差额 ±X）
   ❌ 未匹配：5 条 / ¥9,540（无方案号 / 多匹中 / 不属于本品牌）

   操作：
   [一键入账可自动段] [逐条调整需人工段] [查看未匹配]
   ```

4. **用户点"一键入账"** → 调：
   ```
   POST /mcp/apply-reconcile
   {
     "brand_id": "<品牌>",
     "items": [<把 matched 数组里 auto_eligible=true 的行原样送回，不要改 amount>]
   }
   ```
   返回 `{applied: 12, total_amount: 18500.0, skipped: 0}`

5. **用户点"调整匹配"某条** → 调：
   ```
   POST /mcp/list-reconcile-candidates
   {"brand_id": "<品牌>", "keyword": "<可选搜索词>"}
   ```
   返回未到账政策项列表（带 ref_amount / 与 Excel 差额）让用户挑一条，再放进 apply-reconcile 的 items。

6. **未匹配段**：告诉用户"这些行没方案号或方案号不属于本品牌，需要先补方案号到 ERP 再重导，或人工建结算单分配"。**Agent 不要替用户决定**未匹配怎么处理。

### 关键规则（Agent 铁律）

- ❌ **绝不能**自己解析 Excel 拿金额、自己算匹配 —— 必须把文件原样转发给后端
- ❌ **绝不能**改 `amount` 字段（必须 = Excel income，否则后端服务端复核会拒）
- ❌ **绝不能**自动跑 apply-reconcile —— 必须用户在卡片里点确认
- ✅ **可以**重复调 import-excel（只读不动账）
- ✅ **可以**重复调 apply-reconcile（已入账的方案号会跳过，幂等）
- ✅ 用户问"为什么这条已经在表里又出现"，回答"已入账过的会跳过，若仍在请清缓存"

### 17c. 利润台账自动算

**用户问**："这次对账完，青花郎政策赚了多少？"

```
GET /api/dashboard/profit-summary?brand_id=<品牌>&date_from=...&date_to=...
```

`fclass_diff` 科目 = SUM(arrival_amount - actual_cost)。

| 场景 | actual_cost 来源 | 期望 fclass_diff |
|---|---|---|
| 公司垫付（payer_type=company）| 录关联费用时累加 | arrival - cost = 真实政策盈亏 |
| 客户垫付（payer_type=customer）| confirm-payment advance_refund 时累加 | 0（公司经手）|
| 业务员垫付（payer_type=employee）| 同上 | 0（公司经手）|

**Agent 怎么做**：把这三档分组展示给用户，别只给一个总数，否则用户看不出公司真赚了多少。

后端两轮匹配的具体逻辑、坑、E2E 验证：见 `policies.md` 场景 7、`fund-flows-catalog.md` 场景 23/24、`pitfalls.md` 第十七节、`backend/scripts/e2e_policy_reconcile.py`。

---

## 场景 17.5：公司垫付政策费用补登（L2 → drafts 强制两阶段）

**用户话术**（finance 说）：
- "刚给老张订了去赤水的机票 ¥8,000，记到 JD099... 那个庄园之旅政策项"
- "把场地费 ¥3,500 录到品鉴会的方案下"

**关键认知**：这种是公司**真金白银**已经在线下付出去了（机票代理 / 酒店 / 场地方），ERP 只是补登记。**录入即扣品牌现金 → 不可逆**，必须走 drafts 两阶段，绝不能直接 commit。

**风险等级**：**L2 不可逆动账**。同时后端硬限：`payer_type=company` 单笔 ≥ 50000 直接 400（防 LLM 一次扣大额），需要拆。

**Agent 步骤（范式 C：drafts.create → 卡片确认 → drafts.commit）**：

1. **找政策项**（L0 只读）：先按方案号 / 摘要搜：
   ```
   POST /api/agent/execute  operation=query.policies
     payload={ brand_id: "<品牌>", keyword: "庄园之旅" }
   ```
   或如果用户提了方案号，直接用 scheme_no 反查。

2. **预查账户余额**（L0）：
   ```
   POST /api/agent/execute  operation=query.accounts
     payload={ brand_id, account_type: "cash", level: "project" }
   ```
   余额不够 8000 → **不进入 drafts.create**，先告诉用户"账户余额不足，需先调拨"，引导走 create-fund-transfer-request。

3. **建 draft（不动账）**：
   ```
   POST /api/agent/execute
     operation=drafts.create
     payload={
       action: "policies.create_item_expense",
       payload: {
         item_id: "<item_id>",
         name: "机票",
         cost_amount: 8000,
         payer_type: "company",
         reimburse_amount: 10000
       }
     }
   # → draft.id, draft.status='pending'，账户没动
   ```

4. **推确认卡片**（展示 draft.payload + 后端预算的副作用）：
   ```
   【确认录入关联费用 - 公司垫付】
   政策项：庄园之旅（方案 JD09920241201651）
   费用名：机票
   金额：¥8,000
   付款方：公司
   动账：青花郎现金账户 -¥8,000（当前余额 ¥469,000 → ¥461,000）
   流水：fund_flows.related_type='policy_company_expense'
   累加：政策项 actual_cost += 8000

   ⚠️ commit 后立即扣账，不可撤销
   [确认提交] [取消]
   ```

5. **用户确认** → IM 后端调 `/api/confirm-tokens(action=drafts.commit, draft_id)` 拿 token → Agent commit：
   ```
   POST /api/agent/execute
     Headers: { x-user-confirm: <token> }
     operation=drafts.commit
     payload={ draft_id }
     idempotencyKey=<uuid>
   ```

6. **后端反馈**：
   - 200 → 告诉用户"已扣 ¥8,000，等厂家拨款时利润自动算"
   - 400 余额不足 → 引导调拨（drafts.commit 时会再校验一次余额）
   - 400 `cost_amount ≥ 50000` → 告诉用户"单笔限额 5 万，请拆为两笔录入"
   - 400 政策项已 settled → 告诉用户"政策已归档，找老板手工冲账"

### 改/删场景

**改金额**：`PUT /api/policies/expenses/<expense_id>`，按 delta 自动差额冲销 —— **L2，同样建议走 drafts**。

**删除**：`DELETE /api/policies/expenses/<expense_id>`，反向 credit 现金 + 减 actual_cost —— **L2，drafts**。

⚠️ Agent 删之前**必须**确认：政策项还没归档（settled 状态会被后端拒）。

### 三种 payer_type 的对话识别

用户说话 → 选 payer_type：

| 用户原话 | payer_type | 是否扣账 | drafts？ |
|---|---|---|---|
| "公司给XX付了" / "公司账户出的" | company | ✅ 扣品牌现金 | ✅ 必须 |
| "业务员先垫的" / "小李先付的" | employee | ❌ 仅登记，等 advance_refund | ❌ 直调 |
| "客户先付了" / "老张先垫的" | customer | ❌ 仅登记，等 advance_refund | ❌ 直调 |

**模糊时**：Agent **必问**"这笔钱是公司账户出的、还是业务员/客户先垫的？"。错选 payer_type 直接影响利润台账口径。

详见 `policies.md` 场景 7.5、`fund-flows-catalog.md` 场景 23、`business-atoms-bridges.md` 桥 14、`pitfalls.md` 第十八节。

---

## 场景 18：厂家工资补贴到账（L2 → Gateway dryRun + token）

**用户话术**（finance 说）：
- "青花郎 4 月厂家补贴到账 ¥5,000"

**风险等级**：**L2**（动品牌现金账户 + 批量改 subsidy 状态）。

**Agent 步骤**：

1. 先查应收（L0 只读）：`GET /api/payroll/manufacturer-subsidies?brand_id=X&period=2026-04&status=pending`
2. 算合计是否等于 ¥5,000
3. 不相等 → 告诉用户"金额不符，应收 ¥X，实到 ¥Y，需手工调整"
4. 相等 → dryRun 拿 preview：
   ```
   POST /api/agent/execute
     operation=payroll.confirm_subsidy_arrival
     payload={ brand_id, period: "2026-04", arrived_amount: 5000, billcode }
     dryRun=true
   ```
5. 推确认卡片（展示 dryRun.result：品牌现金 +5000、N 条 subsidy 状态变化）→ 用户确认 → `/api/confirm-tokens` 拿 token。
6. 真执行：
   ```
   POST /api/agent/execute
     Headers: { x-user-confirm: <token> }
     operation=payroll.confirm_subsidy_arrival
     payload={ ... }
     dryRun=false
     idempotencyKey=<uuid>
   ```
7. 后端：品牌 cash += 5000，所有相关 subsidy status → reimbursed

---

## 场景 19：稽查建案（L1 → 推荐 Gateway）

**用户话术**：
- "我在云南发现窜货，条码 ABC123，2 箱"
- "客户李四恶意外流"

**风险等级**：L1（建案不动账，但触发后续 execute 是 L2 动账，所以建案也建议带 idempotency 防重）。

**Agent 步骤**：

1. 追溯：`GET /api/inventory/barcode-trace/ABC123` → 拿 original_order_id / customer / sale_price / deal_price
2. 问用户是 A1 还是 A2（恶意 / 非恶意）
3. 收集 `purchase_price / penalty_amount / voucher_urls`
4. 确认卡片展示预估盈亏
5. 调（推荐 Gateway，便于 audit）：
   ```
   POST /api/agent/execute
     operation=inspections.create_case
     payload={
       case_type: "outflow_malicious",
       direction: "outflow",
       brand_id, product_id,
       barcode: "ABC123",
       ...
     }
     idempotencyKey=<uuid>
   ```
6. 告诉用户"案件 IC-xxx 已建，等 boss 审批"

---

## 场景 20：稽查案件执行（L2 → Gateway dryRun + token + 建议 drafts）

**用户话术**（boss 说）：
- "IC-xxx 案件执行"

**风险等级**：**L2 不可逆动账**（扣品牌现金 + 回收价入库 + 写利润亏损）。

**Agent 步骤**：

1. 查案件详情 + profit_loss（L0 只读）
2. dryRun 拿账户预扣预览：
   ```
   POST /api/agent/execute
     operation=inspections.execute_case
     payload={ case_id: "IC-xxx" }
     dryRun=true
   ```
3. 确认卡片：
   ```
   【确认执行稽查案件】
   IC-xxx A1 恶意外流
   品牌：青花郎 / 客户：李四 / 数量：2 箱（20 瓶）
   动账（dryRun preview）：
   - 品牌现金 -¥14,000（回收款 ¥700 × 20 瓶）
   - 品牌现金 -¥10,000（罚款）
   - 回备用仓（按回收价入库，保留后续追溯）
   预估亏损：-¥25,000（含回收成本和罚款）
   
   ⚠️ 真执行后利润台账已落账，不可撤销
   [确认执行] [取消]
   ```
4. 用户确认 → `/api/confirm-tokens(action=inspections.execute_case, payload={case_id})` → 拿 token
5. 真执行：
   ```
   POST /api/agent/execute
     Headers: { x-user-confirm: <token> }
     operation=inspections.execute_case
     payload={ case_id }
     dryRun=false
     idempotencyKey=<uuid>
   ```
6. 如余额不足会 400，告诉用户"先调拨再执行"

**注**：Gateway 端 `inspections.execute_case` operation 已注册 `requires_user_confirm=true`，dryRun=false 不带 token 直接 403。

---

## 场景 21：建采购单（含 scope 三分必填）

**用户话术**（purchase/boss 说）：
- "向郎酒集团采购青花郎 100 瓶"          → scope=liquor
- "总部给青花郎店补货 50 瓶可乐"         → scope=store（门店杂货）
- "商城仓采购 200 瓶纸杯"                → scope=mall（商城杂货）

**Agent 步骤**：

1. 判定 scope（关键）：
   - 白酒（任何品牌酒、走 inventory_barcodes 扫码） → `scope='liquor'`，必须 `brand_id` 且 `target_warehouse_type='erp_warehouse'`
   - 门店杂货（饮料/纸杯/卤味，落 store_products）→ `scope='store'`，必须 `target_warehouse_type='erp_warehouse'` + `warehouse_id=<门店仓>`
   - 商城杂货（mall_products）→ `scope='mall'`，必须 `target_warehouse_type='mall_warehouse'` + `mall_warehouse_id`
2. 收集：supplier_id / items / 支付方式（cash/f_class/financing 金额）
3. 校验 `cash + f_class + financing == SUM(qty × unit_price)`
4. 确认卡片 → 调 `POST /api/purchase-orders`（body 必含 `scope`）
5. 告诉用户"PO-xxx 已建，等 boss/finance 审批付款"

后端 purchase.py:131-162 强校验 scope 与 target 字段一致性，传错会 400。

---

## 场景 21.1：建品鉴酒采购单（**丝滑模板**，免审 + 默认 0 元）

**用户话术（典型简短表达）**：
- "采购青花郎品鉴酒 10 瓶"
- "进 5 箱五粮液品鉴酒"
- "厂家送了 20 瓶汾酒品鉴酒，入库"

**关键认知**：品鉴酒 = `policy_templates.benefits` 里 `fulfill_method='material'` 的政策物料，**业务实操多为厂家赠送**（PRD 实操让步）。所以：
- **默认 0 元**采购（用户不说价格就当 0）
- 仓库**自动锁定**该品牌的 `tasting` 仓（policies.py:689-697 `fulfill-materials` 也写死走这个仓）
- 后端 `purchase.py:650-654` 对品鉴仓 PO **跳过 PAID 校验**——可以建完直接收货，不必先 `purchase.approve` 扣账
- 入库后由 `policies/requests/{id}/fulfill-materials` 兑给客户

**Agent 简化步骤**（少问 3 个字段）：

1. **解析 4 项默认值**（用户没说就直接用，**不要逐项追问**）：
   - `brand_id`：从话术里的"青花郎/五粮液/汾酒/珍十五"提取
   - `warehouse_id`：自动查 `GET /inventory/warehouses?warehouse_type=tasting&brand_id=X` 拿这个品牌的品鉴仓 id
   - `unit_price`：默认 `0`（厂家赠样的常态；如果用户主动提到价格才改）
   - `supplier_id`：自动按品牌找对应酒厂供应商（青花郎 → 郎酒集团，五粮液 → 宜宾五粮液 …）
   - `scope`：固定 `liquor`
   - `target_warehouse_type`：固定 `erp_warehouse`
   - 付款方式：0 元单 cash/f_class/financing 全 0；如果不为 0，默认全现金
2. **追问 1 项**：数量 + 单位（瓶 / 箱），其他都按上面默认
3. **推确认卡片**（含品牌/品鉴酒/仓库锁定/0 元说明）→ 用户确认
4. 调 `POST /api/purchase-orders` 建单 → 拿到 `po_id`
5. **同一卡片立即给"下一步"按钮**：[扫码收货 →]（因为品鉴仓豁免 PAID 校验，不需要审批步骤！）

**确认卡片模板**：

```
【确认建品鉴酒采购单】
品牌：青花郎
商品：青花郎品鉴酒（自动选品牌下 fulfill_method=material 的 SKU）
数量：10 瓶
入库仓库：青花郎-品鉴酒仓（自动锁定）
供应商：郎酒集团（厂家赠样）
采购单价：¥0 / 瓶
采购总额：¥0
付款：现金 ¥0、F类 ¥0、融资 ¥0

ℹ️ 品鉴仓采购特例：建单后**无需审批扣款**，可直接扫码收货
[确认建单 + 收货] [取消]
```

**铁律**：
- ❌ Agent **不要逐项追问** "采购数量？/ 供应商？/ 入库仓库？/ 单价？/ 付款方式？" —— 用户原话已隐含这些信息（品鉴酒 → 默认 0 元 + tasting 仓 + 厂家赠送）
- ❌ Agent **不要**告诉用户"建完单需要 boss 审批扣款" —— 品鉴仓 PO 后端跳过 PAID 校验，建完直接 receive 就行
- ✅ 用户主动说"这单不是 0 元，¥XXX/瓶" → 切回标准场景 21 流程
- ✅ 收货时仍要扫码 N 个防伪码（业务铁律不变）

**衔接下一步（场景 21.5）**：

PO 建完，立即引导扫码收货——通常品鉴酒到货可能延后几天，所以卡片应该给两个按钮：
- "现在收货" → 跳到场景 21.5 收集 barcodes
- "稍后收货" → 提示 "PO-xxx 待收货，货到时来扫码"

---

## 场景 21.5：扫码收货（Phase B 后唯一入仓路径）

**用户话术**：
- "采购单 PO-xxx 货到了，给我开扫码"
- "店员扫完码了，提交收货"

**Agent 提示**：
1. Phase B 后**所有入库必须经 `POST /api/purchase-orders/{po_id}/receive`**——bind-barcodes / batch-import 两个裸接口已彻底删除
2. body 必传 `batch_no` + `barcodes_by_item: [{item_id, barcodes: [...]}]`
3. **每个 item 的 barcodes 数组长度必须 = item.quantity**（按采购单位计：1 箱就扫 1 个箱码，1 瓶就扫 1 个瓶码）
4. 后端同事务写三张表：`inventory_barcodes` + `barcode_registry` + `barcode_events`（PURCHASE_RECEIVE 事件）
5. 跨仓重复同码会 409 拒绝（registry first 互斥）

**Agent 不直接帮做的事**：扫码本身是物理动作，Agent 没法触发扫码枪。Agent 只能帮用户**确认数据完整性**后再调 receive 端点。

不同 scope 的收货分流：
- `scope=liquor`：走主路径，扫码必填
- `scope=store`（门店店员）→ 店员在小程序 `/api/mall/workspace/purchase-receiving` 完成
- `scope=mall`（仓管）→ 仓管在小程序完成
- 杂货 scope=store/mall：`_receive_store_goods` / `_receive_mall_goods` 按数量入库，**不扫码**

---

## 场景 22：调拨（L2 → Gateway dryRun + token；同品牌内免审，跨品牌必审）

**用户话术**：
- "从 master 调 10 万到青花郎现金"

**风险等级**：**L2**（动两个账户，跨品牌涉及调拨审批）。

**Agent 步骤**：

1. 查 from / to 账户余额（L0）
2. dryRun：
   ```
   POST /api/agent/execute
     operation=accounts.transfer
     payload={ from_account_id, to_account_id, amount: 100000, reason }
     dryRun=true
   ```
3. 确认卡片（展示 dryRun.result：from -10万、to +10万、是否需要 boss 二审）
4. 用户确认 → `/api/confirm-tokens` → 真执行（带 X-User-Confirm + idempotencyKey）
5. 跨品牌或涉 mall → 提醒"需要 boss 批准，已生成申请"，同品牌内免审直接落账。

详见 `accounts-finance.md` 调拨章节、`business-atoms-bridges.md` 桥 B11。

---

## 场景 23：请假

**用户话术**（salesman 说）：
- "我 4/27-4/29 病假"

**Agent 步骤**：

1. 推 Form 卡片收集 `leave_type / reason / voucher_url?`
2. 校验 start/end/days
3. 调 `POST /api/attendance/leave-requests`
4. 告诉用户"已提交，等 HR 审批"

---

## 场景 24：查库存

**用户话术**：
- "青花郎还有多少库存"
- "主仓库的五粮液"

**Agent 步骤**：

```
GET /api/inventory/batches?brand_id=X&warehouse_id=Y&product_id=Z
```

展示：产品 × 仓库 × 批次 × 数量。

---

## 场景 25：查账户余额

**用户话术**：
- "青花郎现在有多少钱"
- "看看账户"

**Agent 步骤**：

```
GET /api/accounts/summary
```

展示各品牌现金 / F 类 / 融资 + master 现金池。**注意 salesman 看不到 master**。

---

## 场景 26：查某员工工资单

**用户话术**（HR 说）：
- "看李四 4 月工资"

**Agent 步骤**：

```
GET /api/payroll/salary-records?employee_id=X&period=2026-04
GET /api/payroll/salary-records/{id}/detail
```

展示完整明细（底薪 / 提成 / 奖金 / 扣款 / 实发 + 关联订单列表）。

---

## 场景 27：报销申请（L1 提交 / L2 付款，2026-05-21 入口拆分）

**用户话术**（任意员工说）：
- "我这次出差花了 ¥500，报销"
- "F类报销 8000，这是发票"
- "做分货活动垫了 3000"

**入口拆分（重要）**：

| 通道 | 谁能进 | 用途 | 是否动账 |
|---|---|---|---|
| ERP 顶部菜单「**报销申请**」（路径 `/finance/expenses`）| 任意登录员工 | 个人发起 / 自查进度（普通员工进来只能看「报销单」Tab） | ❌ 仅落 pending |
| 小程序 `/pages/salesman-expense/salesman-expense` | salesman | 移动端发起（同一个 ExpenseClaim 实体）| ❌ |
| ERP「审批中心 → 综合审批 → **报销待审**」Tab | boss / finance / hr | 审批通过 / 驳回 | 仅状态变化 |
| ERP「报销申请」页内的"确认已付 / 已付并录方案 / 到账 / 兑付 / 归档"按钮 | **仅 admin/boss/finance 看得见** | 走付款流程 | ✅ L2 动账 |
| ERP「报销申请」→ Tab「**日常费用**」 | **仅 admin/boss/finance** | 财务直接录公司日常费用（差旅 / 水电 / 物料）| ✅ Expense 流程 |

**Agent 步骤（提交申请，L1）**：

1. 收集字段：
   - `claim_type`：`daily`（日常报销）/ `f_class`（F 类厂家政策费用）/ `share_out`（分货费用）
   - `brand_id`：`f_class` 和 `share_out` **必填**；`daily` 可选（按业务员主属品牌默认）
   - `title`（必）/ `description`（可选）
   - `amount`（> 0）
   - `notes`（可选）
2. 推飞书 Form 卡片让用户确认
3. 调 `POST /api/expense-claims`（无需 dryRun，因为不动账）：
   ```json
   {
     "claim_type": "daily",
     "brand_id": "<可选>",
     "title": "4月成都出差差旅",
     "description": "高铁+酒店",
     "amount": 500,
     "notes": ""
   }
   ```
4. 后端落 `status='pending'`，告诉用户"已提交，等审批中心审批"

**铁律**：
- ❌ Agent **不能**直接调 `POST /api/expense-claims/{id}/approve` 或 `/reject` 替老板审批 —— 审批必须由 boss/finance 在审批中心**人工**点。
- ❌ Agent **不能**直接调 `/pay` 或 `/apply` 或 `/confirm-arrival` 或 `/fulfill` —— **后端已硬挡**（2026-05-21 起这 4 个端点都挂 `risk_l2 + require_user_confirm`）：AI 通道（`X-Channel=ai-agent / mcp-client / feishu-bot`）缺 `X-User-Confirm` 直接 403。必须走 `drafts.create → 卡片 → /api/confirm-tokens → drafts.commit`（参见 §零点五 范式 C）。`/settle` 仅状态推进，L1 直调可。
- 普通员工 Agent 看到自己提的单进度，**不替别人提**。

**后端权限放开**：`POST /api/expense-claims` 接受 `boss / finance / salesman / sales_manager / hr / warehouse / purchase / store_manager`（2026-05-21 起）。

**关联资料**：`accounts-finance.md` AI SOP 表（claims.pay → L2 drafts）、`fund-flows-catalog.md` 场景 10、`business-rules.md` §零点五。

---

## 场景 27.5：录公司日常费用（L1 申请 / L2 付款，仅财务）

**用户话术**（finance/boss 说）：
- "录一笔 4 月办公室水电 ¥3500"
- "把场地租金 8000 入到青花郎账下"
- "采购了一批办公用品 1200，从平坝现金扣"

**关键区别**（跟场景 27 的 ExpenseClaim 不要混）：

| 维度 | 场景 27 报销申请（expense_claims）| 本场景日常费用（expenses）|
|---|---|---|
| 谁发起 | 任意员工 | **仅 admin/boss/finance** |
| 钱归谁 | 公司付给员工（员工先垫付）| 公司直接付给供应商/服务方 |
| brand_id | f_class/share_out 必填，daily 可选 | **必填**（决定从哪个品牌现金账户扣款）|
| 入口 | ERP「报销申请」→ 报销单 Tab + 小程序 | ERP「报销申请」→ 日常费用 Tab |
| draft action | `expense_claims.pay` | `finance.expenses.pay` |
| 流转步数 | 7 步（pending→approved→applied→arrived→fulfilled→paid→settled）| 3 步（pending→approved→paid）|

**Agent 步骤（录入，L1）**：

1. 收集字段（**必问 brand_id**，因为决定从哪个账户扣）：
   - `brand_id`（必填，让用户在已有品牌里选）
   - `description`（必填，例："4 月办公室水电"）
   - `amount`（> 0）
   - `applicant_id`（可选，记是谁经办的）
   - `payment_date`（可选，费用发生日期）
   - `voucher_urls`（可选，发票/收据图）
   - `category_id`（可选）
2. 推飞书 Form 卡片让用户确认（**第 1 项就是品牌下拉**，跟前端 ExpenseList「日常费用」Tab 一致）
3. 调 `POST /api/expenses`（不动账，仅落 pending）：
   ```json
   {
     "brand_id": "<品牌 id>",
     "description": "4 月办公室水电",
     "amount": 3500,
     "applicant_id": "<经办人 id，可选>",
     "payment_date": "2026-04-15",
     "voucher_urls": ["..."]
   }
   ```
4. 后端落 `status='pending'`，告诉用户"已录入，等审批中心审批"

**付款（L2 不可逆，drafts 强制）**：

```
1. drafts.create  payload={ action: "finance.expenses.pay",
                            payload: { expense_id, payment_account_id, payment_voucher_urls } }
2. 卡片预览（动账：品牌现金 -amount）→ /api/confirm-tokens → token
3. drafts.commit  payload={draft_id} + X-User-Confirm
```

**铁律**：
- ❌ Agent **不能**给非 admin/boss/finance 用户暴露这个流程 —— 普通员工只能用场景 27 的 ExpenseClaim
- ❌ Agent **不能**漏 `brand_id`，后端拒（"日常费用必须指定品牌"）
- ❌ 不要把 `finance.expenses.pay` 跟 `expense_claims.pay` 写串

**关联资料**：`accounts-finance.md` §日常费用、`api-reference.md` `/api/expenses`、`fund-flows-catalog.md` 场景 10。

---

## 场景 28：通知推送（Agent 主动找人）

**后端事件 → Agent 主动推送**：

| 事件 | 推给谁 | 卡片 |
|---|---|---|
| 上传收款凭证 | finance/boss | "有新凭证待审：SO-xxx ¥3000" |
| 订单提交政策审批 | boss | "有订单待批政策：SO-xxx" |
| KPI 达成里程碑 | 业务员本人 + sales_manager | "🎯 你已完成 50% 目标" |
| 低库存预警 | warehouse/boss | "产品 X 库存不足 5 箱" |
| 大额采购 | boss 二审 | "大额采购待审：PO-xxx ¥200K" |
| 请假被批/驳 | 申请人 | "你的请假被批/驳" |
| 工资发放 | 员工本人 | "4 月工资 ¥8500 已发放" |

**按角色定向推送（FrontLane 定时审批扫描用）**：

平台后端做"按角色批量推卡片"时（如政策审批扫到 N 张待审，要分别推给所有 boss），不要遍历 employees 表自己拼，调专用接口：

```
GET /api/users/by-role?role=boss
  Headers: X-Agent-Service-Key: <服务密钥>   ← 服务端到服务端调用，不需要用户 JWT
  Response:
    {
      "items": [
        {
          "user_id": "uuid",
          "username": "admin",
          "employee_id": "uuid | null",
          "employee_name": "闫超建",
          "feishu_open_id": "ou_xxx | null",    ← 没绑飞书 → null
          "is_active": true,
          "roles": ["admin", "boss"]
        }
      ],
      "total": 2
    }
```

**典型流程**：
1. 定时任务扫到 `status=pending` 的政策审批 N 张
2. 调 `GET /api/users/by-role?role=boss`（默认 `active=true`）
3. 遍历 `items`：对每个 `feishu_open_id != null` 的用户推飞书卡片
4. `feishu_open_id == null` 的人记一条 audit："boss 用户 X 未绑定飞书，无法推送"，让运营提醒他绑

**铁律**：
- ❌ 不要自己 SELECT users / user_roles / feishu_bindings 表拼数据 —— 走专用接口避免漏 RLS / 漏 active 过滤
- ❌ 不要把"未绑飞书的人"过滤掉再推 —— agent 平台要看到 "boss 没绑" 这条情报
- ❌ 不要遗忘 active=false 场景，员工离职 / 调岗后 is_active=false，**不该**再推卡片给他

---

## 场景 29：多轮对话处理（Agent 状态机）

**典型多轮交互**（建单为例）：

```
Turn 1:
 U: 给张三下 5 箱青花郎
 A: [查客户找到张三] [确认品牌] [问 settlement_mode]
    "请选择结算模式：客户按指导价付 / 业务员垫差 / 公司让利？"

Turn 2:
 U: 客户按指导价付
 A: [调 preview] [推确认卡片]
    "【确认建单】5 箱青花郎 ¥27,000 ... 确认？"

Turn 3:
 U: 点"确认建单"按钮 → 飞书回调 card.action.trigger
 A: [调 POST /api/orders/create-with-policy] [update_card 结果]
    "✅ 订单已建 SO-xxx，状态 policy_pending_internal，已自动提交政策审批等老板"
（合并接口已包含 submit-policy；老的"建单 → 单独点提交审批"两步流程废弃）
```

**ctx_id 机制**：每个卡片生成唯一 UUID，参数存内存 / Redis，卡片 button value 只带 ctx_id。点击时用 ctx_id 取回完整参数再调 API。

---

## 场景 30：Agent 不确定时的兜底

用户说话模糊或 Agent 识别不出意图时：

**标准回复**：
```
没太明白你要做什么。你可以说：
- 建客户 / 改客户
- 建订单 / 查订单 / 改订单
- 上传凭证 / 查我的收款
- 查库存 / 查账户余额
- 查我的业绩 / 查工资
- 稽查 / 请假 / 报销

你想做哪一个？
```

**禁止**：猜测用户意图直接调接口。宁可多问一轮也不要错动账。

---

## 场景 31：业务员问"我本月工资为啥少钱"（决策 #1 追回）

**用户话术**：
- "我工资条 5000，怎么到账只有 4700？"
- "上月已经发的钱这月又扣回去了？"

**Agent 步骤**：

1. **拿 employee_id**（从 JWT）
2. **定位最近一期 SalaryRecord**：
   - `GET /api/payroll/salary-records?employee_id=X&period=当前月`
   - 或从 JWT 的 role 推断（salesman 只能查自己）
3. **查明细** `GET /api/payroll/salary-records/{id}/detail`
4. **看 `clawback_details[]` 非空 →** 逐条翻译：
   ```
   原订单 {origin_order_no}（{origin_ref_type}）
   上月已发 ¥{origin_amount} 提成
   客户退货，本月扣回 ¥{abs(amount)}
   ```
5. **看 `clawback_settled_history[]` 非空 →** 说明本月扣了历史挂账：
   ```
   历史挂账 ¥{pending_amount}（{reason}）本月已扣清
   ```
6. **看 `clawback_new_pending[]` 非空 →** 本月工资不足挂账：
   ```
   本月 ¥{pending_amount} 没扣完，下月工资发放时自动先扣
   ```

**不要说**："系统扣你工资"。应说："是 X 月 MO-xxx 单客户退货冲减，参见你的退货流水"

---

## 场景 32：业务员查自己 commission 流水（G6）

**用户话术**：
- "我本月接了多少单提成？"
- "哪些订单提成被冲掉了？"

**Agent 步骤**：

1. `GET /api/mall/workspace/my-commissions/stats?year=2026&month=5`
   - 返回 `by_status.pending / settled / reversed` 金额 + 数量
   - 返回 `adjustment` 追回数量 + 金额
2. 用户追问"哪几单冲掉了" →
   - `GET /api/mall/workspace/my-commissions?status=reversed&year=2026&month=5`
3. 用户追问"追回具体哪单" →
   - `GET /api/mall/workspace/my-commissions?status=adjustment&year=2026&month=5`
   - 每条带 `origin_commission_amount` + `origin_status` 方便理解
4. 绝对不要代用户点"申诉"（第一版没开放申诉端点）

---

## 场景 33：老板问月度业务员排行（决策 #2 快照/实时双模式）

**用户话术**：
- "5 月 Top3 业务员是谁"
- "上月业绩排名出来了吗"

**Agent 步骤**：

1. **先问用户**："您要看哪个口径？"
   - **快照**：月初冻结，发完奖金后数据不变
   - **实时**：剔除退货，能看到"真实贡献"
2. 默认推快照（发奖金场景更稳）
3. `GET /api/mall/admin/dashboard/salesman-ranking?mode=snapshot&year_month=2026-05&limit=10`
4. 如果返回 `records=[]` 且 `snapshot_count=0` → 告诉用户"该月快照尚未生成，5 月 1 号 00:05 会自动冻结；需要现在冻结可调 build-snapshot"
5. **始终注明数据口径**，让老板明确"这是 5/1 冻结的历史快照"还是"实时剔退货"

---

## 场景 34：门店收银（散客 vs 会员，决策 #3）

**用户话术**（店员）：
- "那个客户没注册，给我扫了单"
- "他说他是会员，手机尾号 1234"

**Agent 步骤**：

1. **识别模式**：
   - "没注册" → 散客模式
   - "会员" → 按手机号/姓名搜（`min_length=5`）
2. **会员模式**：
   - `GET /api/mall/workspace/store-sales/customers/search?keyword=张三1234`
   - 返回 phone 已脱敏（`138****1234`）+ `is_local_customer` 标
   - 若无命中 → 问用户"改散客模式？还是先帮客户注册？"
3. **散客模式**：
   - 直接走 `POST /api/mall/workspace/store-sales`，body 里 `customer_id=null`
   - 如果客户愿意留手机号：加 `customer_walk_in_name` + `customer_walk_in_phone`
4. 提交时走扫码 `verify-barcode` → 填 `line_items` → `POST /store-sales`

---

## 场景 35：Agent 执行退货 approve 遇到并发错误（G12）

**场景**：
- 财务点"批准"按钮，后台返 500 或 UNIQUE violation
- `UniqueViolation on uq_commission_adjustment_source`

**Agent 步骤**：

1. **绝对不要重试**（可能是前端双击已成功建过 adjustment）
2. 查 `GET /api/mall/admin/returns/{id}` 看 status：
   - `approved / refunded` → 告诉用户"已审批完成，不需重复操作"
   - `pending` → 汇报错误让用户再试一次（但概率很低）
3. 如果用户坚持"我刚按的没生效" → 提示他先刷新列表

---

## 场景 36：绑定员工到门店（管理员配置门店权限，L2）

**用户话术**（admin/HR/boss）：
- "给业务员小李加门店青花郎专卖店的权限"
- "区域经理王五要管 3 家店：青花郎、华致、鑫久"

**前端入口（2026-05-22 起）**：所有权限改动统一在「**权限管理**」页 `/admin/permissions`（admin 专属一级菜单）StorePopover 弹层里点点点完成。Agent 不要让用户去工作台 / 人事中心找。

**关键概念（m6cx 后）**：
- 员工与门店的关系存在 `employee_store_assignments` 多对多表
- 一员工可绑多家门店（区域经理）
- 绑了门店后，**JWT 里 store_ids 会自动包含这些门店 id**（下次登录生效）
- 没绑门店的品牌业务员看不到任何门店的 inventory / store_sales / store_sale_returns（RLS 拦）

**Agent 步骤（L2，走 Gateway 范式 B）**：

1. 找员工：`GET /api/hr/employees?keyword=小李`
2. 列当前绑定：`GET /api/hr/employees/{emp_id}/store-assignments` → [{ warehouse_id, warehouse_name, is_primary }]
3. 找门店：`GET /api/inventory/warehouses?warehouse_type=store`
4. 推卡片展示"打算从 X 改为 Y"对比 + 主门店选择 → 用户确认
5. dryRun + token + 真执行：
   ```
   PUT /api/hr/employees/{emp_id}/store-assignments
     Headers: { x-user-confirm: <token> }
     Body: { warehouse_ids: [...], primary_warehouse_id: <opt> }
   ```
   后端做"整体替换"语义（删旧 + 加新），同事务同步老 `employees.assigned_store_id` 字段保兼容

**Agent 关键提醒**：
- 业务员的"品牌权限"走 `employee_brand_positions`，跟门店权限**独立**——加门店不影响品牌可见性
- 改绑后**老的 token 仍带旧 store_ids，需要用户重新登录**才能刷新
- `primary_warehouse_id` 必须在 `warehouse_ids` 里；不传时后端取列表第一个

---

## 场景 37：整套权限配置（一站式）

**用户话术**：
- "新来个业务员张三，给他建账号、绑青花郎、绑两家专卖店"
- "把李四从财务降为人事"
- "重置王五的密码"
- "禁用赵六的账号"

**核心原则（2026-05-22 重组后）**：

| 旧入口（已删）| 新入口 |
|---|---|
| `/hr/users` 登录账号页 | `/admin/permissions`（统一）|
| `/store/accounts` 收银账号页 | `/admin/permissions`（同一表，"门店收银员" Tab）|
| `/hr/employees` 员工档案里的账号弹窗 | `/hr/employees` 仅做员工档案；账号 / 角色 / 权限去 `/admin/permissions` |

**所有权限改动均为 L2**（auth.py:308/341/361 + payroll.py:323/362/393 + hr.py:478 共 7 个端点 2026-05-22 升 L2）。Agent 必走 dryRun + X-User-Confirm + idempotency。

**Agent 全流程示例（新员工建账号 + 配权限）**：

```
1. 新建员工档案（L1，不动账）
   POST /api/hr/employees
     { name, employee_no, position, phone? }

2. 建登录账号（L1）
   POST /api/auth/users
     { username, password, employee_id, role_codes: ['salesman'], is_active: true }

3. 绑品牌（L2 范式 B）
   POST /api/agent/execute  operation=payroll.bind_brand_position  dryRun=true
     payload={ employee_id, brand_id, position }
   → 卡片确认 → /api/confirm-tokens → execute(dryRun=false + token)

4. 绑门店（L2 范式 B）
   PUT /api/hr/employees/{emp_id}/store-assignments  dryRun=true
     payload={ warehouse_ids: [...], primary_warehouse_id }
   → 同上四步

5. 反馈："✅ 已建员工 + 账号 + 绑了 1 个品牌 + 2 家门店。员工首次登录用初始密码 X，登录后请改密"
```

**典型场景对照表**：

| 用户意图 | 走哪个 L2 operation |
|---|---|
| 改角色 | `auth.update_user_roles`（PUT /api/auth/users/{id}/roles）|
| 启停账号 | `auth.update_user`（PUT /api/auth/users/{id}，body { is_active }）|
| 重置密码 | `auth.reset_password`（POST /api/auth/users/{id}/reset-password，body { new_password }）|
| 加品牌权限 | `payroll.bind_brand_position`（POST /api/payroll/employees/{id}/brand-positions）|
| 改品牌岗位 | `payroll.update_brand_position`（PUT /api/payroll/brand-positions/{id}）|
| 移除品牌 | `payroll.delete_brand_position`（DELETE /api/payroll/brand-positions/{id}）|
| 绑/改门店 | `hr.replace_store_assignments`（PUT /api/hr/employees/{id}/store-assignments，整体替换）|

**铁律**：
- ❌ Agent **不能**跳过 dryRun 直接改权限——所有 7 个端点都挂 `risk_l2 + require_user_confirm`，AI 通道无 token 直接 403
- ❌ 普通员工 / sales_manager 没有"权限管理"页访问权——`/admin/permissions` 仅 admin。Agent 听到非 admin 用户问"我帮 X 改下角色"，提示"权限改动只能 admin 操作，请联系管理员"
- ❌ 改完角色 / 品牌 / 门店后，**老 JWT 仍带旧权限**——必须告诉用户"新权限要重新登录才能生效"
- ❌ 重置密码后**老 token 不会立刻失效**（JWT 是无状态的）——告诉用户"老的会话仍能用到 access_token 过期（15 min），如急停请同时启停账号"

**关联资料**：`api-reference.md` §认证 + §人事 + §工资章节标 🔴 L2、`endpoint-risk-levels.md` 第 32-38 行、`business-rules.md` §零点五 L2 通道铁律。

---

## 通用原则（Agent 每次都必须遵守）

1. **写入前必须用卡片按钮确认**（不依赖打字"确认"）
2. **金额永远用 preview 接口返回**（不自己算）
3. **动账失败不自动重试**（可能重复动账）
4. **错误消息原样展示**（不自己改写 detail）
5. **不泄露 master 账户余额给 salesman**
6. **涉及用户个人数据（工资/身份证等）要脱敏**
7. **多图上传时等 30 秒静默判定传完**，或用卡片按钮"完成上传"明确结束
8. **不主动替用户审批**（哪怕用户是 boss 本人，也必须卡片点按钮）
9. **所有时间按东八区展示**（后端返 UTC，前端格式化）
10. **Agent 对话记忆 ≤ 10 轮**，超过引导用户重新说明
