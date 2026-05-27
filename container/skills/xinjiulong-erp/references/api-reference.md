# API 端点速查（按模块分组）

共 250+ 个端点。Agent 按当前业务意图只看对应小节。

**全部端点**都要 `Authorization: Bearer <JWT>`（除了 `/api/auth/login` 和 `/api/feishu/*`）。

**约定**：
- `{id}` 是路径参数
- 查询参数如 `brand_id` / `status` / `skip` / `limit` 大多可选
- 所有列表 GET 返回 `{items: [...], total: N}`

**风险等级标注**（详见 SKILL.md §5 + ai-gateway.md）：
- 🟢 **L0**（218 个）：只读 / 创建客户 / 上传凭证 / 个人设置 — Agent 直调
- 🟡 **L1**（48 个）：建订单 / 状态推进 / 出库 — Agent 直调，建议带 `X-Channel: ai-agent` + idempotencyKey
- 🔴 **L2**（38 个）：动账 / 跨模块 / 批量 / 强写 / **权限变更** — **Agent 必走 `/api/agent/execute` Gateway**（dryRun + X-User-Confirm + idempotency 集中收口）

L2 端点直打 REST 会被后端 `dependencies=[risk_l2]` 拒绝。完整 L2 清单见 §0 AI Gateway。

## 目录

0. [AI Gateway（写入类必经之路）](#ai-gateway)
1. [认证 Auth](#认证)
2. [飞书集成 Feishu](#飞书集成)
3. [订单 Orders](#订单)
4. [收款 Receipts](#收款)
5. [客户 Customers](#客户)
6. [政策 Policies](#政策)
7. [政策模板 Policy Templates](#政策模板)
8. [库存 Inventory](#库存)
9. [采购 Purchase](#采购)
10. [账户资金 Accounts](#账户资金)
11. [财务 Finance](#财务)
12. [稽查 Inspections](#稽查)
13. [清理案件 Cleanup](#清理案件)
14. [工资 Payroll](#工资)
15. [人事 HR](#人事)
16. [考勤 Attendance](#考勤)
17. [销售目标 Sales Targets](#销售目标)
18. [绩效 Performance](#绩效)
19. [融资 Financing](#融资)
20. [政策兑付核销 Manufacturer Settlements](#政策兑付核销)
21. [报销申请 Expense Claims](#报销申请)
22. [通知 Notifications](#通知)
23. [仪表盘 Dashboard](#仪表盘)
24. [品鉴 Tasting](#品鉴)
25. [上传下载 Uploads](#上传下载)
26. [审计日志 Audit](#审计日志)

## AI Gateway

**所有 L2 写入操作的统一入口**。详见 `ai-gateway.md`。

### Gateway 端点（5 个）

```
POST   /api/agent/describe                  返回当前 employee 能调的 operation 清单
POST   /api/agent/authorize                 预校验某 operation 当前 employee 能否调（不执行）
POST   /api/agent/execute                   ⭐ 核心执行入口：dryRun / idempotency / 真执行
POST   /api/agent/memory/get                跨对话 KV 读
POST   /api/agent/memory/upsert             跨对话 KV 写
```

### 必带 header

```
Authorization: Bearer <ERP-JWT>             员工身份（exchange-token 拿）
x-frontlane-timestamp: <unix-seconds>       HMAC 时间戳（±5min 容忍窗）
x-frontlane-nonce: <uuid>                   防重放（10min 内不可复用）
x-frontlane-signature: <hex>                HMAC-SHA256（msg = ts + "." + nonce + "." + body）
x-channel: ai-agent                         强烈推荐（audit_logs.actor_kind=ai_agent_assisted）
x-intent-id: <conv-id>                      可选，同次会话多次调用聚合
x-user-confirm: <jwt>                       L2 写入必须；dryRun=true 不需要
```

### Confirm Token 端点

```
POST   /api/confirm-tokens                  用户在 IM 卡片点确认后，IM 后端调此拿一次性 token
                                            body: { action, payload }
                                            返回: { token: <jwt>, expires_at }
                                            120s TTL + jti 黑名单 + 绑当前 employee + 绑 action + 绑 payload_hash
```

### Drafts 端点（不可逆动账两阶段）

```
POST   /api/drafts                          创建 draft（pending 状态，不动账）
GET    /api/drafts                          列出当前用户 pending drafts
GET    /api/drafts/{draft_id}               draft 详情
POST   /api/drafts/{draft_id}/commit        提交 draft（必带 X-User-Confirm，真落账）
POST   /api/drafts/{draft_id}/reject        驳回 draft
```

或直接通过 Gateway operation：`drafts.create` / `drafts.commit`。

### 31 个 L2 operation 速查表

| operation | 用途 | required_roles | drafts？ |
|---|---|---|---|
| `orders.confirm_payment` | 财务审批收款（动 master 现金）| boss/finance | 否 |
| `orders.approve_policy_with_request` | 老板审批政策（合并：Order + PR 同推）⭐ | boss | 否 |
| `orders.reject_policy_with_request` | 老板驳回政策（合并：Order + PR 同退）| boss | 否 |
| ~~`orders.approve_policy`~~ | ⚠️ legacy，**禁用**（只动 Order 不动 PR，ship 必失败）| — | — |
| `policies.confirm_arrival` | 政策项到账（动品牌 F 类）| boss/finance | 否 |
| `policies.confirm_fulfill` | 政策项归档（前置 fully_paid）| boss/finance | 否 |
| `policies.create_item_expense` (payer=company) | 公司垫付政策费用 | finance | **是** |
| `policies.update_item_expense` | 改公司垫付金额 | finance | **是** |
| `policies.delete_item_expense` | 删公司垫付（反扣）| finance | **是** |
| `policies.refund_advance` | 垫付返还（advance_refund）| boss/finance | 否 |
| `payroll.confirm_subsidy_arrival` | 厂家补贴到账 | boss/finance | 否 |
| `payroll.batch_pay` | 批量发工资（≤ 20 / 批）| finance | **是**（draft action `payroll.salary_records.pay`）|
| `payroll.pay_salary` | 单条发工资 | finance | **是**（同上）|
| `expense_claims.pay` | 员工报销付款（ExpenseClaim 流程）| finance | **是** |
| `finance.expenses.pay` | 公司日常费用付款（Expense 流程，前端「日常费用」Tab）| finance | **是** |
| `accounts.transfer` | 调拨（同品牌/master 内）| boss/finance | 否 |
| `accounts.approve_transfer` | 跨品牌调拨审批（动账）| boss | 否 |
| `accounts.manual_entry` | 手工加流水（反向凭证）| boss | 否 |
| `financing.confirm_arrival` | 融资放款到账 | boss/finance | 否 |
| `financing.pay` | 融资付款 | finance | **是** |
| `financing.repay` | 还融资本金 | finance | **是** |
| `purchase.approve` | 审批采购单（写应付）| boss/finance | 否 |
| `purchase.cancel_approval` | 撤销已批采购（反扣应付）| boss | 否 |
| `inspections.execute_case` | 稽查案件执行（多账户动）| boss | 否 |
| `inspections.return_to_warehouse` | 稽查回库（A1/A2）| boss | 否 |
| `receivables.write_off` | 应收坏账注销 | boss/finance | 否 |
| `drafts.create` | 创建 draft（不动账）| 各角色按 action | — |
| `drafts.commit` | 提交 draft（真落账，必带 token）| 各角色按 action | — |

### 调用范式速记

```
范式 A 只读：execute(query.*) 直接 dryRun=false（query.* 不支持 dryRun，跳过）
范式 B 写入：execute(op, dryRun=true) → 卡片 → /api/confirm-tokens → execute(op, dryRun=false, +X-User-Confirm)
范式 C 不可逆：drafts.create → 卡片 → /api/confirm-tokens(action=drafts.commit) → drafts.commit(+X-User-Confirm)
```

### 错误码

```
400 unknown operation: xxx          → operation 不在 /describe 返回的清单里
400 批量 size N 超过 OP 上限 K       → 拆批
400 cost_amount ≥ 50000             → policies.create_item_expense 单笔限额，拆
403 frontlane-timestamp/nonce/sig   → HMAC 三个 header 必须都带
403 signature mismatch              → HMAC SECRET 不一致
403 timestamp skew > 300s           → 时钟差距 > 5 min
403 nonce reused                    → 10 min 内 nonce 复用
403 需要角色之一: ...                → required_roles 校验失败
403 X-User-Confirm header 缺        → L2 写入必带
403 token 不属于当前用户              → token sub != JWT sub
403 token 已被使用过                  → 一次性，重新让用户确认
403 payload_hash mismatch           → drafts.commit 时 payload 跟 token 嵌的 hash 不一致
429 Rate limit exceeded             → 1 min 超 30 次写，等几秒
```

## 认证

前端入口 2026-05-22 整合：所有员工 / 账号 / 角色 / 品牌权限 / 门店权限的配置都集中在「**权限管理**」页 `/admin/permissions`（admin 专属一级菜单）。旧 `/hr/users`「登录账号」页 + `/store/accounts`「收银账号」页**已删除**，相关写入端点逐一升级为 **L2**（详见标注）。

```
POST   /api/auth/login                      🟢 L0 用户名密码登录拿 JWT
POST   /api/auth/refresh                    🟢 L0 用 refresh_token 换新 access_token
GET    /api/auth/me                         🟢 L0 当前用户信息
GET    /api/auth/users                      🟢 L0 用户列表（admin/boss/hr）
POST   /api/auth/users                      🟡 L1 创建用户账号（admin/boss/hr）
PUT    /api/auth/users/{user_id}            🔴 L2 更新用户（is_active 启停 等）— 挂 risk_l2 + require_user_confirm
PUT    /api/auth/users/{user_id}/roles      🔴 L2 改角色（admin）— 挂 risk_l2 + require_user_confirm
POST   /api/auth/users/{user_id}/reset-password  🔴 L2 重置密码 — 挂 risk_l2 + require_user_confirm
GET    /api/auth/roles                      🟢 L0 角色列表
```

## 飞书集成

```
POST   /api/feishu/bind                     绑定 open_id → ERP 账号（需 X-Agent-Service-Key）
POST   /api/feishu/exchange-token           open_id → 短期 JWT（需 X-Agent-Service-Key）
POST   /api/feishu/unbind                   解绑
```

## 平台基础接口（服务端到服务端，需 X-Agent-Service-Key）

```
GET    /api/users/by-role                   🟢 L0 按角色拉用户列表（FrontLane 平台按角色定向推飞书卡片用）
   Query: role (必)、active=true/false（默认 true 只返活跃用户；false 包含已禁用）
   Response: items[{user_id, username, employee_id, employee_name, feishu_open_id, is_active, roles[]}], total
   未绑飞书的用户 feishu_open_id=null（不过滤掉，让 agent 平台提示运营让他绑）
   unknown role → 400；缺 header → 422；key 错 → 401
```

## 订单

```
GET    /api/orders                                         列表（筛选：brand_id/status/payment_status/customer_id/salesman_id/keyword/date_from/date_to/skip/limit）
POST   /api/orders/preview                                 建单预览（算金额/匹配政策，不写库）
POST   /api/orders/create-with-policy                      🟡 L1 ⭐ **建单合并接口（必用）** —— 一个事务建 Order + PolicyRequest + items + submit-policy → status=policy_pending_internal
POST   /api/orders                                         ⚠️ **legacy 禁用** —— 只建 Order 不建 PolicyRequest，后续 ship 必失败 400 "无法出库：该订单没有已审批的政策申请"。Agent 请用 /create-with-policy
GET    /api/orders/{id}                                    订单详情
PUT    /api/orders/{id}                                    改订单（仅 pending 状态可改）
DELETE /api/orders/{id}                                    删订单（仅 pending 可删）
POST   /api/orders/{id}/submit-policy                      提交政策审批（仅老路径用；走 /create-with-policy 此步已包含）
POST   /api/orders/{id}/approve-policy-with-request        🟡 L1 ⭐ **批准政策合并接口（必用）** —— 同时推 Order.status + PolicyRequest.status=approved（推荐 Gateway `orders.approve_policy_with_request`）
POST   /api/orders/{id}/approve-policy                     ⚠️ **legacy 禁用** —— 只动 Order，PolicyRequest 仍 pending → ship 必失败
POST   /api/orders/{id}/reject-policy-with-request         🟡 L1 ⭐ **驳回政策合并接口（必用）** —— 同时回退 Order + PolicyRequest
POST   /api/orders/{id}/reject-policy                      ⚠️ **legacy 禁用** —— 只动 Order，PR 不变
POST   /api/orders/{id}/confirm-external                   厂家政策确认（外审）
POST   /api/orders/{id}/resubmit                           被驳回后重新提交
POST   /api/orders/{id}/ship                               出库（warehouse/boss）
POST   /api/orders/{id}/upload-delivery                    上传送货照片（warehouse）
POST   /api/orders/{id}/confirm-delivery                   送达确认
POST   /api/orders/{id}/upload-payment-voucher             上传收款凭证（P2c 核心，状态=pending_confirmation 不动账）
POST   /api/orders/{id}/confirm-payment                    🔴 L2 财务批准全部 pending Receipt（强制 Gateway `orders.confirm_payment` + dryRun + token）
POST   /api/orders/{id}/reject-payment-receipts            财务拒绝 pending Receipt
POST   /api/orders/{id}/complete                           标记完成（兜底）
GET    /api/orders/{id}/profit                             订单利润
GET    /api/orders/pending-receipt-confirmation            审批中心列表：有 pending Receipt 的订单
```

## 收款

```
GET    /api/receipts                        列表
POST   /api/receipts                        建 Receipt（finance/boss/admin，立即动账，status=confirmed）
GET    /api/receipts/{id}                   详情
PUT    /api/receipts/{id}                   改 Receipt
DELETE /api/receipts/{id}                   删 Receipt（已 confirmed 的拒绝删）
```

## 客户

```
GET    /api/customers                                      列表（含 brand_id/keyword/settlement_mode 筛选）
POST   /api/customers                                      建客户（自动建 CBS 绑定）
GET    /api/customers/{id}                                 详情
PUT    /api/customers/{id}                                 改客户
DELETE /api/customers/{id}                                 删客户（有未完结订单拒绝删）
GET    /api/customers/{id}/orders                          客户订单
GET    /api/customers/{id}/360                             客户 360 视图（订单+应收+政策）
GET    /api/customers/{id}/brand-salesman                  客户的品牌×业务员绑定
POST   /api/customers/{id}/brand-salesman                  新增绑定
DELETE /api/customers/{id}/brand-salesman/{brand_id}       解绑
```

## 政策

```
GET    /api/policies/requests                                      政策申请列表
POST   /api/policies/requests                                      建政策申请
GET    /api/policies/requests/{id}                                 详情
PUT    /api/policies/requests/{id}                                 改
DELETE /api/policies/requests/{id}                                 删
POST   /api/policies/requests/{id}/fulfill-materials               兑付物料（出库）
POST   /api/policies/requests/{id}/fulfill-item-status             改条目兑付状态
POST   /api/policies/requests/{id}/submit-voucher                  提交兑付凭证
POST   /api/policies/requests/{id}/confirm-fulfill                 🔴 L2 财务确认归档（前置 fully_paid，Gateway `policies.confirm_fulfill`）
POST   /api/policies/requests/confirm-arrival                      🔴 L2 确认政策项到账（动 F 类账户，Gateway `policies.confirm_arrival`）
POST   /api/policies/requests/match-arrival                        Excel 到账对账匹配
GET    /api/policies/usage-records                                 使用记录列表
POST   /api/policies/usage-records                                 建使用记录
GET    /api/policies/usage-records/{id}                            详情
PUT    /api/policies/usage-records/{id}                            改
GET    /api/policies/claims                                        政策兑付 Claim 列表
POST   /api/policies/claims                                        建 Claim
GET    /api/policies/claims/{id}                                   详情
PUT    /api/policies/claims/{id}                                   改
DELETE /api/policies/claims/{id}                                   删
GET    /api/policies/request-items/{id}/expenses                   某条目的费用明细
POST   /api/policies/request-items/{id}/expenses                   加费用（payer=company → 🔴 L2 不可逆 必走 drafts；payer=employee/customer → 🟡 L1 仅登记）
PUT    /api/policies/expenses/{id}                                 🔴 L2 改（建议 drafts）
DELETE /api/policies/expenses/{id}                                 🔴 L2 删（建议 drafts）
```

## 政策模板

```
GET    /api/policy-templates/templates                     列表
POST   /api/policy-templates/templates                     建（仅 boss/finance）
GET    /api/policy-templates/templates/{id}                详情（**含 benefits[] 政策项明细：政策项名/数量/单位/单位价值/合计/兑付方式；建单卡片必须原样展示**）
PUT    /api/policy-templates/templates/{id}                改
DELETE /api/policy-templates/templates/{id}                删（有关联申请时拒绝）
GET    /api/policy-templates/templates/match               自动匹配（brand_id/cases/unit_price）—— 命中后必须接着调上面的详情拉 benefits[] 推卡片，不能只展示模板名
POST   /api/policy-templates/templates/{id}/extend         续期
GET    /api/policy-templates/adjustments                   调整记录列表
POST   /api/policy-templates/adjustments                   加调整
GET    /api/policy-templates/adjustments/{id}              详情
```

## 库存

```
GET    /api/inventory/warehouses                           仓库列表
GET    /api/inventory/batches                              批次列表
GET    /api/inventory/low-stock                            低库存
POST   /api/inventory/low-stock/notify                     推低库存通知
GET    /api/inventory/stock-flow                           出入库流水
GET    /api/inventory/value-summary                        库存总价值
GET    /api/inventory/barcode-trace/{barcode}              条码溯源
POST   /api/inventory/direct-inbound                       直接入库（调整）
POST   /api/inventory/direct-outbound                      直接出库（调整）
POST   /api/inventory/stock-out                            订单出库（**barcodes 必填，散装 / 空数组 400**；条码类型决定扣减：case→bottles_per_case，bottle→1，**不信前端 required_quantity**）
# Phase B 已删除：原 /stock-ins/{flow_id}/bind-barcodes 和 /barcodes/batch-import 两个裸接口
# 所有入库现在统一走 POST /api/purchase-orders/{po_id}/receive，三表同事务写入
GET    /api/bottle-reconciliation                          空瓶对账
POST   /api/bottle-destructions                            空瓶销毁
GET    /api/bottle-destructions                            销毁记录
```

## 采购

```
GET    /api/purchase-orders                                列表
POST   /api/purchase-orders                                建采购单（**body 必含 scope ∈ {liquor, store, mall}**：liquor→必传 brand_id + warehouse_id; store→必传 warehouse_id（门店仓）; mall→必传 mall_warehouse_id）
GET    /api/purchase-orders/{id}                           详情
POST   /api/purchase-orders/{id}/approve                   🔴 L2 审批（写应付，finance/boss，Gateway `purchase.approve`）
POST   /api/purchase-orders/{id}/reject                    驳回
POST   /api/purchase-orders/{id}/cancel                    撤销已付款的（有 FOR UPDATE + 余额校验）
POST   /api/purchase-orders/{id}/receive                   收货（warehouse；**body 必含 batch_no + barcodes_by_item: [{item_id, barcodes[]}]，barcodes 长度 = item.quantity**；后端同事务写 inventory_barcodes + barcode_registry + barcode_events 三张表，跨仓重复同码 → 409）
GET    /api/suppliers                                      供应商列表
POST   /api/suppliers                                      建
GET    /api/suppliers/{id}                                 详情
PUT    /api/suppliers/{id}                                 改
DELETE /api/suppliers/{id}                                 删
```

## 账户资金

```
GET    /api/accounts                                       账户列表（按 RLS 过滤：salesman 看不到 master）
GET    /api/accounts/summary                               账户总览（按品牌聚合）
GET    /api/accounts/fund-flows                            资金流水
POST   /api/accounts/fund-flows                            手工加流水（反向凭证等，boss/finance）
POST   /api/accounts/transfer                              🔴 L2 品牌间调拨申请（Gateway `accounts.transfer`）
GET    /api/accounts/pending-transfers                     🟢 L0 待审批调拨
POST   /api/accounts/transfers/{id}/approve                🔴 L2 批准调拨（动账，boss，Gateway `accounts.approve_transfer`）
POST   /api/accounts/transfers/{id}/reject                 🟡 L1 驳回调拨
```

## 财务

```
GET    /api/payments                                       付款流水
POST   /api/payments                                       建付款
GET    /api/payments/{id}                                  详情
PUT    /api/payments/{id}                                  改
DELETE /api/payments/{id}                                  删（仅 admin）
GET    /api/expenses                                       🟢 L0 日常费用列表（公司直付的差旅/水电/物料；非员工垫付报销，那个走 /api/expense-claims）
POST   /api/expenses                                       🟡 L1 建费用（boss/finance 录入）— body 必含 brand_id（决定从哪个品牌现金账户扣款）+ description + amount；前端 ExpenseList「日常费用」Tab Modal 第 1 项就是品牌下拉
GET    /api/expenses/{id}                                  🟢 L0 详情
PUT    /api/expenses/{id}                                  🟡 L1 改（仅 pending 可改）
DELETE /api/expenses/{id}                                  🟡 L1 删（已 paid 拒绝）
POST   /api/expenses/{id}/approve                          🟡 L1 审批（推荐审批中心人工点）
POST   /api/expenses/{id}/reject                           🟡 L1 驳回
POST   /api/expenses/{id}/pay                              🔴 L2 不可逆 付款（drafts 强制，draft action `finance.expenses.pay`）
GET    /api/payment-requests                               🟢 L0 付款申请列表（前端「**对外付款（代收待付）**」Tab 数据源）
   Query: settled_status=arrived 过滤"厂家已到账未兑付"（advance_refund + status ∈ pending/approved）
   Response 多返：amount_sum = 代收待付总额（即顶部摘要卡片显示的红色数字）
POST   /api/payment-requests                               🟡 L1 建付款申请
GET    /api/payment-requests/{id}                          🟢 L0 详情
PUT    /api/payment-requests/{id}                          🟡 L1 审批 / 取消
POST   /api/payment-requests/{id}/confirm-payment          🔴 L2 确认线下已付并记账（动品牌现金；走 drafts；这一步把"代收待付"账款变成"已付"）
GET    /api/receivables                                    🟢 L0 应收账款（前端「**应收账款**」Tab 数据源 —— 聚合两类）
   返回 items[] 每条带 source ∈ sale / company_advance + source_label
   Response 多返：sale_amount = 销售应收合计；company_advance_amount = 公司垫付未到账合计
GET    /api/receivables/aging                              🟢 L0 应收账龄（按到期日 / 建单账龄分档；目前只覆盖 sale，公司垫付不分档）
GET    /api/finance/manufacturer-settlements               🟢 L0 厂家结算列表（前端「**厂家结算**」Tab 数据源 —— 厂家给经销商的 F 类资金到账记录）
```

## 稽查

```
GET    /api/inspection-cases                               案件列表（支持 brand_id / direction / case_type / barcode / status）
POST   /api/inspection-cases                               建案件（A1/A2/A3/B1/B2）
GET    /api/inspection-cases/{id}                          详情
PUT    /api/inspection-cases/{id}                          改
DELETE /api/inspection-cases/{id}                          删（已执行的拒绝删）
POST   /api/inspection-cases/{id}/execute                  🔴 L2 执行（动账+库存，Gateway `inspections.execute_case`）
POST   /api/inspection-cases/{id}/recover-to-stock         回仓（A1/A2 恶意/非恶意）
```

## 清理案件

```
GET    /api/cleanup-cases
POST   /api/cleanup-cases
GET    /api/cleanup-cases/{id}
PUT    /api/cleanup-cases/{id}
DELETE /api/cleanup-cases/{id}
POST   /api/cleanup-cases/{id}/stock-in                    入库
```

## 工资

```
GET    /api/payroll/positions                              岗位列表
GET    /api/payroll/salary-schemes                         薪酬方案
POST   /api/payroll/salary-schemes                         建方案
PUT    /api/payroll/salary-schemes/{id}                    改
DELETE /api/payroll/salary-schemes/{id}                    删
GET    /api/payroll/employees/{id}/brand-positions         🟢 L0 员工的品牌×岗位绑定（前端「权限管理」页 BrandPopover 数据源）
POST   /api/payroll/employees/{id}/brand-positions         🔴 L2 建绑定 — 挂 risk_l2 + require_user_confirm
PUT    /api/payroll/brand-positions/{id}                   🔴 L2 改 — 挂 risk_l2 + require_user_confirm
DELETE /api/payroll/brand-positions/{id}                   🔴 L2 删 — 挂 risk_l2 + require_user_confirm
GET    /api/payroll/salary-records                         工资单列表
POST   /api/payroll/salary-records/generate                批量生成本月工资（按员工）
POST   /api/payroll/salary-records                         手工建单条
GET    /api/payroll/salary-records/{id}/detail             详情
GET    /api/payroll/salary-records/{id}/order-links        工资单关联订单
PUT    /api/payroll/salary-records/{id}                    改
DELETE /api/payroll/salary-records/{id}                    删
POST   /api/payroll/salary-records/{id}/submit             提交审批
POST   /api/payroll/salary-records/{id}/approve            🟡 L1 批准
POST   /api/payroll/salary-records/{id}/pay                🔴 L2 不可逆 发放（drafts 强制，Gateway `payroll.pay_salary`）
POST   /api/payroll/salary-records/batch-submit            批量提交
POST   /api/payroll/salary-records/batch-confirm           批量确认
POST   /api/payroll/salary-records/batch-pay               🔴 L2 不可逆 批量发放（≤ 20/批，drafts 强制，Gateway `payroll.batch_pay`）
GET    /api/payroll/manufacturer-subsidies                 厂家补贴列表
POST   /api/payroll/manufacturer-subsidies/generate-expected       生成本月应收
POST   /api/payroll/manufacturer-subsidies/confirm-arrival         🔴 L2 确认到账（Gateway `payroll.confirm_subsidy_arrival`）
POST   /api/payroll/manufacturer-subsidies/manual-mark-arrived     手动标记到账
GET    /api/payroll/assessment-items                       KPI 考核项
POST   /api/payroll/assessment-items                       建
PUT    /api/payroll/assessment-items/{id}                  改
DELETE /api/payroll/assessment-items/{id}                  删
```

## 人事

```
GET    /api/hr/employees                                   员工列表
POST   /api/hr/employees                                   建员工
GET    /api/hr/employees/{id}                              详情
PUT    /api/hr/employees/{id}                              改
DELETE /api/hr/employees/{id}                              删
GET    /api/hr/employees/{id}/store-assignments            🟢 L0 员工门店绑定列表（前端「权限管理」页 StorePopover 数据源；m6cx 多对多权威源）
PUT    /api/hr/employees/{id}/store-assignments            🔴 L2 整体替换门店绑定 — body { warehouse_ids: [...], primary_warehouse_id? } — 挂 risk_l2 + require_user_confirm
GET    /api/hr/kpis                                        KPI 列表
POST   /api/hr/kpis                                        建 KPI
GET    /api/hr/kpis/{id}                                   详情
PUT    /api/hr/kpis/{id}                                   改
DELETE /api/hr/kpis/{id}                                   删
GET    /api/hr/commissions                                 提成列表
POST   /api/hr/commissions                                 建提成
GET    /api/hr/commissions/{id}                            详情
PUT    /api/hr/commissions/{id}                            改
DELETE /api/hr/commissions/{id}                            删
POST   /api/hr/commissions/{id}/settle                     结算（挂到工资单）
```

## 考勤

```
GET    /api/attendance/rules                               打卡规则
POST   /api/attendance/rules                               建/改规则
GET    /api/attendance/checkin                             打卡记录
POST   /api/attendance/checkin                             打卡（上班/下班）
GET    /api/attendance/visits                              客户拜访
POST   /api/attendance/visits/enter                        进店
POST   /api/attendance/visits/leave                        出店
GET    /api/attendance/leave-requests                      请假申请
POST   /api/attendance/leave-requests                      建请假
POST   /api/attendance/leave-requests/{id}/approve         审批请假
GET    /api/attendance/monthly-summary                     月度考勤汇总
```

## 销售目标

```
GET    /api/sales-targets                                  目标列表
POST   /api/sales-targets                                  建目标（三级：company/brand/employee）
PUT    /api/sales-targets/{id}                             改
DELETE /api/sales-targets/{id}                             删
POST   /api/sales-targets/{id}/approve                     审批目标
GET    /api/sales-targets/my-dashboard                     我的目标仪表
```

## 绩效

```
GET    /api/performance/me                                 我的绩效
GET    /api/performance/employee-monthly                   员工月度绩效
GET    /api/performance/employee-trend                     趋势
POST   /api/performance/init-assessment-items              初始化考核项
POST   /api/performance/refresh-assessment-actual          刷实际值
```

## 融资

```
GET    /api/financing-orders                               融资单列表
POST   /api/financing-orders                               建融资
GET    /api/financing-orders/{id}                          详情
GET    /api/financing-orders/{id}/calc-interest            算利息
GET    /api/financing-orders/{id}/repayments               还款记录
POST   /api/financing-orders/{id}/submit-repayment         提交还款
POST   /api/financing-orders/{id}/submit-return            提交退仓（退货还款）
GET    /api/financing-orders/pending-repayments            待审批还款
POST   /api/financing-orders/repayments/{id}/approve       🔴 L2 批准还款（动品牌 cash + financing）
POST   /api/financing-orders/repayments/{id}/reject        驳回还款
```

## 政策兑付核销

```
GET    /api/manufacturer-settlements                       厂家结算列表
POST   /api/manufacturer-settlements                       建结算
POST   /api/manufacturer-settlements/import-excel          Excel 导入
GET    /api/manufacturer-settlements/{id}                  详情
PUT    /api/manufacturer-settlements/{id}                  改
POST   /api/manufacturer-settlements/{id}/allocation-preview  分配预览
POST   /api/manufacturer-settlements/{id}/allocation-confirm  确认分配
```

## 报销申请

**前端入口**（2026-05-21 拆分）：
- ERP 顶部一级菜单「**报销申请**」(`/finance/expenses`) — 任何登录员工可见，普通员工只看到「报销单」Tab；admin/boss/finance 看到「报销单 + 日常费用」两个 Tab
- 小程序 `/pages/salesman-expense/salesman-expense` — salesman 移动端入口
- ERP「审批中心 → 综合审批 → 报销待审」Tab — boss/finance/hr 集中审批入口

```
GET    /api/expense-claims                                 🟢 L0 报销列表（自查 + 财务全量）
POST   /api/expense-claims                                 🟢 L0 建报销（普通员工可调；2026-05-21 起接受 boss/finance/salesman/sales_manager/hr/warehouse/purchase/store_manager）
GET    /api/expense-claims/{id}                            🟢 L0 详情
PUT    /api/expense-claims/{id}                            🟡 L1 改（仅 pending 可改）
DELETE /api/expense-claims/{id}                            🟡 L1 删
POST   /api/expense-claims/{id}/approve                    🟡 L1 批准（Agent 不替老板审批；审批中心人工点）
POST   /api/expense-claims/{id}/reject                     🟡 L1 驳回（同上）
POST   /api/expense-claims/{id}/apply                      🔴 L2 申请（提交厂家，f_class，挂 risk_l2 + require_user_confirm）
POST   /api/expense-claims/{id}/confirm-arrival            🔴 L2 确认到账（动账，挂 risk_l2 + require_user_confirm）
POST   /api/expense-claims/{id}/fulfill                    🔴 L2 兑付（挂 risk_l2 + require_user_confirm）
POST   /api/expense-claims/{id}/pay                        🔴 L2 不可逆 付款（挂 risk_l2 + require_user_confirm；drafts 强制，draft action `expense_claims.pay`）
POST   /api/expense-claims/{id}/settle                     🟡 L1 结算归档（仅状态推进）
```


## 通知

```
GET    /api/notifications                                  通知列表
GET    /api/notifications/unread-count                     未读数
POST   /api/notifications/{id}/mark-read                   标已读
POST   /api/notifications/mark-all-read                    全部已读
```

## 仪表盘

```
GET    /api/dashboard/summary                              总览（订单数/应收/库存价值）
GET    /api/dashboard/trend                                趋势
GET    /api/dashboard/profit-summary                       利润台账（11 科目）
GET    /api/dashboard/profit-detail                        某科目明细
```

## 品鉴

```
GET    /api/tasting-wine-usage                             品鉴酒用量
POST   /api/tasting-wine-usage                             记录用量
GET    /api/tasting-wine-usage/{id}                        详情
PUT    /api/tasting-wine-usage/{id}                        改
DELETE /api/tasting-wine-usage/{id}                        删
```

## 产品品牌

```
GET    /api/products                                       商品列表
POST   /api/products                                       建商品
GET    /api/products/{id}                                  详情
PUT    /api/products/{id}                                  改
DELETE /api/products/{id}                                  删
GET    /api/products/brands                                品牌列表
POST   /api/products/brands                                建品牌
PUT    /api/products/brands/{id}                           改
DELETE /api/products/brands/{id}                           删
```

## 上传下载

```
POST   /api/uploads                                        上传文件（multipart/form-data，10MB 以内图片）
GET    /api/uploads/files/{path:path}                      下载文件（不鉴权，靠 UUID 不可枚举）
```

## 审计日志

```
GET    /api/audit-logs                                     审计日志列表（admin）
GET    /api/audit-logs/actions                             所有 action 类型
GET    /api/audit-logs/entity-types                        所有 entity 类型
```

## 门店零售（桥 B12）

```
POST   /api/store-sales                                    管理端代下收银单（boss/warehouse）
GET    /api/store-sales                                    销售流水列表（boss/finance/warehouse/hr）
GET    /api/store-sales/stats                              统计聚合（支持 group_by=store 每店一行 + 合计）
GET    /api/store-sales/export                             CSV 导出（带 UTF-8 BOM，支持 Excel 中文）
GET    /api/store-sales/{sale_id}                          销售单详情（含 items）

# 提成率
GET    /api/retail-commission-rates                        提成率列表（按员工/商品）
POST   /api/retail-commission-rates                        新建提成率（唯一约束 employee+product）
PUT    /api/retail-commission-rates/{rate_id}              更新提成率
DELETE /api/retail-commission-rates/{rate_id}              删除

# 门店退货
POST   /api/store-returns                                  admin 列表/详情/审批
POST   /api/store-returns/pending-approval                 审批中心聚合
```

## 小程序 C 端

```
POST   /api/mall/auth/login-password                       账密登录
POST   /api/mall/auth/register                             注册（必传 invite_code）
POST   /api/mall/auth/wechat-login                         微信登录
POST   /api/mall/auth/refresh                              刷新 token
GET    /api/mall/products                                  商品列表（sort=hot|lasted|discount，hot 按 net_sales）
GET    /api/mall/products/{id}                             商品详情（返回 soldNum + netSoldNum 双字段）
GET    /api/mall/search/products                           商品搜索（按 net_sales 排序）
POST   /api/mall/orders                                    C 端下单
GET    /api/mall/orders                                    我的订单列表
```

## 小程序业务员（mall/salesman/*）

```
# 工作台基础
GET    /api/mall/salesman/orders/pool                      抢单池（独占期 / 开放期两阶段）
POST   /api/mall/salesman/orders/{id}/claim                抢单（FOR UPDATE + 推荐人优先校验）
POST   /api/mall/salesman/orders/{id}/release              释放订单（触发 skip_log）
POST   /api/mall/salesman/orders/{id}/ship                 出库（mall 仓必扫条码）
POST   /api/mall/salesman/orders/{id}/deliver              送达（需上传 delivery_photos）
POST   /api/mall/salesman/orders/{id}/upload-payment-voucher  上传凭证（sha256 防篡改）

# 我的客户（G16 隐私加固）
GET    /api/mall/salesman/my-customers                     列表（手机号脱敏返回）
GET    /api/mall/salesman/my-customers/{id}/phone          揭示完整手机号（写 reveal_phone 审计）

POST   /api/mall/salesman/invite-codes                     生成邀请码（8 位，2h 过期，20/日上限）
GET    /api/mall/salesman/skip-alerts?self=1               我的跳单告警
GET    /api/mall/salesman/stats                            我的本月业绩
```

## 小程序工作台复用（mall/workspace/*）

```
# ERP 业务模块薄转发
POST   /api/mall/workspace/attendance/checkin              打卡
GET    /api/mall/workspace/attendance/monthly-summary      本月考勤汇总
GET/POST /api/mall/workspace/leave-requests                请假
GET/POST /api/mall/workspace/expense-claims                报销
GET/POST /api/mall/workspace/inspection-cases              稽查
GET    /api/mall/workspace/sales-targets/my-dashboard      KPI 看板
GET    /api/mall/workspace/notifications                   通知中心

# 门店店员端（cashier）
GET    /api/mall/workspace/store-sales/verify-barcode      扫码预校验
POST   /api/mall/workspace/store-sales                     提交收银（支持散客 customer_id=null）
GET    /api/mall/workspace/store-sales/my/sales            我的销售流水
GET    /api/mall/workspace/store-sales/my/summary          本月业绩汇总
GET    /api/mall/workspace/store-sales/customers/search    客户搜索（min_length=5，脱敏，本店优先）

# 门店退货（cashier 发起）
POST   /api/mall/workspace/store-returns                   店员申请退货
GET    /api/mall/workspace/store-returns                   我发起的退货列表

# G6：业务员自查 commission 流水
GET    /api/mall/workspace/my-commissions                  流水列表（status=all|pending|settled|reversed|adjustment）
GET    /api/mall/workspace/my-commissions/stats            按 status 汇总（本月/指定年月）
```

## 小程序管理后台（mall/admin/*）

```
# 用户 + 业务员
GET    /api/mall/admin/users                               C 端用户列表（支持 status 过滤）
POST   /api/mall/admin/users/{id}/reactivate               启用归档用户（必传 reason）
POST   /api/mall/admin/users/{id}/disable                  禁用用户
PUT    /api/mall/admin/users/{id}/referrer                 换绑推荐人（admin/boss，记审计）

POST   /api/mall/admin/salesmen                            手工创建业务员
POST   /api/mall/admin/salesmen/import                     批量导入业务员
PUT    /api/mall/admin/salesmen/{id}                       更新业务员（切 store 会检查在途，需 force_switch=true 强切）
POST   /api/mall/admin/salesmen/{id}/disable               禁用业务员（自动释放 assigned 订单 + 通知客户）
PUT    /api/mall/admin/salesmen/{id}/rebind-employee       换绑 ERP 员工

# 订单
POST   /api/mall/admin/orders/{id}/reassign                管理员改派
POST   /api/mall/admin/orders/{id}/confirm-payment         🔴 L2 财务确认收款（触发利润+提成）
POST   /api/mall/admin/orders/{id}/cancel                  取消订单

# 凭证
GET    /api/mall/admin/payments/pending                    待确认凭证列表（财务审批中心）
POST   /api/mall/admin/payments/{id}/reject                驳回凭证（必传 reason）

# 退货
GET    /api/mall/admin/returns                             退货申请列表
POST   /api/mall/admin/returns/{id}/approve                🔴 L2 批准（FOR UPDATE 锁，自动建 adjustment commission）
POST   /api/mall/admin/returns/{id}/reject                 驳回
POST   /api/mall/admin/returns/{id}/mark-refunded          标记已退款（资金结算）

# 跳单告警
GET    /api/mall/admin/skip-alerts                         全局跳单告警
POST   /api/mall/admin/skip-alerts/{id}/resolve            处理告警

# 看板 + 排行（决策 #2）
GET    /api/mall/admin/dashboard/summary                   看板汇总（返 today/month 利润 + 毛利率 + 坏账）
GET    /api/mall/admin/dashboard/salesman-ranking          业务员排行（mode=snapshot|realtime + year_month）
POST   /api/mall/admin/dashboard/salesman-ranking/build-snapshot        手工冻结某月（admin/boss）
POST   /api/mall/admin/dashboard/salesman-ranking/build-snapshot-range  批量回补历史月份

# 定时任务
POST   /api/mall/admin/housekeeping/archive-inactive       手动触发归档
GET    /api/mall/admin/housekeeping/logs                   任务日志

# 登录审计
GET    /api/mall/admin/login-logs                          全局登录日志
GET    /api/mall/admin/users/{id}/login-logs               某用户登录历史
GET    /api/mall/admin/login-logs/stats                    频率统计
```

## 工资单追回详情（决策 #1）

```
GET    /api/payroll/salary-records/{id}/detail             工资明细含 clawback_details / clawback_settled_history / clawback_new_pending
```

返回字段：
- `clawback_details[]`：本期扫入的 is_adjustment 负数 Commission（含 origin_order_no / origin_amount / origin_ref_type）
- `clawback_settled_history[]`：本月结清的历史挂账
- `clawback_new_pending[]`：本月工资不足挂到下月
