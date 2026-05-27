# 硬性业务规则速查

这些规则是**后端强校验**的。Agent 操作前必须先自查，违反会被 400 拒，反复调还可能造成账务错乱。

---

## 零、Agent 身份隔离红线（最高优先级）

**Agent 永远不持有任何固定的 ERP 账号 / JWT**。Agent 帮一个员工操作 ERP，**必须用这个员工本人的身份**登录：

1. **首次对话必须绑定**：用户在飞书（或其他入口）第一次找 Agent 时，Agent 调 `POST /api/feishu/exchange-token`（body 含该用户 `open_id`）。
   - 返回 200 → 拿到**该员工本人**的短期 JWT（15 分钟 TTL）+ role + brand_ids，所有后续 API 调用用这个 token。
   - 返回 404 "未绑定" → Agent 推"绑定 ERP 账号"卡片，**引导用户本人填 ERP 用户名 + 密码**，提交后调 `POST /api/feishu/bind` 建立 `open_id ↔ erp_user` 映射。
   - 返回 403 "账号已停用" → 告诉用户找管理员。
2. **绝不使用其他人的 token**：哪怕 boss 说"帮我让小李也查一下他的绩效"，Agent 必须引导**小李本人**来对话里绑定账号后自查。boss 的 JWT 永远只能查 boss 自己有权限看的数据。
3. **JWT 过期自动重新 exchange**，但 exchange 出来的还是当前 open_id 对应的那个员工。Agent **绝不缓存、绝不跨用户复用 JWT**。
4. **Agent 不持有 Service Account / 超级 token**。`X-Agent-Service-Key` 只是 Agent 服务跟 ERP 建立信任的密钥，不代表任何人——**真正调业务接口必须用员工 JWT 的 Authorization header**。

**为什么这样设计**：
- RBAC + RLS 全部挂在 JWT 里（role / brand_ids / user_id）。Agent 用谁的 JWT，数据就按谁的权限过滤。
- salesman 看不到 master 账户、看不到别人客户 —— 这是后端 RLS 强制的，不是 Agent 自觉。Agent 用 salesman 的 JWT，想越权也调不出来。
- 员工自己在飞书对话里做的每一个操作，最终在 audit_logs 里 `user_id` 落的是他本人 —— 责任归属清楚。

**Agent 绝不能做**：
- ❌ 不能用 admin 万能账号"帮" salesman 查数据（哪怕 salesman 主动请求）
- ❌ 不能把一个 open_id 的 JWT 用于另一个 open_id 的对话
- ❌ 不能绕过 exchange-token 直接让用户"随便说个员工号就行"
- ❌ 不能把 ERP 密码明文记进对话历史或 memory（bind 成功后立即丢弃）
- ❌ 不能跨会话复用过期 JWT（必须重新 exchange）

**异常兜底**：如果 Agent 在一个对话里发现同一 open_id 突然换了 role 或 brand_ids，立刻丢弃缓存重新 exchange，防止"员工调岗 / 离职后 token 还在用旧权限"。

---

## 零点五、L2 通道铁律（写入类调用唯一合规姿势）

**核心立场**：本节所有"铁律 / 不许"**不是不让 Agent 干活**，而是规定 Agent 干活的合规姿势——动账 / 跨模块 / 批量类操作必须走 Gateway，让人审 + 幂等 + 审计三件套同时生效。Agent 该主动帮老板 / 财务把这些事办了，只要按下面 5 条铁律走。

ERP 把所有 API 端点按风险分了三档（完整清单见 `endpoint-risk-levels.md`）：

| 档 | 数量 | 例子 | Agent 调用方式 |
|---|---|---|---|
| **L0** | 218 | GET 查询 / 创建客户 / 上传凭证 | 直调 `/api/*` 或 `/api/agent/execute query.*` |
| **L1** | 48 | 建订单 / 单条审批 / 出库 / 状态推进 | 直调 `/api/*` 即可，**建议**带 `X-Channel: ai-agent` + idempotencyKey |
| **L2** | 38 | 动账 / 跨模块 / 批量 / 强写 / 直接动数据 / **权限变更** | **强制走 `/api/agent/execute`**（dryRun + token + idempotency 集中收口）|

**铁律 1：L2 不许直打 REST**

```
❌ Agent 直调 POST /api/orders/{id}/confirm-payment   ← 后端会通过 dependencies=[risk_l2] 拒
✅ POST /api/agent/execute operation=orders.confirm_payment
```

理由（OWASP LLM06:2025 Excessive Agency + ASI02 Tool Misuse）：
- L2 端点动账，没有 dryRun 等于盲签。
- 没有 X-User-Confirm 等于 Agent 自己拍板替用户花钱。
- 没有 idempotencyKey 等于网络抖动可能扣两次。

**铁律 2：L2 写入必带 X-User-Confirm**

1. dryRun=true → 拿 preview
2. 给用户卡片，用户点"确认"
3. IM 后端 `POST /api/confirm-tokens` 拿一次性 token（120s TTL + jti 黑名单 + 绑当前 employee + 绑 action + 绑 payload_hash）
4. Agent dryRun=false + `Headers: X-User-Confirm: <token>` 真执行

Agent **自己造不出** token —— token 是 ERP 后端用对称密钥签发，且要求用户先在 IM 卡片上点击。这是"人在环（HITL）"的最后一道闸。

**铁律 3：不可逆动账走 drafts 两阶段**

公司垫付 / 工资发放 / 报销付款 这三类**先付钱再凭证**的动账：

```
1. drafts.create  payload={action, payload}           ← 不动账，落 draft_actions 表 pending
2. 给用户卡片，预览 draft.payload
3. 用户确认 → /api/confirm-tokens(action=drafts.commit)
4. drafts.commit  payload={draft_id} + X-User-Confirm  ← 真落账
```

**绝对禁止**：跳过 drafts.create 直接调对应的真实写入端点。后端会拒。

**铁律 4：idempotencyKey 是 Agent 自己生成的 UUID**

- 一个用户意图 = 一个 idempotencyKey，整次重试都用同一个。
- 24h 内同 key 二次调用直接返回上次结果（Gateway 缓存）。
- 网络超时 / 5xx 时 Agent 必须**用同一 key 重试**，不要新生成。

**铁律 5：rate-limit 30/min/employee**

Agent 一分钟内对同一员工调 `/api/agent/execute` 写入超 30 次会 429。批量场景必须拆 + 加 sleep。

详见 `ai-gateway.md`。

---

## 一、权限矩阵（RBAC）

| 角色 | 能做 | 不能做 |
|---|---|---|
| `salesman` | 建客户/建订单/上传凭证/拜访打卡 | 看 master 账户 / 看别 salesman 的客户 / 审批任何东西 / 建政策模板 |
| `sales_manager` | salesman 全部 + 部门报表 / 建销售目标 | 审批工资 / 批采购 |
| `finance` | 审批收款/采购/调拨/工资二审/报销/政策到账/到账对账 | 建客户 / 建订单 / 建政策模板（只有 boss） |
| `hr` | 员工档案/薪酬方案/工资一审/请假一审/KPI 配置 | 审批采购/调拨/大额报销 |
| `warehouse` | 出库/入库/收货/盘点 | 审批任何金额相关 |
| `purchase` | 建采购单 | 审批（需 boss/finance） |
| `boss` | 全部（最终审批人） | — |
| `admin` | 全部（含系统管理） | — |
| `manufacturer_staff` | 政策外审（外部审） | 其他 |

**RLS（行级安全）强制**（m6cy 起 19 张表，品牌权限走 brand_ids、门店权限走 store_ids 互相独立）：
- 品牌业务员可同时绑品牌（`employee_brand_positions`）+ 绑门店（`employee_store_assignments`）；门店店员只能绑门店、不能绑品牌
- salesman 看客户，只能看 `CustomerBrandSalesman.salesman_id=me AND brand_id ∈ 我的品牌`
- 账户查询，salesman 看不到 `level='master'`（policy 走 `app_current_can_see_master()`，salesman JWT 落 false）
- 所有带 `brand_id` 的表（orders/policy_requests/policy_claims/inspection_cases/commissions/...），salesman 只看自己 brand_ids 命中
- **门店仓** inventory + store_sales 三表（store_sales/store_sale_items/store_sale_returns），走 `store_id ∈ app_current_store_ids()`：业务员没绑门店就看不到任何门店流水/库存
- **非门店仓**（main/backup/tasting）inventory 走 `brand_id ∈ brand_ids` 过滤
- employees 表：普通员工只能看自己（id = current_employee_id），admin/HR 看全

---

## 二、幂等键清单

这些接口的**重复调用安全的**（后端已做幂等保护），Agent 遇到网络超时可以重试：

| 接口 | 幂等键 | 实现方式 |
|---|---|---|
| `POST /policies/requests/confirm-arrival` | `(PolicyRequestItem.id, status='arrived')` | 已 arrived 跳过 |
| `POST /policies/requests/{id}/confirm-fulfill` | `(item.id, status='settled')` | 已 settled 直接返回"已归档" |
| `POST /salary-records/generate` | `(employee_id, period)` UNIQUE 约束 | 已有则 return 或 overwrite |
| `POST /salary-order-links` | `(order_id, is_manager_share)` UNIQUE | DB 约束挡重复 |
| `POST /accounts/transfers/{id}/approve` | `status != 'pending'` 拒绝 | 状态校验 |
| `POST /orders/{id}/confirm-payment` | 没有 pending Receipt 时 400 | 凭状态挡 |

---

## 三、不能重试的接口（可能重复动账）

这些接口**Agent 绝不能自动重试**，哪怕是网络超时：

- `POST /receipts`（直接建 Receipt 立刻动账）
- `POST /mcp/register-payment`（同上）
- `POST /purchase-orders/{id}/approve`（扣账户）
- `POST /inspection-cases/{id}/execute`（扣账户+动库存）
- `POST /financing-orders/repayments/{id}/approve`（扣账户）
- `POST /accounts/fund-flows`（手工加流水）

**遇到超时怎么办**：
1. 等 5 秒
2. 查询实体当前状态确认是否成功
3. 如已成功不再调用
4. 如失败告诉用户"可能已执行，请查询确认"

---

## 四、必须 `with_for_update` 的并发场景

后端已加行锁的地方（不用重复 / 但 Agent 理解一下有助于排查）：

| 接口 | 锁对象 | 防什么 |
|---|---|---|
| approve_repayment | FinancingRepayment + FinancingOrder | 并发 approve 时 `repaid_principal +=` 丢笔 |
| cancel_paid_purchase_order | payment_to_mfr Account | 并发撤销让账户变负 |
| execute_inspection_case | InspectionCase | 并发 execute 重复扣账户 |
| pay_daily_claim | ExpenseClaim + Account | 并发 pay 双扣 |
| confirm_settlement_allocation | ManufacturerSettlement + PolicyClaim | 并发分配冲突 |

---

## 五、订单建单校验

**Agent 建单前**必须收集到 + 校验：

| 字段 | 必填 | 校验 |
|---|---|---|
| `customer_id` | ✅ | 客户必须绑了品牌（CBS），否则 400 |
| `brand_id` | ✅ | salesman 必须绑定该品牌 |
| `settlement_mode` | ✅ | 三选一：customer_pay / employee_pay / company_pay |
| `items[].product_id` | ✅ | 产品必须属于该品牌 |
| `items[].quantity` + `quantity_unit` | ✅ | 箱或瓶 |
| `unit_price` | ✅ | 指导价 |
| `deal_unit_price` | 看模式 | company_pay / employee_pay 必填 |
| `policy_template_id` | 有政策才填 | 可选 |

**Agent 建单前必先调**：
- `POST /orders/preview` — 拿到预览金额（应收 / 到手价 / 提成预估 / 政策差）
- `GET /policy-templates/templates/match?brand_id=X&cases=N&unit_price=Y` — 政策匹配

**展示给用户**的卡片必须含：
- 客户名
- 品牌 + 结算模式
- 商品明细
- 指导价总额 / 客户实付 / 业务员垫付 / 公司应收 / 预估提成
- 匹配到的政策（如有）

---

## 六、收款核心规则

### 路径 A：业务员上传凭证（P2c-1 核心）

```
POST /orders/{id}/upload-payment-voucher
```

**做什么**：
1. 建 Receipt（`status='pending_confirmation'`，`account_id=None`）
2. **不动账户**
3. Order.payment_status = `pending_confirmation`
4. 通知财务"有新凭证待审"

**Agent 对话**：引导业务员发图片 → 转到 ERP uploads → 调此接口。

### 路径 B：财务直接建（`POST /api/receipts`）

- 仅 finance/boss 权限
- 立即 `status='confirmed'`，立即动 master 账户
- 触发 apply_per_receipt_effects（应收分摊）
- 触发 apply_post_confirmation_effects（Commission/KPI/里程碑）
- **Agent 很少主动用**，除非财务明确说"我直接录"

### 路径 C：财务审批（最常见）

```
POST /orders/{id}/confirm-payment       # 批量批准该订单所有 pending
POST /orders/{id}/reject-payment-receipts  # 批量驳回
```

**铁律（all-or-nothing）**：一次审批该订单**所有** pending Receipt，不支持一条一条审。

---

## 七、政策核心规则

### 政策匹配

```
GET /policy-templates/templates/match?brand_id=X&cases=N&unit_price=P
```

返回可用政策模板列表（0 / 1 / 多）。

**Agent 应对**：
- 0 条 → 告诉用户"没有匹配政策，无法下单"，不要硬塞
- 1 条 → 自动选用
- 多条 → 推卡片让用户挑

### 政策兑付链路

```
1. 物料出库：POST /policies/requests/{id}/fulfill-materials
2. 提交凭证：POST /policies/requests/{id}/submit-voucher（actual_cost）
3. 财务归档：POST /policies/requests/{id}/confirm-fulfill（幂等）
4. 厂家到账：POST /policies/requests/confirm-arrival（幂等；F 类账户 += arrival）
   或    POST /manufacturer-settlements/import-excel + apply-reconcile（Excel 批量）
```

**关键区分**：`fulfilled`（给了客户）≠ `arrived`（厂家打款了）。

### 厂家 Excel 对账（v2）—— 只对方案号 + 严格金额

`POST /manufacturer-settlements/import-excel?brand_id=X` 上传 Excel **只做预览**，不动账。返回三段：
- **可自动入账**（`auto_eligible=true`）：方案号唯一匹中 + 金额严格相等
- **需人工**（`auto_eligible=false`）：方案号匹中但金额对不上 / 该项已到账
- **未匹配**：方案号/日期/备注/摘要全不匹中，或者多匹中

预览后用户在前端"批量入账"按钮触发 `POST /manufacturer-settlements/apply-reconcile`：
- 服务端再验一次 cost_total / 状态 / 品牌
- F 类账户 += amount，写 fund_flow（`f_class_arrival`），政策项 → arrived
- 写 audit_log（`reconcile.auto_apply`）

**五步匹配链**（按顺序，唯一匹中即用，多匹/0 匹进未匹配）：
1. 方案号严格相等
2. 单据日期 = applied_at 同一天
3. 金额 = 关联费用合计或面值
4. 备注 difflib 近似度 ≥0.8
5. 摘要严格相等或包含

**已入账过的方案号**（arrival_at IS NOT NULL）整条跳过，不出现在任何列表，避免重复导入混淆。

详见 `policies.md` 场景 7。

### 垫付返还自动触发（v2 — 含 customer/employee 两类）

**触发条件**：`PolicyRequestItem` 状态推进到 `fulfilled` + `advance_payer_type ∈ {employee, customer}` 时，`_trigger_advance_refund_if_fulfilled` 自动建一条 PENDING `FinancePaymentRequest`。

**关键事实**：
- `payable_account_type='cash'`、`payable_account_id=<品牌现金账户>` —— **支付源永远是品牌现金账户**，不允许 master / F 类 / financing。
- `source_request_item_id=ri.id`（FK → policy_request_items.id），用于 confirm-payment 时同步 actual_cost。
- 通知给 admin/boss/finance："政策垫付已到账，{customer/employee} 待返还 ¥X"。

**财务在审批中心批准后（confirm-payment）**：
- 强校验账户：必须 `cash + project + brand 匹配`，否则 400。
- 余额不足 400。
- 扣账 + 写 fund_flow（`related_type='advance_refund'`，notes=`垫付返还 PR-...`）。
- **额外**：`payee_type ∈ {customer, employee}` 时同步 `PolicyRequestItem.actual_cost += amount`，让利润台账 fclass_diff 对齐（不补会虚高）。
- 状态：pending → paid。

**advance_payer_type='company' 不走这条**：公司垫付不打款给任何人（公司自己花的钱），不建 PaymentRequest。

### 关联费用动账规则（v2 — 公司垫付即扣账）

`POST /api/policies/request-items/{item_id}/expenses` 录入关联费用时：

| `payer_type` | 创建即扣品牌现金？ | 何时累加 actual_cost |
|---|---|---|
| `company` | ✅ 立刻扣 | 创建/PUT/DELETE 同事务 |
| `customer` | ❌ 仅登记 | confirm-payment 批准 advance_refund 时 |
| `employee` | ❌ 仅登记 | 同上 |

**强校验**：
- 政策项 `fulfill_status='settled'` → 任何增删改一律 400（账已封盘）
- 品牌缺现金账户 → 400（先去账户管理建）
- 余额不足 → 400（不允许透支，提示走调拨）

**改/删处理**：
- PUT 按 `delta = new - old` 差额冲销，自动写正/反向流水
- DELETE 反向 credit + actual_cost 减回，**不允许从 settled 项删**

详见 `fund-flows-catalog.md` 场景 23 + 24，`policies.md` 场景 7.5。

---

## 八、库存规则

### 库存单位

**Inventory.quantity 永远是"瓶"**。入库箱单位时：
```
瓶数 = 箱数 × Product.bottles_per_case
```

### 出库类型（StockFlow.flow_type）

| 类型 | 触发 | 必须扫码？ |
|---|---|---|
| `order_out` | 订单出库 | ✅（高端酒/扫码品） |
| `policy_out` | 政策物料出库 | 可选 |
| `direct_out` | 手工出库 | ❌（但敏感，需授权） |
| `transfer_out/in` | 调仓 | - |
| `inspection_in/out` | 稽查回收/发出 | ✅ |
| `return_in` | 退货回仓 | - |
| `tasting_out` | 品鉴酒消耗 | - |

### 低库存预警

```
GET /inventory/low-stock?threshold=5
```

Agent 发现返回非空时主动推消息给 warehouse + 相关品牌的 boss。

---

## 九、工资规则

### 底薪来源

`EmployeeBrandPosition` 必须 `is_primary=true` 的那条决定：
- `BrandSalaryScheme.fixed_salary`（固定底薪）
- `BrandSalaryScheme.variable_salary_max × 考核完成率`（浮动底薪）
- `BrandSalaryScheme.attendance_bonus_full × 请假梯度`（全勤奖：0 天 100% / 1 天 80% / ... / ≥5 天 0%；迟到 = 0）

**无主属品牌 = 工资生成报错**（"未设置主属品牌"），Agent 引导 HR 去配置。

### 提成计算

```
Commission = comm_base × commission_rate × kpi_coefficient
```

- `comm_base`：订单的 `customer_paid_amount or total_amount`（按结算模式）
- `commission_rate`：EBP 个性化 > BrandSalaryScheme 默认
- `kpi_coefficient`：查 `kpi_coefficient_rules` 表（按品牌 + 完成率区间）

### KPI 系数规则（新功能）

由 boss/admin 在 `/hr/kpi-rules` 页面配置：
- 每条规则：品牌 × 完成率区间 [min, max) × 模式（linear/fixed）
- 默认 seed：<50% 系数 0；≥50% 按完成率线性
- 历史留存：改规则 = 旧记录 effective_to = 今天 + 新记录 effective_from = 今天
- 生成工资时冻结 `SalaryRecord.kpi_rule_snapshot` 字段

### 工资审批流

```
draft → pending_approval → approved → paid
```

- `draft / rejected`：允许 recompute（重算提成部分，不动 HR 手填罚款奖金）
- `approved / paid`：不能 recompute / delete（需反向凭证）
- recompute 权限：boss + admin

### 厂家补贴（不进工资条）

`ManufacturerSalarySubsidy` 独立记账：
- 生成：`POST /manufacturer-subsidies/generate-expected`（按 EBP.manufacturer_subsidy × 在岗天数）
- 到账：`POST /manufacturer-subsidies/confirm-arrival`（金额严格校验，动品牌 cash 账户）

---

## 十、稽查规则

### 5 种 case_type 必选 1

A 系列（我的酒跑出去了）：
- `outflow_malicious`（恶意窜货）
- `outflow_nonmalicious`（非恶意）
- `outflow_transfer`（被转码）

B 系列（别处的酒搞回来）：
- `inflow_resell`（回售入库）
- `inflow_transfer`（转码入库）

### 执行流程

```
create（填完整信息，profit_loss 后端算）
 → 审批（boss）
 → execute（SELECT FOR UPDATE，动账 + 动库存）
 → 归档
```

**删除铁律**：只允许 pending/approved/rejected 删，`executed/closed` **绝对拒绝**。

### 金额校验

execute 前预算 `total_debit`，品牌 cash 余额不够整体 400（让用户先调拨）。

---

## 十一、采购规则

### 付款金额必须对齐

```
cash_amount + f_class_amount + financing_amount == SUM(items.quantity × unit_price)
```

前端允许浮点精度容错 ±0.01。

### 收货前置状态

必须 `paid/shipped`（**品鉴仓例外**：任何状态都能收货）。已 `received/completed` 拒绝重复收货。

### 撤销付款

仅 `paid` 状态可撤销（已 received 的走退货）。`SELECT FOR UPDATE` 锁 payment_to_mfr + 余额校验。

---

## 十二、融资规则

### 还款类型

- `normal`：正常还款（现金扣本金+利息）
- `return_warehouse`：退仓（厂家代还本金，公司只付利息）

### F 类结算校验

F 类金额 > 0 时**预校验余额**，不够整体 400（历史 bug 已修）。

### 品牌一致性

- `submit_repayment`：校验 `pay_acc.brand_id == order.brand_id`
- `submit_repayment`：校验 `f_class_account.brand_id == order.brand_id`

### 并发锁

approve 时 `SELECT FOR UPDATE` 锁 repayment + order。

---

## 十三、审批中心聚合规则

用户（boss/finance）说"看一下今天要审啥"时，Agent 并行调：

```
GET /orders/pending-receipt-confirmation       # 收款
GET /orders?status=policy_pending_internal    # 政策
GET /purchase-orders?status=pending           # 采购
GET /accounts/pending-transfers               # 调拨
GET /payroll/salary-records?status=pending_approval  # 工资
GET /attendance/leave-requests?status=pending  # 请假
GET /payment-requests?status=pending          # 垫付返还
GET /expense-claims?status=pending            # 报销
GET /financing-orders/pending-repayments      # 融资还款
GET /expenses?status=pending                  # 费用
```

按用户角色过滤（salesman 不看这些），聚合成汇总卡片。

---

## 十四、跨品牌资金红线

**严格禁止的跨品牌资金动账**（后端已校验）：

1. 用别品牌的现金还本品牌融资（submit_repayment 校验）
2. 用别品牌 F 类结算本品牌融资（submit_repayment 校验）
3. A 品牌的 ManufacturerSettlement 分配到 B 品牌的 PolicyClaim（confirm_settlement_allocation 校验）

**允许的跨品牌资金流动**（需 boss 批准）：
1. `POST /accounts/transfer`：master → 品牌 / 品牌 → master / 品牌 → 品牌
2. 不同品牌销售同品牌补贴（ManufacturerSalarySubsidy 按销售品牌算，员工主属品牌算底薪）

---

## 十五、通用错误处理

| HTTP 状态 | 含义 | Agent 应对 |
|---|---|---|
| 400 | 业务校验错 | 原样显示 `detail`，不要自己解释 |
| 401 | 未登录或 token 过期 | 重新 exchange-token |
| 403 | 权限不够 | "你的角色没有此操作权限" |
| 404 | 找不到 | "资源不存在或不在你权限范围" |
| 409 | 冲突（唯一键等） | 展示冲突原因，让用户决策 |
| 500 | 系统错 | 记时间，让用户联系技术 |
| 超时 | 网络问题 | **不要自动重试动账接口** |

---

## 十六、审计日志

所有关键动作都有 `audit_logs` 记录：
- action（操作类型）
- entity_type + entity_id（实体）
- user_id（操作人）
- changes（变更内容）
- created_at（时间）

查询：`GET /audit-logs?action=X&entity_type=Y&date_from=...`

Agent 遇到"某笔钱为啥动了"类问题时可以调这个接口帮用户追溯。

---

## 十七、资金流闭环总图（必记）

```
客户回款 → master
  → 调拨到品牌 cash
    → 发工资 / 付政策垫付 / 还融资利息 / 付稽查回收 / 付报销

厂家政策到账 → 品牌 F 类
  → 普通模板政策先走 manufacturer_settlement 记主账
  → confirm-arrival 补记政策项到账状态/金额
  → company_pay 垫付回收时 F 类 → 品牌 cash

厂家工资补贴到账 → 品牌 cash（直接加）

融资放款 → 品牌 financing
  → 每期还款时 financing 销账 + 现金扣本息

采购付款 → 扣品牌 cash/F 类/financing
  → 同时 payment_to_mfr += cash+financing（记应付累计）
  → 撤销时反转

稽查 execute 时：
  A1/A2 扣品牌 cash（回收款）+ 罚款
  A3 扣 payment_to_mfr（被转码抵扣）
  B1 加品牌 cash（回售收入）
  B2 扣品牌 cash（买入）+ 加 payment_to_mfr

分货收款（share_out）：
  master += + payment_to_mfr -=（双记账）
```

---

## 十八、Agent 行动前的自检清单（每次都要过）

动任何**涉及金额或状态变更**的接口之前，Agent 必须心里过一遍：

1. ✅ **用户是谁（角色）？** 有没有权限调这个接口？
2. ✅ **当前实体状态是什么？** 允许转到目标状态吗？
3. ✅ **会动哪些账户？** 每个账户的方向和金额对吗？余额够吗？
4. ✅ **关联什么其他实体？** 会触发什么副作用（Commission / 通知 / 里程碑）？
5. ✅ **是否可逆？** 不可逆的话用户真的准备好了吗？
6. ✅ **幂等吗？** 如果 Agent 恶意重试会怎样？

Agent 不能保证完美——但**必须把"可能的错账"告诉用户再让他决定**。

---

## 十八点五、2026 Q2 新增业务决策（必记）

老板对 4 个边界场景拍板后的规则，Agent 回答时要按这些走，不能说"系统做不到"：

### 决策 #1：跨月退货提成一定要追回（m6c1）

- **原则**：已 settled 的 commission **不改原记录**，建一条 `is_adjustment=True` 的负数 Commission (`status=pending`)，下月工资单扫入扣回
- **挂账**：当月工资不够扣 → `actual_pay=0` + 挂一条 `SalaryAdjustmentPending`，下月先扣历史挂账再算当月
- **幂等保证**：
  - 应用层 `approve_return` 开头 `SELECT FOR UPDATE` 锁申请 + 订单
  - DB 层 `commissions.adjustment_source_commission_id` partial UNIQUE（`WHERE is_adjustment=true`）
- **Agent 读取入口**：`GET /api/payroll/salary-records/{id}/detail` 返回 `clawback_details[] / clawback_settled_history[] / clawback_new_pending[]`；业务员 miniprogram 也能看 `/api/mall/workspace/my-commissions?status=adjustment`

### 决策 #2：月榜快照 + 实时双模式（m6c4）

- **原则**：每月 1 号 00:05 `job_build_last_month_snapshot` 冻结上月 KPI；之后退货不影响快照数字；老板看实时 vs 快照自由切
- **表**：`mall_monthly_kpi_snapshot(employee_id, period UNIQUE)`
- **端点**：
  - `GET /api/mall/admin/dashboard/salesman-ranking?mode=snapshot|realtime&year_month=YYYY-MM`
  - `POST /api/mall/admin/dashboard/salesman-ranking/build-snapshot?year_month=YYYY-MM`（admin/boss 手工补）
  - `POST /api/mall/admin/dashboard/salesman-ranking/build-snapshot-range?from_month&to_month`（批量历史补）
- **Agent 回答口径**：发完奖金后应以 **snapshot** 数字为准；看趋势（谁在进步）以 **realtime** 为准

### 决策 #3：门店零售支持散客（m6c2）

- **原则**：门店客户不一定是小程序会员；`customer_id` 可空，`customer_walk_in_name/phone` 作为营销用快照
- **字段**：
  - `store_sales.customer_id` nullable
  - `store_sales.customer_walk_in_name` / `customer_walk_in_phone` 选填
  - `store_sale_returns.customer_id` 同步 nullable
- **散客退货**：照常走 apply_return + approve_return，不因 customer_id=NULL 拦截
- **Agent 帮店员下单时**：如果客户没说明是会员，直接用散客模式提交；会员模式必须能确认客户 id

### 决策 #4：商品销量 total vs net 双字段（m6c3）

- **原则**：总销量（含退货历史）和净销量（扣退货）两个视角都要有
- **字段**：
  - `MallProduct.total_sales` = 累计售卖瓶数（不回退）
  - `MallProduct.net_sales` = 净销量（退货时扣，保底 0）
- **排序切换**：首页 `/api/mall/products?sort=hot`、搜索、榜单都改用 `net_sales`
- **展示规则**：
  - C 端默认显示 `total_sales`（习惯口径）
  - 后台 ProductList 显示"总/净"，净 < 总时标红
  - schema 同时返回 `soldNum` + `netSoldNum`

---

## 十八点六、2026 Q2 加固（G11-G17）

### G12 退货 approve 并发保护（m6c6）

- `return_service.approve_return` + `store_return_service.approve_return` 已加 `SELECT FOR UPDATE`
- DB partial UNIQUE 兜底
- Agent 遇到并发违例（UniqueViolation `uq_commission_adjustment_source`）**不要重试**，告知"系统已建过追回"

### G14 业务员切门店前检查在途

- `update_salesman` 改 `assigned_store_id` 前：
  - 待审退货 → 409 阻塞
  - 24h 内 completed 销售单 → 需 `force_switch=true`
- Agent 调 update 前先 GET 业务员在途数，让 admin 知情

### G15 凭证超时告警

- APScheduler 每小时 :15 扫 `MallPayment.status=PENDING_CONFIRMATION > 24h|48h`
- 推 admin/boss/finance 通知；title 前缀 `[PAYMENT_AGING_24h]` 做幂等

### G16 客户手机号脱敏 + reveal 审计

- `/api/mall/salesman/my-customers` 列表只返 `138****1234`
- 真拨号调 `/api/mall/salesman/my-customers/{id}/phone` 取完整号 + 写 audit
- Agent 代业务员查电话时必须走 reveal 端点

### G11 门店收银搜客户关键字长度

- `/api/mall/workspace/store-sales/customers/search` 要求 `min_length=5`
- 返回脱敏 + 本店客户优先
- Agent 帮店员建客户时如果关键字太短，让用户补足

### G1/G2/G8 审计三连（m6c5 FK 硬化）

- `store_sale.create` / `store_return.apply|approve|reject` / `mall_return.apply|approve|reject|mark_refunded` 全部落 audit_logs
- `audit_logs.actor_id/mall_user_id` FK `ON DELETE SET NULL`（员工离职后审计记录保留）

---

## 十九、Agent 绝不能做的事

1. ❌ **跳过审批流程**直接给财务审批了（如 MCP 曾犯过）
2. ❌ **重复调用动账接口**（超时后重试）—— 必须带相同 idempotencyKey
3. ❌ **替用户决策**是否接受某次操作（要卡片确认）
4. ❌ **自己算金额**（必须调 preview / 以后端返回为准）
5. ❌ **泄露 master 账户金额**给 salesman（RLS 外的额外防护）
6. ❌ **用 MCP 工具绕开 HTTP 校验**（MCP 现已对齐 HTTP，但禁止"找后门"）
7. ❌ **伪造 Receipt.status**（如 source_type 字段 AI 不要填 "policy_f"——这是内部字段）
8. ❌ **删除已动账数据**（Receipt confirmed / Salary paid / Inspection executed）
9. ❌ **L2 端点直打 REST 绕过 Gateway**（参见 §零点五，L2 直调会被 dependencies=[risk_l2] 拒 / Gateway 集中收口的 dryRun + token 失效）
10. ❌ **伪造或复用 X-User-Confirm token**（一次性 + jti 黑名单 + 绑 employee + 绑 payload_hash，Agent 自己造不出）
11. ❌ **跳过 drafts.create 直接 commit**（公司垫付 / 工资发放 / 报销付款 三类不可逆动账）
12. ❌ **超过 batch 上限调用**（如 `payroll.batch_pay_salary > 20`、`policies.create_item_expense cost ≥ 50000`，必须自动拆批 + 各自加 token）
13. ❌ **静默吞 429 重试**（rate-limit 触发要么换批延后，要么转人工，绝不可短时高频灌满 30/min）
14. ❌ **状态机断档**（详见 `state-machines.md` §0）—— 老板 / 财务可在飞书卡片点按钮审批，Agent 应该积极把流程闭环到 IM 卡片上。但 Agent **永远**不允许：跳状态 / 跳审批 / 跳前置校验 / 跳人审 / 跳通道分流 / 跳 drafts / 跳金额校验。**核心立场**：禁忌不是不让 Agent 干活，而是不让 Agent 脱离状态机乱搞。用户说"直接结了 / 跳过审批"，Agent 不是甩手"做不了"，而是**把状态机里下一个合法节点找出来 + 推卡片让用户一键完成**。

