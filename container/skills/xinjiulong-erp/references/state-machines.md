# 状态机完全手册

所有业务实体的状态流转。Agent 操作前必须核对**当前状态 → 允许的下一状态**，调用允许不通过的 transition 会被后端 400 拒。

---

## 0. Agent 状态机铁律（最高优先级）

### 0.0 核心立场（必读）

**所有"铁律 / 禁忌 / 不能做"不是不让 Agent 干活，而是不让 Agent 脱离状态机乱搞。**

Agent 在新鑫久隆 ERP 里的职责是**积极帮员工干活**：

- ✅ 帮老板 / 财务在飞书把待审单聚合 → 推卡片让一键审完
- ✅ 帮业务员建客户 / 建订单 / 上传凭证 / 查业绩 / 查工资
- ✅ 帮财务录公司日常费用 / 员工报销 / 调拨申请 / 厂家政策对账
- ✅ 帮稽查发起案件 / 推进材料
- ✅ 减少所有人的打字成本——只要状态机允许，Agent 都该把流程闭环到飞书 IM 卡片上

但 Agent **永远不允许**把这些活"跳着做"——状态机是业务规则的硬骨架，跳了就是数据失真、责任不清、审计断裂。

### 0.1 老板 / 财务的审批 → 走飞书小卡片，**沿着状态机推**

老板（boss）和财务（finance）的所有审批动作都可以在飞书 IM 卡片上点按钮完成 —— Agent 把当前实体 + 候选 transition + 副作用预览推成卡片，用户点"通过 / 驳回"按钮后，Agent 走标准 `/api/agent/execute` + X-User-Confirm 路径调相应 transition 端点。这是**主流程**，Agent 应该尽可能多地把审批 / 录入 / 查询都做成这种"卡片一键确认"的体验。

**但是无论卡片做得多顺手，Agent 永远不能做"断档"动作**：

```
合法：order.policy_pending_internal ──approve_policy──→ order.approved
合法：order.fully_paid + receipt.confirmed ──confirm_fulfill──→ policy.settled
非法：order.pending ──"跳到"──→ order.completed              （跳了 5 个状态）
非法：policy.applied ──"直接 settled"──→ ……                  （跳了 arrived/fulfilled/paid）
非法：salary.draft ──"直接 paid"──→ ……                       （跳了 pending_approval/approved）
```

### 0.2 什么叫"断档"

下面这些都属于断档，Agent 看到用户说"直接给我结了 / 跳过审批 / 不用走流程"**必须拒绝**：

1. **跳状态**：从 A 状态调一个只接受 B 状态作输入的 transition（例：`policies.confirm_fulfill` 后端硬要求关联订单 `payment_status='fully_paid'`，没付清调就是 400）
2. **跳审批**：直接调 `/confirm-payment` / `/pay` / `/execute` 等动账端点，绕过先 `/approve` 的人工节点
3. **跳幂等性**：超时后用新 idempotencyKey 重试 —— 可能造成重复扣账
4. **跳前置校验**：建订单时 `payment_status` 不对、调拨时余额不够、出库时库存为 0、报销时 brand_id 缺失等，Agent **不能**自己绕开
5. **跳人审**：把 dryRun 看到的 preview 直接当作"已批准"，跳过用户在卡片点确认这一步
6. **跳通道分流**：试图用 `X-Channel: web_ui` 绕开 `require_user_confirm`（后端会检测真实来源 + audit 留痕）
7. **跳 drafts 两阶段**：不可逆动账（公司垫付 / 工资发放 / 报销付款）必须 `drafts.create → 卡片 → drafts.commit`，不能跳过 create 直接 commit
8. **跳金额校验**：preview 显示 ¥27000，commit 时改成 ¥1（payload_hash mismatch 后端立即拒）

### 0.3 状态机的两条铁律

**铁律 1：状态只能正向流转，不能跳号**

每个实体的状态机都是**严格有向图**（少数允许逆向走如 `policy_pending_internal → policy_rejected`），Agent 调一个 transition 端点时，后端会校验"当前实体状态 ∈ allowed_from"，不符合直接 400 + 中文错误。Agent **必须**先 `GET` 当前状态再决定调哪个 transition，绝不能拍脑袋。

**铁律 2：transition 必带的前置条件全部满足**

每个 transition 都有自己的前置条件（业务规则），后端硬校验：

| transition | 后端硬校验的前置条件 |
|---|---|
| `orders.approve_policy` | 当前 status = `policy_pending_internal`；订单关联政策已申请 |
| `orders.confirm_payment` | 所有 Receipt.status = `pending_confirmation` 且金额合计 = 应收 |
| `policies.confirm_arrival` | 当前 fulfill_status = `applied`；arrival_amount > 0 |
| `policies.confirm_fulfill` | **关联订单 payment_status='fully_paid'**（跨模块时序）|
| `inspections.execute_case` | 案件 status = `approved`；品牌现金账户余额够扣 |
| `purchase.approve` | PO status = `pending`；账户余额 ≥ 应付 |
| `purchase.receive` | PO status = `approved`；每瓶必须扫码（不准散装入库）|
| `drafts.commit` | draft.status = `pending`；payload_hash 跟 token 嵌的 hash 一致；未过期 |
| `expense_claims.pay` | claim.status = `approved`；账户余额够扣 |
| `transfers.execute` | request.status = `approved`；每瓶必须扫码（不准散装过户）|

**Agent 看到 400 + "状态不对"/"余额不足"/"未付清"/"未扫码" 类错误**：**原样转给用户**，**不要自己理解后绕过**——后端 400 是业务规则在起作用，是对的。

### 0.4 飞书卡片审批的正确模板

```
老板 / 财务对话：
  "看看待审的订单收款"

Agent：
  1. POST /api/agent/execute  operation=query.orders  payload={pending_receipt_confirmation: true}
  2. 飞书卡片展示 N 条待审 → 用户点其中一条 "查看详情"
  3. POST /api/agent/execute  operation=orders.confirm_payment  payload={order_id}  dryRun=true
  4. 飞书卡片展示 dryRun.result：
     "订单 SO-xxx 张三烟酒店
      应收 ¥27000（customer_pay）
      本次上传 3 张凭证合计 ¥27000（全款）
      执行后：
      - master 现金 +¥27000（当前 ¥120K → ¥147K）
      - Receipt × 3 → confirmed
      - 业务员李四 commission +¥1350（基于指导价）
      [✅ 通过] [❌ 驳回]"
  5. 用户点 "✅ 通过"
  6. IM 后端 → POST /api/confirm-tokens
       { action: "orders.confirm_payment", payload: { order_id } }
     拿一次性 token
  7. POST /api/agent/execute
       Headers: { x-user-confirm: token, idempotencyKey: <uuid> }
       operation=orders.confirm_payment
       payload={ order_id }
       dryRun=false
  8. update_card → "✅ 已确认收款 SO-xxx，master 现金 ¥147K"
```

**关键**：用户在飞书点的"通过"按钮 = 状态机 transition 的人审节点。Agent 在卡片预览（步骤 4）的内容必须跟 dryRun 返回**完全一致**，**不能**展示给用户"通过"，但 commit 时偷偷改 payload —— payload_hash 不一致 token 立即失效（403）。

### 0.5 Agent 看到"想跳"的话术，标准回应

| 用户话术 | Agent 应回应 |
|---|---|
| "直接把这单结了"（status 还在 pending）| "这单还在 X 状态，需要先经过 Y/Z 节点。我帮你推 Y 节点的卡片？" |
| "跳过审批批了吧" | "审批不能跳。我把当前待审单聚合给你，你在卡片上挨个点通过就行" |
| "金额我看就 ¥10000 行了"（不去查 preview） | "应收数字以系统 preview 为准，我先调 preview 拿真实金额给你看" |
| "钱不够先扣着，回头补" | "余额不足是后端硬校验，不能绕开。我帮你建调拨申请补足，再来这一步？" |
| "我手动签个 token 给你" | "X-User-Confirm token 是 IM 后端签发的一次性 capability token，AI 不能造。你在卡片上点确认按钮自动会签" |

详细禁忌见 `business-rules.md` §零点五 + §十九，违反会被后端各种 400 / 403 拦截 + audit_logs 留痕。

---

## 1. Order（订单）— `OrderStatus`

```
pending → policy_pending_internal ──┬──→ approved → shipped → delivered → completed
                                    │                                    ↑
                                    └──→ policy_pending_external → approved
                                                                         │
                                    (任何 pending 阶段可驳回)            │
                                          ↓                              │
                                     policy_rejected ←─────────────────┐ │
                                          ↓                            │ │
                                     (修改后重提)                       │ │
                                          → policy_pending_internal ──┘ │
                                                                         │
                                              partial_closed ←───────────┤
                                               (delivered >60d 未全款)   │
```

| 状态 | 中文 | 能进的下一状态 | 前置校验 | 触发动作 |
|---|---|---|---|---|
| `pending` | 待提交 | `policy_pending_internal` / `policy_rejected`（删） | salesman/sales_manager/boss 创建 | `POST /orders/{id}/submit-policy` |
| `policy_pending_internal` | 内部待审 | `policy_pending_external` / `approved` / `policy_rejected` | boss 审批 | `POST /orders/{id}/approve-policy`（`need_external` 决定走哪条） |
| `policy_pending_external` | 厂家外审 | `approved` | 厂家账户确认 | `POST /orders/{id}/confirm-external` |
| `approved` | 已审批 | `shipped` | warehouse 扫码出库 | `POST /orders/{id}/ship` |
| `shipped` | 已出库 | `delivered` | 送达确认（上传送货照片） | `POST /orders/{id}/upload-delivery` + `/confirm-delivery` |
| `delivered` | 已送达 | `completed`（走 confirm_payment 自动） / `partial_closed` | payment_status=fully_paid 时自动 → completed | 自动（见下） |
| `completed` | 已完成 | （终态） | Receipt 全部 confirmed 且合计 ≥ 应收 | 由 `confirm_payment` 触发 |
| `policy_rejected` | 已驳回 | `policy_pending_internal`（重提） | salesman 修改订单后 | `POST /orders/{id}/resubmit` |

**禁止的转换**（调用会 400）：
- 跳过 `policy_pending_internal` 直接到 `approved`（MCP 以前有 bug，已修）
- `completed` 状态改回其他（一旦完成不可逆）
- `shipped` → `pending`（状态只能向前）

**钱的副作用**（哪些状态转换会动账）：
- `approved → shipped`：扣库存（StockFlow 类型 `order_out`），不动账户
- `delivered → completed`（由 confirm_payment 触发）：Receipt status 转 confirmed → 入 master 现金池，生成 Commission

---

## 2. Receipt（收款凭证）— `PaymentStatus` 里的 receipt.status 字段

```
pending_confirmation ──(财务批准)──→ confirmed ──(终态)
         │
         └─(财务驳回)──→ rejected ──(终态)
```

| 状态 | 中文 | 什么时候生成 | 动账吗？ |
|---|---|---|---|
| `pending_confirmation` | 待确认 | 业务员 `upload-payment-voucher` | ❌ 不动账 |
| `confirmed` | 已确认 | 财务 `/orders/{id}/confirm-payment` 批准 | ✅ 此时才入 master 现金 + 生成 Commission |
| `rejected` | 已驳回 | 财务 `/orders/{id}/reject-payment-receipts` | ❌ 不动账，存根备查 |

**特殊路径**：finance/boss 直接调 `POST /api/receipts` 建 Receipt，**status 立即=`confirmed`**（跳过 pending，因为是财务自己建）。

**聚合过滤铁律**：所有 `SUM(Receipt.amount)` 必须加 `WHERE Receipt.status='confirmed'`，否则把 pending/rejected 也算进去（历史有 5 处 bug 已修）。

---

## 3. Order 的 PaymentStatus

```
unpaid ──(业务员上传凭证)──→ pending_confirmation ──(财务审批通过)──→ partially_paid
                                                                         │
                                                                (再多笔 Receipt 审批累加到 ≥ 应收)
                                                                         ↓
                                                                    fully_paid
                                                                         │
                                                                    (此时 Order.status = completed)
```

| 状态 | 中文 | 说明 |
|---|---|---|
| `unpaid` | 未付款 | Order 创建默认；没有任何 Receipt 或全 rejected |
| `pending_confirmation` | 待确认 | 有 pending Receipt 但还没 confirmed（订单锁定，不能改） |
| `partially_paid` | 部分已付 | 有 confirmed Receipt 但合计 < 应收 |
| `fully_paid` | 全款到账 | confirmed Receipt 合计 ≥ `customer_paid_amount` |

**达到 `fully_paid` 时**一次性触发：
1. 生成 Commission（pending 状态，按员工品牌提成率 × 应收基数）
2. 刷新 KPI `actual_value`
3. 推销售目标里程碑通知（50% / 80% / 100% / 120%）

---

## 4. InspectionCase（稽查案件）— `InspectionCaseStatus`（实际字符串，不完全匹配 enum）

```
pending ──(boss 审批)──→ approved ──(execute)──→ executed ──(归档)──→ closed
```

| 状态 | 中文 | 能做什么 | 动账吗？ |
|---|---|---|---|
| `pending` | 待审批 | boss 改/审/删 | ❌ |
| `approved` | 已审批 | 可 execute / 可删 / 可驳回 | ❌ |
| `executed` | 已执行 | 归档 / 利润台账读它 / **不可删**（库存账户已变） | ✅ 扣/加品牌现金 + 入库/出库 + A3/B2 动 payment_to_mfr |
| `closed` | 已关闭 | （终态） | ❌ |
| `rejected` | 已驳回 | 可删 | ❌ |

**删除规则**：只允许 `pending / approved / rejected` 状态删；`executed / closed` **绝对拒绝**（历史 bug：拒绝列表漏 `executed`，导致已执行案件被删库存账户错乱，已修）。

**execute 动作**：后端用 `SELECT FOR UPDATE` 锁 case 防并发双扣。

---

## 5. PurchaseOrder（采购单）— `PurchaseStatus`

```
pending ──(boss/finance 审批)──→ approved ──(付款)──→ paid ──(warehouse 收货)──→ received ──→ completed
   │                                                           │
   └──(驳回)──→ cancelled                                      │
                                                               │
    paid ──(finance 撤销)──→ cancelled（FOR UPDATE + 余额校验）│
```

| 状态 | 中文 | 能做什么 |
|---|---|---|
| `pending` | 待审批 | boss/finance 审批 / 驳回 / 删 |
| `approved` | 已审批 | 付款（`approve` 内已做，直接进 paid） |
| `paid` | 已付款 | warehouse 收货；财务可撤销 |
| `shipped` | 已发货 | warehouse 收货 |
| `received` | 已收货 | （自动→ completed 或归档） |
| `completed` | 已完成 | （终态） |
| `cancelled` | 已取消 | （终态；从 pending 或 paid 撤销来） |

**接收（receive）的前置状态铁律**：
- 必须 `paid / shipped`（品鉴仓例外——品鉴仓任何状态都能入库，因为不走付款审批）
- 已 `received / completed` 的必须 **400 拒绝重复入库**（历史 bug：MCP 没挡，已修）

**Phase B 后 receive 副作用**（purchase.py:_do_receive_purchase_order）：
- ERP 仓（main/backup/tasting/store）+ mall 仓 **统一**强制传 `barcodes_by_item: [{item_id, barcodes[]}]`，barcodes 长度 = item.quantity
- 同事务写三张表：`inventory_barcodes`（库存视图）+ `barcode_registry`（全局唯一所有权）+ `barcode_events`（PURCHASE_RECEIVE 事件）
- 任一步失败整事务回滚，没有"先 receive 成功再补条码"的两阶段窗口
- 跨仓重复同码 → 409（registry first PK 互斥拦截）
- scope=store/mall **杂货**走 `_receive_store_goods` / `_receive_mall_goods` 按数量入库，不扫码、不写 barcode 表

**`scope` 字段决定收货分流**（不是收货状态机的一部分，但建单到收货全链有效）：
- `scope='liquor'`（白酒）→ 走扫码主路径
- `scope='store'`（门店杂货）→ store_products 数量入库
- `scope='mall'`（商城杂货）→ mall_products 数量入库

**付款撤销（cancel_paid_purchase_order）**：
- `SELECT FOR UPDATE` 锁 `payment_to_mfr` 账户 + 校验余额足够反扣
- 已 `received` 的不能撤销（库存已变），走退货流程

---

## 6. FinancingOrder（融资单）— `FinancingOrderStatus`

```
active ──(每次还款)──→ partially_repaid ──(全部还清)──→ fully_repaid
   │
   └──(退仓，厂家代还本金)──→ returned（非 enum 标准值，实际字符串）
   │
   └──(违约)──→ defaulted
```

FinancingRepayment 子状态：
```
pending ──(boss 审批)──→ approved ──(扣款成功)──→ （终态）
   │
   ├──(boss 驳回)──→ rejected
   │
   └──(现金余额不足自动驳回)──→ rejected
```

**并发控制**：`approve_repayment` 必须 `SELECT FOR UPDATE` 锁 repayment + order（否则并发 approve 时 `repaid_principal +=` 会丢一笔还款，历史 bug 已修）。

**余额校验**：F 类金额 > 0 时 **预校验 F 类账户余额足够**，否则整体 400（历史 bug：静默跳过导致现金已扣但 F 类没扣，账务失衡，已修）。

**跨品牌**：`submit_repayment` 必须校验 `pay_acc.brand_id == order.brand_id`（历史 bug：无校验可跨品牌串账，已修）。

---

## 6.5 Commission（提成）— `status` 字段 + is_adjustment 旗标（决策 #1）

```
(订单 confirm_payment / partial_close / 门店收银提交)
  └──→ pending ──(月底进工资单 generate_salary_records)──→ settled ──(工资单 pay)──→ (终态)
         │
         │ 退货批准 (approve_return / store_return.approve_return):
         ├──→ reversed            (原状态还是 pending → 直接抹掉，工资单 filter 自动排除)
         │
         └──→ 原 status='settled'（上月已发工资）
                → 新建一条 Commission(
                    is_adjustment=True,
                    commission_amount=-原金额,
                    adjustment_source_commission_id=原.id,
                    status=pending
                  )
                → 下月工资单扫到这条负数行，自动扣回
                → 若下月工资不够扣，走 salary_adjustments_pending 挂账下月再扣
```

| 字段 | 语义 |
|---|---|
| `status` | pending / settled / reversed |
| `is_adjustment` | 标识这条是跨月退货追回的负数行；不是独立状态 |
| `adjustment_source_commission_id` | 指向原 settled commission，partial UNIQUE index 保证"同一源只能有一条追回"（m6c6 DB 兜底） |

**Agent 读懂这几种场景的话术**：

| 业务员问 | Agent 回答依据 |
|---|---|
| "为啥我 3 月工资少 ¥100？" | 查 `SalaryRecord.clawback_details[]`（GET `/api/payroll/salary-records/{id}/detail`），展示原订单号 + 原金额 + 退货原因 |
| "今年退了多少？" | `/api/mall/workspace/my-commissions?status=adjustment&year=2026` |
| "上月还没发的提成还会扣吗？" | 查 `status=pending` 的数量——这些下月工资单才会 settled；若上月工资已发，追回走负数 adjustment（不动已 settled） |

**幂等铁律**：  
- 应用层：`approve_return` 先 `SELECT FOR UPDATE` 锁住 return request（G12 修复，m6c6 前有并发漏洞）  
- DB 层：`commissions.adjustment_source_commission_id` partial UNIQUE（`WHERE is_adjustment=true`）阻止双重追回

---

## 7. SalaryRecord（工资单）— 字符串字段，非 enum

```
draft ──(submit)──→ pending_approval ──(boss 批准)──→ approved ──(finance 发放)──→ paid
   │                                        │
   │                                        └──(boss 驳回)──→ rejected
   │                                                               │
   │                                                               └──(HR 修改后重提)──→ pending_approval
   │
   └──(boss/admin recompute)──→ draft（重算 KPI 提成）
```

| 状态 | 中文 | 允许的操作 |
|---|---|---|
| `draft` | 草稿 | HR 改明细 / 提交审批 / 删 / recompute |
| `pending_approval` | 待审批 | boss 批/驳 |
| `approved` | 已审批 | finance 发放（扣品牌现金） |
| `rejected` | 已驳回 | HR 修改后重新提交 / recompute |
| `paid` | 已发放 | （终态） |

**`recompute` 铁律**：仅允许 `draft / rejected` 状态。已 `approved / paid` 的必须走反向凭证冲正（历史需求）。

**并发**：`pay_salary` 需要 `SELECT FOR UPDATE` 锁 SalaryRecord（否则两个财务同时发放会双扣）。

---

## 8. ExpenseClaim（报销）— 字符串字段

```
pending ──(boss/finance 审批)──→ approved ──┬──(F 类流程)──→ applied → arrived → fulfilled → settled
                                             │
                                             └──(日常流程)──→ paid → settled
            │
            └──(boss/finance 驳回)──→ rejected
```

| 状态 | 中文 | 允许操作 | 动账吗？ |
|---|---|---|---|
| `pending` | 待审批 | 批 / 驳 / 删 | ❌ |
| `approved` | 已审批 | F 类走 apply / 日常走 pay | ⚠️ share_out 类型此时动账（master + ptm） |
| `applied` | 已申请厂家 | 对账（厂家到账） | ❌ |
| `arrived` | 已到账 | 兑付 | ❌（到的是 F 类，由 confirm_arrival 处理） |
| `fulfilled` | 已兑付 | 归档 | ❌ |
| `paid` | 已付款（日常） | 归档 | ✅ 扣指定账户 |
| `settled` | 已归档 | （终态） | ❌ |
| `rejected` | 已驳回 | 删 | ❌ |

**删除规则**：只允许 `pending / rejected` 状态删（历史 bug：无状态校验，删已 approved 的 share_out 账户不回滚，已修）。

**驳回规则**：只允许 `pending` 驳回（已 approved 的 share_out 驳回不反转账户，需走反向凭证）。

---

## 9. PolicyRequestItem（政策申请明细）— 字符串 `fulfill_status`

正确的状态流（policies.py:1397 强约束 submit-voucher 必须前置 arrived/fulfilled）：

```
pending ──(fulfill-materials 出库物料)──────────────→ applied
   │                                                    │
   │              (confirm-arrival 厂家到账)            │
   │ ┌─────────────────────────────────────────────────┘
   ▼ ▼
applied ──(confirm-arrival 厂家到账, arrival_amount 写入)──→ arrived
                                                              │
                              (submit-voucher 上传凭证)        │
                                                              ▼
                                                          fulfilled
                                                              │
                              (confirm-fulfill 财务归档)       │
                                                              ▼
                                                          settled
```

| 状态 | 中文 | 触发动作 / 含义 |
|---|---|---|
| `pending` | 待兑付 | 刚创建，物料未出 |
| `applied` | 已申请 | 物料已出库（fulfill-materials 完成）|
| `arrived` | 已到账 | 厂家钱已打进 F 类账户（仅 `request_source='f_class'` 自动入账，普通模板只写 `arrival_amount/arrival_at`）|
| `fulfilled` | 已兑付 | 凭证上传完毕，等财务归档 |
| `settled` | 已归档 | 财务确认归档进利润台账 |

**Agent 必须知道的"哪个动作接哪个状态"**：

| 动作 | 入参允许的前置状态 | 推进到 |
|---|---|---|
| `fulfill-materials` | pending | applied |
| `confirm-arrival`（item 级）| applied / arrived（幂等）/ fulfilled / settled（仅补字段不改 status） | arrived（仅当前置是 applied）|
| `submit-voucher` | **arrived / fulfilled**（policies.py:1397 强校验，pending/applied 一律 400）| fulfilled |
| `confirm-fulfill` | fulfilled / settled（幂等） | settled |

**关键区分**：
- `fulfilled` = 给客户了（物料出库 + 凭证上传）
- `arrived` = 厂家把钱打给我们了
- 两条线独立：物料和到账互不阻塞，但 `submit-voucher` 要求 `arrived` 前置（先有到账才接得到凭证）

**幂等铁律**：
- `confirm-fulfill` 对已 `settled` 的 item 直接返回"已归档"；该动作现在只做归档，不再写 `settled_amount`
- `confirm-arrival` 对已写 `arrival_at` 的条目跳过；若条目已 `fulfilled/settled`，只补记 arrival 字段，不回退兑付状态

---

## 10. PolicyClaim（政策兑付 Claim）— `ClaimRecordStatus`

```
pending ──(allocation-confirm 分配到 settlement)──→ partially_settled ──(分配完)──→ settled
```

**跨品牌校验**：`confirm_settlement_allocation` 必须校验 `settlement.brand_id == claim.brand_id`（历史 bug：无校验走 company_pay 路径动别品牌账户，已修）。

---

## 11. PaymentRequest（垫付返还申请）— `PaymentRequestStatus`

```
pending ──(PUT /payment-requests/{id} status=approved 财务审批)──→ approved ──(POST /payment-requests/{id}/confirm-payment)──→ paid
   │                                                                                                                          ↑
   └──(PUT status=cancelled)──→ cancelled                                                                  扣品牌现金 + 写流水 + 推进 actual_cost
```

**两步合一**（finance.py:1618-1621 + finance.py:1675）：
- 步骤 A **审批**：`PUT /payment-requests/{id}`，body `{"status": "approved"}`。要求当前 `status=pending`，否则 400。批准时设 `approved_by=当前财务/boss employee_id`。
- 步骤 B **付款**：`POST /payment-requests/{id}/confirm-payment`。要求 `status=approved`，否则 400 "只有审批通过的付款申请才能确认付款"。**不能跨步直接 pending→paid**。

**自动生成时机**：`PolicyRequestItem.fulfill_status in ('fulfilled', 'settled')` + `advance_payer_type in ('employee', 'customer')` → 自动创建 PENDING 状态的 PaymentRequest。

**关键字段**（policies.py:212）：
- `request_type='advance_refund'` 或 `'general_payment'`
- `payee_type ∈ {employee, customer, other, supplier}`
- `payable_account_type='cash'`、`payable_account_id=<品牌现金账户>`
- `source_request_item_id=ri.id`（advance_refund 必填，新加字段）

**confirm-payment 时（approved → paid）**：
- 强校验账户：`account_type='cash' AND level='project'`，否则 400。**绝不允许**从 master / F 类 / financing 出。
- 余额不足 → 400。
- 扣账 + 写 fund_flow（`related_type='advance_refund'`，扣的是**品牌现金账户**，不是 `payment_to_mfr`）。
- **额外**：`request_type='advance_refund' AND source_request_item_id IS NOT NULL AND payee_type IN ('customer','employee')` → 同步 `PolicyRequestItem.actual_cost += amount`，让利润台账 `fclass_diff` 对得上（不补这一步会虚高）。
- `payee_type='company'` 走不到这条路径（公司垫付不建 PaymentRequest，actual_cost 在录关联费用时已累加）。

**Agent 不要直接写 PaymentRequest**——它由 submit-voucher 自动建。Agent 要做的是引导财务**先批准、再付款**这两步动作：
- 在审批中心点"批准付款"（PUT status=approved）
- 再点"确认已付"（confirm-payment）

如果用户问"为啥这条政策利润突然降了"，去查这条 advance_refund 是不是刚被批 → actual_cost 累加上去了 → fclass_diff 缩小，**这是正确**。

---

## 11.5 PolicyItemExpense（政策项关联费用）— `payer_type` × 动账行为

不是状态机，但和 11 强相关。

| `payer_type` | 创建即扣账？ | actual_cost 何时累加 | 修改/删除影响 |
|---|---|---|---|
| `company` | ✅ 立刻扣品牌现金 | 创建/PUT/DELETE 同事务累加/回滚 | PUT 按 delta 差额冲销，DELETE 反向 credit + actual_cost 减回 |
| `customer` | ❌ 仅登记 | 在 PaymentRequest confirm-payment 时累加 | 删除不影响账户（因为本来就没扣） |
| `employee` | ❌ 仅登记 | 同上 | 同上 |

**约束**：
- PolicyRequestItem 已 `fulfill_status='settled'` → 任何 PolicyItemExpense 增删改一律 400。
- 品牌缺现金账户 → company 类型 400 阻断。
- 现金余额不足 → 400 阻断（不允许透支）。

详见 `policies.md` 场景 7.5 + `fund-flows-catalog.md` 场景 23。

---

## 12. LeaveRequest（请假）— 字符串字段

```
pending ──(HR/boss 审批)──→ approved
                                │
                                └──(驳回)──→ rejected
```

**审批权限**：一般假 HR 审，超 5 天或特殊假种（婚假/产假/丧假）boss 审。

---

## 13. TransferRequest（品牌间调拨）

```
pending ──(boss 批准)──→ approved（执行扣 from + 加 to + 双 fund_flow）
   │
   └──(boss 驳回)──→ rejected
```

**权限**：只有 boss 能批调拨。

---

## 14. DraftAction（草稿态：不可逆动账两阶段提交）

ERP Gateway 阶段 1-4 引入的实体，**仅为 AI Agent 不可逆动账场景设计**（公司垫付 / 工资发放 / 报销付款）。普通员工 UI 不直接看到 draft —— 它由 AI Agent 创建、用户在 IM 卡片确认后 commit。

### 状态机

```
pending ──(commit 成功)─────→ committed（关联 reference_id 指向真实业务记录）
   │
   ├──(reject)───────────→ rejected
   │
   └──(创建后 24h 没 commit)─→ expired（定时任务清理）
```

### 字段语义

| 字段 | 含义 |
|---|---|
| `id` | draft UUID |
| `action` | 动作白名单：`policies.create_item_expense` / `payroll.batch_pay` / `expense_claims.pay` 等（agent_gateway 注册的不可逆动账 action 子集）|
| `payload` | JSON：commit 时直接喂给真实 handler 的入参（必须跟 IM 卡片预览一致）|
| `payload_hash` | sha256(payload)，X-User-Confirm token 绑这个 hash —— payload 篡改 token 自动失效 |
| `status` | `pending` / `committed` / `rejected` / `expired` |
| `created_by_user_id` | 创建人（必须 = JWT.sub，AI 不能替别人建 draft）|
| `created_at` / `committed_at` / `rejected_at` | 时间戳 |
| `reference_id` | commit 后指向真实业务实体（如 `policy_item_expenses.id`）—— 用来反查"这条费用是哪个 draft 落的" |
| `reject_reason` | 驳回原因 |
| `expire_at` | created_at + 24h，超时自动 expired |

### 状态变更触发

| 当前状态 | 事件 | 新状态 | 谁触发 |
|---|---|---|---|
| pending | `drafts.commit` 成功 | committed | Agent 携 X-User-Confirm 调 |
| pending | `drafts.reject` | rejected | 用户点 IM 卡片"取消" |
| pending | 24h 超时 | expired | APScheduler 清理任务 |
| committed | — | — | 终态，不可改 |

### 不变量（必查）

1. **commit 时 action 必须在白名单**（drafts.py 里硬编码的 6 个 action），否则 400。
2. **commit 时 payload_hash 必须等于 X-User-Confirm token 里嵌的 hash**，否则 403"payload 已篡改"。
3. **同一 draft 不可重复 commit**（jti 一次性 + draft.status 校验双闸门）。
4. **expired draft 不可被 commit**，必须重新走 drafts.create + 拿新 token。
5. **ref_id 一旦写入不可改**（避免 audit 链断裂）。

### 跟 X-User-Confirm token 的对应关系

```
draft.id          ←→  token.payload.draft_id
draft.action      ←→  "drafts.commit" (统一)
draft.payload_hash ←→ token.payload_hash  (绑定，篡改 hash 失效)
draft.created_by  ←→  token.sub          (绑定，别人的 token 进不来)
```

### Agent 错误处理

| 错误 | 含义 | Agent 处理 |
|---|---|---|
| 400 `action 不在白名单` | drafts.create 用了非 draft 类 action | 改成对应直调端点（场景里说明） |
| 400 `cost_amount ≥ 50000` | 单笔超限 | 拆成两个 draft，各自走 token 流程 |
| 403 `payload_hash mismatch` | commit 时 payload 跟 token 嵌的 hash 不一致 | 重新走 drafts.create + 新 token（绝不能"在 commit 前微调 payload"）|
| 403 `draft expired` | 超过 24h | 重新 drafts.create |
| 409 `draft 已被 commit / rejected` | 终态再次 commit | 告诉用户"已处理过"，查 reference_id 看落在哪条业务记录 |

详见 `ai-gateway.md` §7 范式 C、`business-rules.md` §零点五。

---

## 通用：所有"撤销"操作的边界

| 实体 | 可撤销的状态 | 不可撤销的状态（需走反向凭证） |
|---|---|---|
| Order | pending（删） | approved 之后（整个流程下沉到财务冲正） |
| Receipt | pending_confirmation（拒绝） | confirmed（建红冲 Receipt） |
| Payment | pending（admin 可删） | paid（建反向 Payment） |
| Expense | pending（删） | paid（建反向费用） |
| ExpenseClaim | pending / rejected | approved 之后的状态 |
| PurchaseOrder | pending（驳回） / paid（cancel） | received 之后（走退货） |
| InspectionCase | pending / approved / rejected | executed / closed（手工调账） |
| SalaryRecord | draft / rejected（删） | approved / paid（冲正） |
| TransferRequest | pending（驳回） | approved（走反向调拨） |
