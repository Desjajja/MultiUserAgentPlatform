# MCP 薄壳化 + 前端对齐施工记录（2026-04-29）

**这份文档**：记录 Phase 1-3 做了什么 / 修了什么 bug / 对 Agent 和 openclaw 集成的影响。后续 Phase 4+ 会在这里追加。

---

## 为什么要做这件事

**历史状态**（Phase 0 前）：MCP tool 大量**复刻** HTTP 层业务逻辑（customer_paid_amount 三模式 / 政策匹配 / 动账），已知多处不一致：

- `preview-order` settlement_mode 非法值 **silent fallback**（拿 total_amount 当 customer_paid）
- `create-order` 政策匹配规则和 HTTP 不完全一致（HTTP 不支持通用模板，MCP 也不支持但两边不同步）
- `approve-order` 自己造 PolicyRequest 并标 approved，绕开前端 PolicyApproval 的合并动作
- `confirm-order-payment` 复刻整段 confirm_payment 逻辑（~60 行），跟 HTTP 双实现
- MCP 没有 `upload-payment-voucher`（业务员路径），agent 只能建财务路径
- MCP 没有 `fulfill-materials` / `submit-voucher` / `confirm-fulfill` / `confirm-arrival`（政策兑付链路）
- **前端建单是三步串行**（Order + PolicyRequest + submit-policy），前端 OrderList.tsx 手动串，失败不回滚
- **前端政策审批是两步串行**（PolicyRequest.status + Order.approve-policy），前端 PolicyApproval.tsx 手动串

**Agent 后果**：员工通过 openclaw 让 Agent 建单，MCP 只做 Step 1 建个 Order，没建 PolicyRequest，没推到审批 —— 订单永远卡在 `pending`，boss 看不到。

---

## Phase 1：HTTP 层合并接口 + 权限修补

### 新增 4 个合并接口

| 接口 | 合并前端哪一块 |
|---|---|
| `POST /api/orders/preview` | 前端表单实时计算（以前前端自己重算） |
| `POST /api/orders/create-with-policy` | **OrderList.tsx:148-228**（三步串行合为一事务） |
| `POST /api/orders/{id}/approve-policy-with-request` | **PolicyApproval.tsx:72-91**（两步合为一事务） |
| `POST /api/orders/{id}/reject-policy-with-request` | **PolicyApproval.tsx:93-111**（两步合为一事务） |

### 抽 6 个公共函数（HTTP + MCP 共用）

`backend/app/api/routes/orders.py`：
- `_enforce_salesman_binding(body_salesman_id, user) -> str` — salesman 身份硬绑定
- `_resolve_brand_and_products(db, items) -> (brand_id, resolved)` — 商品同品牌校验（用 select 走 RLS）
- `_validate_customer_belongs_to_salesman(db, customer_id, salesman_id, brand_id)` — CBS 归属校验
- `_match_or_load_policy_template(db, brand_id, total_cases, policy_template_id?)` — 政策匹配
- `_compute_order_amounts(tmpl, resolved, settlement_mode, deal_unit_price?) -> dict` — **金额计算业务真相源**
- `_build_order_from_computed(db, body, user, tmpl, resolved, brand_id, amounts) -> Order`

### Phase 1.5 权限补丁（全修 5 个缺陷）

1. ❌ 原 `POST /api/orders` 无 salesman 硬绑定 → salesman 可给别人名下建单
   ✅ 改为：`body.salesman_id = _enforce_salesman_binding(...)` 覆盖成本人 employee_id
2. ❌ 原 `db.get(Product, id)` 主键直查**可能跳过** RLS session 变量
   ✅ 改为 `select(Product).where(id=...)`，强制走 RLS
3. ❌ salesman 可传任意 `customer_id` 建单（不校验归属）
   ✅ 新增 `_validate_customer_belongs_to_salesman` CBS 三元组校验；非绑定返 400 "客户不存在或未绑定到你名下"（语义合并，不暴露"客户存在但无权"）
4. ❌ approve/reject-policy-with-request 无品牌白名单兜底
   ✅ 加 `if order.brand_id not in user.brand_ids: raise 404`（non-admin）
5. ❌ preview 角色不含 finance
   ✅ 加 finance（审批时需要看金额）

---

## Phase 2：MCP 写入 tool 薄壳化（14 个）

规则：MCP tool 只做 (a) `name/code → UUID` 解析 (b) 调 HTTP 真身 handler 函数 (c) 包装 AI 友好返回。

| MCP Tool | 薄壳调 HTTP | 改动要点 |
|---|---|---|
| `preview-order` | `preview_order` | 新增 + 复刻代码全删 |
| `create-order` | `create_order_with_policy` | 三步合一 |
| `register-payment` | `create_receipt` | ~70 行复刻删 |
| `upload-payment-voucher` | `upload_payment_voucher` | **新增**（业务员路径） |
| `confirm-order-payment` | `confirm_payment` | ~60 行复刻删 |
| `reject-payment-receipts` | `reject_payment_receipts` | **新增** |
| `approve-order`（合并） | `approve-policy-with-request` / `reject-policy-with-request` | 同步更新 PR.status + Order.status |
| `reject-order-policy` | `reject_policy_with_request` | 单独驳回 |
| `approve-fund-transfer` | `approve_fund_transfer` | 已薄壳，不动 |
| `approve-financing-repayment` | `approve_repayment` / `reject_repayment` | reject 分支薄壳 |
| `approve-inspection`（拆两步） | `update_inspection_case` + `execute_inspection_case` | 原合并两步错；改为 action=approve/execute 分步 |
| `approve-purchase-order` | `approve_purchase_order` / `reject_purchase_order` | 复刻删 |
| `approve-expense-claim` | `approve_claim` / `reject_claim` / `pay_daily_claim` | pay 分支复刻 40 行删 |
| `complete-order` | `complete_order` | 复刻删 |

---

## Phase 3：MCP 补缺失 tool（7 个新增 + 2 个重写）

### 新增（政策兑付 + 采购 + 稽查 + 调拨）

| Tool | HTTP |
|---|---|
| `fulfill-materials` | `POST /policies/requests/{id}/fulfill-materials` |
| `fulfill-item-status` | `POST /policies/requests/{id}/fulfill-item-status` |
| `submit-policy-voucher` | `POST /policies/requests/{id}/submit-voucher` |
| `confirm-fulfill` | `POST /policies/requests/{id}/confirm-fulfill` |
| `cancel-purchase-order` | `POST /purchase-orders/{id}/cancel` |
| `close-inspection-case` | `PUT /inspection-cases/{id}` status=closed |
| `create-fund-transfer-request` | `POST /accounts/transfer` |

### 重写 / 薄壳化

| Tool | 原实现问题 | 现状 |
|---|---|---|
| `confirm-policy-arrival` | 只改 PolicyRequest.status（应该是 item.fulfill_status=arrived + F 类账户加钱） | 重写薄壳 `POST /policies/requests/confirm-arrival` |
| `receive-purchase-order` | 复刻 80 行（StockFlow + Inventory + bpc 换算） | 薄壳调 `POST /purchase-orders/{id}/receive`，加 batch_no 参数 |

### 删除（catalog 移除）

| Tool | 为什么删 |
|---|---|
| `fulfill-policy-materials` | 语义错：只改 `fulfilled_qty` 字段，不扣库存，不换单位 |
| 旧版 `confirm-policy-arrival` | 语义错：只改 PR.status，不动 item / F 类 |
| 旧版 `confirm-policy-fulfill` | 语义错：批量把 PR 标 approved + 所有 item 标 fulfilled，跳过凭证提交步骤 |

→ 这些 tool 从 catalog 里删了，但 FastAPI 路由还存在（兼容旧 Agent）。新版 Agent 应调正确的薄壳版。

### 新增 helper

`backend/app/mcp/_resolvers.py`（集中 name/code → UUID）：
- `resolve_customer_id`
- `resolve_product_id`
- `resolve_salesman_id`（按 employee_no / name）
- `resolve_policy_template_id`
- `resolve_warehouse_id`
- `resolve_brand_id`
- `resolve_supplier_id`
- `resolve_account_id`
- `resolve_order_by_no`

---

## Review 发现的 5 个 bug（均已修）

| # | Bug | 修复 |
|---|---|---|
| 1 | `MCPCreateOrderRequest.salesman_id` 标必传 → salesman 自建单必须自己填 | 改 Optional；不传就让 HTTP 硬绑定 |
| 2 | `create_order_with_policy` 通知前 lazy-load customer 崩（async session 不支持） | 先 re-fetch 带 eager load 再 notify |
| 3 | `cancel-purchase-order` MCP 权限用 `boss/finance`，HTTP 实际 `boss/purchase` | 对齐到 `boss/purchase` |
| 4 | `fulfill-item-status` MCP 权限多了 salesman | 改为 `boss/finance` |
| 5 | `receive-purchase-order` 漏传 HTTP 必需的 `batch_no` Query 参数 | MCP 接口加可选 batch_no，不传就用 `PO-YYYYMMDD` 自动生成 |

---

## Smoke Test 结果

### HTTP preview vs MCP preview-order（三模式）

所有字段**逐字段相等**：

| 模式 | total_amount | deal_amount | policy_gap | customer_paid_amount | policy_receivable |
|---|---|---|---|---|---|
| customer_pay | 27000 | 25500 | 1500 | **27000** | **0** |
| employee_pay | 27000 | 25500 | 1500 | **27000** | **1500** |
| company_pay | 27000 | 25500 | 1500 | **25500** | **1500** |

### MCP create-order 端到端

- ✅ 中文名"张三烟酒店"/"青花郎53度500ml" 自动解析
- ✅ 事务化：Order + PolicyRequest + submit-policy 一次完成
- ✅ `status=policy_pending_internal`，PolicyRequest.status=pending_internal
- ✅ employee_pay 缺 advance_payer_id → 400
- ✅ salesman 传 admin_id 尝试挂别人名下 → 被硬绑定覆盖

### MCP approve-order

- ✅ 一次调用同时更新 Order.status=approved + PolicyRequest.status=approved
- ✅ 未批准的订单 PolicyRequest 不受影响

### 权限边界

- ✅ salesman 建未绑定品牌客户单 → 400 "客户不存在或未绑定到你名下"
- ✅ salesman 看不到 master 账户（RLS）
- ✅ salesman 查订单只看到自己的（apply_data_scope）

### Phase 3 tool 冒烟

- ✅ `close-inspection-case` / `receive-purchase-order` / `fulfill-materials` / `submit-policy-voucher` / `confirm-fulfill` / `fulfill-item-status` 错误输入全部返对应的 404 / 400
- ✅ `confirm-policy-arrival` 空 items 幂等 updated=0
- ✅ `create-fund-transfer-request` 中文名"公司总资金池" 自动解析，余额不足返 400

---

## 对 Agent 的影响

### 好消息

- **金额永远和前端一致**：Agent 展示给员工的金额 = 前端页面上的金额 = DB 里的实际值。再不会出现"Agent 说应收 ¥27000，前端显示 ¥25500"的尴尬
- **写入类事务化**：create-order 一次调用完成三步，失败整体回滚。Agent 不需要手动 compensation
- **CBS 归属自动校验**：Agent 不用自己判断"这个客户属不属于这个 salesman"，HTTP 层兜底
- **politicy 链路全 tool 可用**：Agent 能代业务员走完 fulfill-materials → submit-voucher → confirm-fulfill → confirm-arrival 完整链路

### 坏消息 / 注意

- 旧 Agent 代码用 `fulfill-policy-materials` 的会**继续调通**（路由还在），但行为错（不扣库存）。**新 Agent 必须改用 `fulfill-materials`**
- `confirm-policy-arrival` 参数 schema **变了**：老的要 `request_id`，新的要 `items: [{item_id, arrived_amount, billcode}]`
- MCP 有新 tool `upload-payment-voucher` 专门给业务员上传凭证。**Agent 要按角色选**：业务员 → upload-payment-voucher；财务 → register-payment

---

## Phase 4 待办（未完成）

- ❌ openclaw 集成：在 openclaw 端配 `mcp_servers.json` 指向 ERP /mcp/stream
- ❌ 真实跑一遍飞书 bot 上线 flow：员工 open_id → exchange → call tool → 返回卡片
- ❌ bridge.py 清理`⚠️ 业务不对齐` 警告（历史残留）
- ❌ skill SKILL.md frontmatter 加 openclaw 兼容字段（emoji / mcp.server）
- ❌ 旧 `agent-playbook.md` 的 30 个场景全部改 MCP 视角（目前只新建了 `mcp-agent-playbook.md` 精简版）
- ❌ 补充 pytest smoke test 固化（目前手动跑）

---

## Agent 使用建议

1. **优先看**：`mcp-tools-catalog.md`（工具清单）+ `mcp-agent-playbook.md`（剧本）
2. **涉及金额/状态**：看 `field-semantics.md` + `state-machines.md`
3. **权限问题**：看 `business-rules.md` §零（身份隔离）+ §一（权限矩阵）
4. **踩过的坑**：看 `pitfalls.md`（38 个历史 bug，绝不能重复）
5. **旧 HTTP 视角**：看 `agent-playbook.md`（legacy，兼容用）

---

## 相关 commit

- `366b4aa` feat(mcp): 薄壳化对齐前端业务 Phase 1-3
- `d2d4f45` docs(skill): 沉淀企业 Agent 业务手册 + 身份隔离 + 小程序现状
- `cf7c192` fix: review 发现 MCP/聚合/里程碑 共 9 个业务 bug
