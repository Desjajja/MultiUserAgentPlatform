# Mall 业务原子化与开发状态

本文件按**业务流**切分 mall（小程序端）的原子动作。一个原子 = 一个 service 函数 + 一个路由端点 + 前端操作。

**图例**：
- 🟢 **done**：后端+前端+端到端链路通过、且有手工/脚本 E2E 验证
- 🟡 **coded**：后端+前端都写了，但 **没在真实业务数据上端到端走过**
- 🔴 **gap**：要么后端缺、要么前端缺、要么两端都有 bug
- ⚪ **n/a**：设计上不做

**E2E 标**（每个流末尾汇总）：
- ✅ **tested**：有脚本或手工验证过
- ⏳ **partial**：部分路径验证过
- ❌ **untested**：从未在真实业务流程跑过

---

## 流 1：C 端注册审批闭环

业务目标：业务员拉新 → 客户扫码/输码 → 填资料 → 管理员审批 → 获得下单资格

### 状态机

```
(anonymous)
  ├─ 扫码/输邀请码  ─→  register-form
  │                        ↓
  │                     [上传营业执照 + 填姓名/电话/地址]
  │                        ↓
  │                     application_status=pending
  │                        ↓
  │                     [admin 审批] ──→ approved ──→ 可登录
  │                        └──────→ rejected ──→ 邀请码作废+通知
  │
  └─ 已注册微信 ──→ wechat-login ──→ 通过 approved 校验 → token
```

### 原子动作表

| # | 动作 | 角色 | 端点/位置 | 前置 | 副作用 | 通知 | 状态 |
|---|---|---|---|---|---|---|---|
| 1.1 | 业务员**生成邀请码** | salesman | `POST /api/mall/salesman/invite-codes` | is_accepting_orders=True · 每日 ≤20 | 建 MallInviteCode（2h 过期，一次性）| — | 🟢 |
| 1.2 | 业务员**作废邀请码** | salesman | `POST /api/mall/salesman/invite-codes/{id}/invalidate` | code.未使用 且 未过期 | invalidated_at=now | — | 🟡 |
| 1.3 | 业务员看**邀请码历史** | salesman | `GET /api/mall/salesman/invite-codes/history` | — | 返最近 50 条含 used_by 昵称 | — | 🟢 |
| 1.4 | 业务员生成**小程序码 PNG**（含 scene=code） | salesman | `GET /api/mall/salesman/invite-codes/{id}/qr-mp` | MP_APPID 配置 · scene 合法 | 拿 wx access_token → 调 wxacode.getUnlimited | — | 🟡（未配 MP_APPID 时返 mock PNG） |
| 1.5 | 匿名**查省市区** | anon | `GET /api/mall/regions?parent_code=` | — | — | — | 🟢（但只 seed 了河南 + 北京 4 条）|
| 1.6 | 匿名**上传营业执照** | anon | `POST /api/mall/public-uploads/upload?kind=business_license` | 单 IP ≤5/min · MIME 白名单 | 落 uploads/ + 返 {url, sha256} | — | 🟢 |
| 1.7 | 匿名**微信注册**（消费 code+资料）| anon | `POST /api/mall/auth/wechat-register` | code 未用/未过期 · openid 不存在 · 4 字段齐 | FOR UPDATE 消费 code + 建 MallUser(pending) + 建 MallAddress(默认) | notify_roles(admin,boss,hr) 新申请待审 | 🟢 |
| 1.8 | 消费者**轮询审批状态** | anon（凭 application_id）| `GET /api/mall/auth/application-status?application_id=` | — | — | — | 🟢 |
| 1.9 | admin **列出待审** | admin/boss/hr | `GET /api/mall/admin/user-applications?status=pending` | — | — | — | 🟢 |
| 1.10 | admin **看审批详情**（含营业执照大图）| admin/boss/hr | `GET /api/mall/admin/user-applications/{id}` | — | — | — | 🟢 |
| 1.11 | admin **通过审批** | admin/boss/hr | `POST /api/mall/admin/user-applications/{id}/approve` | application_status=pending | application_status=approved · approved_at · approved_by_employee_id | notify_mall_user(user) | 🟢 |
| 1.12 | admin **驳回审批** | admin/boss/hr | `POST /api/mall/admin/user-applications/{id}/reject` | application_status=pending · reason 必填 | application_status=rejected · bump token_version · openid/username 加 `rejected_<ts>_` 前缀释放唯一键 · 对应邀请码 invalidated_at=now | notify_mall_user(user)  | 🟢 |
| 1.13 | 消费者**微信登录** | anon | `POST /api/mall/auth/wechat-login` | openid 已注册 · approved · status=active · salesman 的 linked_employee 也 active | record_login_log | — | 🟢 |
| 1.14 | 登录失败**审计**（openid 未注册/被拒/员工离职）| system | auth.py wechat_login 异常分支 | — | audit_logs 一条 | — | 🟢 |

### E2E 测试状态：⏳ partial
- ✅ 1.7 + 1.11 已人工走通（徐泽军账号）
- ✅ 1.12 已通过 `e2e_verify_4bugs.py` D 场景
- ❌ 1.2（业务员作废未用码）、1.4（小程序码真机扫码）未在真实场景跑
- ❌ 驳回后的"重新注册"闭环没端到端跑（openid prefix 变了之后再登录/再注册的路径）

### 🔴 已知 gap

- **1.5** 行政区划仅河南 + 北京 4 条 smoke。生产环境用户只能填这 19 个地市。**扩展到全国**是 P1，数据可复用河南 seed 脚本。
- **1.4** 小程序码功能**依赖未配置的 MP_APPID**，生产上线前必须配 + 联调一次。

---

## 流 2：商品浏览 → 下单

业务目标：登录用户（含未绑推荐人的状态）浏览 → 绑定后看价 → 加购 → 下单

### 状态机

```
(consumer logged in, referrer 可能 null)
  ├─ 浏览 → 价格可能 null（未绑 referrer）
  │          ↓
  │        [联系业务员拿邀请码] → referrer_salesman_id 绑定
  │          ↓
  │        价格可见
  │          ↓
  └─ 加购 → 购物车 → preview → 下单 → order.status=pending_assignment
```

### 原子动作表

| # | 动作 | 角色 | 端点 | 前置 | 副作用 | 通知 | 状态 |
|---|---|---|---|---|---|---|---|
| 2.1 | 浏览**商品分类** | anon/consumer | `GET /api/mall/categories` | — | — | — | 🟢 |
| 2.2 | 浏览**首页标签楼层** | anon/consumer | `GET /api/mall/products/tags` | — | — | — | 🟢 |
| 2.3 | 浏览**商品列表** | anon/consumer | `GET /api/mall/products?category_id/tag_id/filter=` | — | apply_price_visibility 过滤脱敏 | — | 🟢 |
| 2.4 | 浏览**商品详情** | anon/consumer | `GET /api/mall/products/{id}` | status=on_sale | 脱敏 | — | 🟢 |
| 2.5 | **搜索商品** | anon/consumer | `GET /api/mall/search/products?q=` | — | 脱敏 | — | 🟢 |
| 2.6 | **热搜词** | anon/consumer | `GET /api/mall/search/hot-keywords` | — | — | — | 🟡（硬编码 5 个词）|
| 2.7 | **收藏商品** | consumer | `POST /api/mall/collections` | product.status=on_sale · 幂等 | MallCollection | — | 🟢 |
| 2.8 | 取消收藏 | consumer | `DELETE /api/mall/collections/{product_id}` | — | — | — | 🟢 |
| 2.9 | 收藏列表 | consumer | `GET /api/mall/collections` | — | 下架商品返 status 让前端标注 | — | 🟢 |
| 2.10 | **加购** | consumer | `POST /api/mall/cart/change` | SKU/prod on_sale · referrer_salesman_id IS NOT NULL | 幂等 upsert | — | 🟢 |
| 2.11 | 看**购物车** | consumer | `GET /api/mall/cart` | — | 下架商品 is_available=False 不计合计 | — | 🟢 |
| 2.12 | **地址 CRUD** | consumer | `GET/POST/PUT/DELETE /api/mall/addresses` | 删除 is_default=True 时自动把最早的提为新默认 | — | — | 🟢 |
| 2.13 | 设默认地址 | consumer | `PUT /api/mall/addresses/{id}/default` | — | 原默认清零 | — | 🟢 |
| 2.14 | **下单预览** | consumer | `POST /api/mall/orders/preview` | 每项 SKU on_sale + 成本价非空 | 算 subtotal/运费/优惠 | — | 🟢 |
| 2.15 | **创建订单** | consumer | `POST /api/mall/orders` | referrer 已绑 + referrer status=active · 每 SKU 成本价非空 · 地址属自己 | 扣 mall_inventory · 记 OUT flow · 固化 referrer_salesman_id · cost_price_snapshot · 清购物车对应项 · 订单 status=pending_assignment | — | 🟢 |
| 2.16 | **取消订单**（自己） | consumer | `POST /api/mall/orders/{no}/cancel` | status=pending_assignment · 属自己 | 退回 mall_inventory（按原 OUT flow 定位仓）· status=cancelled · 记 reason | — | 🟢 |
| 2.17 | 软删订单 | consumer | `DELETE /api/mall/orders/{no}` | status ∈ terminal 集合 | consumer_deleted_at | — | 🟢 |
| 2.18 | 订单 stats（各 tab 数） | consumer | `GET /api/mall/orders/stats` | — | 过滤 consumer_deleted_at | — | 🟢 |
| 2.19 | 订单**列表 + 详情** | consumer | `GET /api/mall/orders`, `GET /api/mall/orders/{no}` | — | 脱敏 | — | 🟢 |
| 2.20 | 看**物流轨迹**（虚拟） | consumer | `GET /api/mall/orders/{no}/logistics` | — | 返构造的时间线 | — | 🟢 |

### E2E 测试状态：⏳ partial
- ✅ 2.10 → 2.15 → 2.16 的下单/取消主路径走通
- ✅ 2.12 地址删除兜底修复后已通过 e2e_verify（场景外手工验证）
- ❌ 2.5 搜索边缘（空结果/长关键字/SQL 注入防御）未 smoke
- ❌ 2.6 搜索热词等 admin UI 无，只能直接读硬编码

### 🔴 已知 gap

- **2.6** 热搜词硬编码 5 个，admin 改不了。不阻塞上线但运营效率低。
- **2.15** 纯商城 SKU 没配 cost_price 时报错给用户，但**没给运营侧告警**（C 端会遇到自己搞不定的 409）。应在 admin dashboard 加 "无成本价 SKU 数" 告警。

---

## 流 3：业务员履约闭环

业务目标：订单池 → 抢单 → 出库（扫码）→ 送达（照片）→ 上传凭证 → 财务确认 → completed

### 状态机

```
pending_assignment
  ├─ 推荐人独占期（60min 内）──→ referrer claim → assigned
  ├─ 开放期（超时后）──────────→ 任何 salesman claim → assigned
  │
  └─ (超时 referrer 未接)──→ skip_log(NOT_CLAIMED_IN_TIME) 给 referrer
                             → 阈值 3/30d → mall_skip_alerts open

assigned
  ├─ salesman 自己 release → pending_assignment + skip_log(RELEASED)
  ├─ admin reassign → assigned(new) + skip_log(ADMIN_REASSIGNED)
  └─ ship → shipped
     └─ deliver → delivered
        └─ upload-payment-voucher → pending_payment_confirmation
           ├─ admin confirm-payment (全款) → completed
           │  └─ trigger commission + profit_ledger_posted=True
           ├─ admin confirm-payment (部分) → 仍 pending_payment_confirmation（累计 received < pay）
           └─ admin reject-payment-voucher → 回 delivered（单张 reject 后若无 pending 凭证）
```

### 原子动作表

| # | 动作 | 角色 | 端点 | 前置 | 副作用 | 通知 | 状态 |
|---|---|---|---|---|---|---|---|
| 3.1 | 看**抢单池**（独占/开放） | salesman | `GET /api/mall/salesman/orders/pool?scope=my/public` | — | 手机号脱敏 · 地址去门牌 | — | 🟢 |
| 3.2 | **抢单** | salesman | `POST /api/mall/salesman/orders/{id}/claim` | is_accepting_orders · has linked_employee · 独占期内必须 = referrer | status=assigned · claimed_at · claim_log(CLAIM) | notify_mall_user(consumer) | 🟢 |
| 3.3 | **释放订单** | salesman | `POST /api/mall/salesman/orders/{id}/release` | status=assigned（shipped 后不可自释） | status=pending_assignment · claim_log(RELEASE) · skip_log(RELEASED) 若 salesman=referrer（自买单免疫） | — | 🟢 |
| 3.4 | 查**条码是否归属自己** | salesman | `GET /api/mall/salesman/orders/{id}/verify-barcode?barcode=` | — | — | — | 🟡 |
| 3.5 | **出库**（扫码绑定 → OUT flow） | salesman | `POST /api/mall/salesman/orders/{id}/ship` | status=assigned · assigned_salesman=self · barcodes 数量=items 瓶数 | status=shipped · shipped_at · 批量 MallInventoryBarcode OUTBOUND · 记 outbound_by/order/at · MallShipment created | notify_mall_user(consumer) "订单已出库" | 🟢 |
| 3.6 | **送达**（上传照片） | salesman | `POST /api/mall/salesman/orders/{id}/deliver` | status=shipped · delivery_photos ≥ 1 | status=delivered · delivered_at · MallAttachment(DELIVERY_PHOTO) · MallShipment.delivered_at | notify_mall_user(consumer) "订单已送达，请确认收货" | 🟢 |
| 3.7 | 消费者**确认收货** | consumer | `POST /api/mall/orders/{no}/confirm-receipt` | status ∈ {delivered, pending_payment_confirmation, completed, partial_closed} · 幂等 | customer_confirmed_at | notify_mall_user(salesman) "客户已确认" | 🟢 |
| 3.8 | **上传收款凭证** | salesman | `POST /api/mall/salesman/orders/{id}/upload-payment-voucher` | status=delivered · 金额上限 pay_amount × 1.05 | status=pending_payment_confirmation · MallPayment(pending) · MallAttachment(PAYMENT_VOUCHER with sha256) | — | 🟢 |
| 3.9 | **看自己的订单**（5 tab） | salesman | `GET /api/mall/salesman/orders?status=` | — | — | — | 🟢 |
| 3.10 | 订单**详情**（含 payments 列表 + 驳回原因）| salesman | `GET /api/mall/salesman/orders/{id}` | assigned_salesman OR referrer_salesman 为 self | 返 payments 列表含 rejected_reason | — | 🟢 |

### E2E 测试状态：⏳ partial
- ✅ 3.2（claim）在 4bugs A 场景走通
- ✅ 3.3（release 自买单免疫）代码层验证
- ❌ 3.5-3.8 **整条 ship→deliver→upload-voucher 从没在真实数据走过端到端**
- ❌ 3.4 verify-barcode 未测

### 🔴 已知 gap
- **3.5 出库扫码防错**：仅校验"条码归属仓"，没校验"条码属于订单中的 SKU 之一"。业务员扫到别的 SKU 条码也能 ship 成功（不过 outbound_order_id 会错绑）。生产前必修。
- **3.8** 金额 5% 容忍上限（手续费抹零）仅适用分次收款合计，**单次凭证超过 pay_amount×5% 不会被挡**——admin 审的时候才发现。

---

## 流 4：财务收款确认

### 状态机（见流 3）

### 原子动作表

| # | 动作 | 角色 | 端点 | 前置 | 副作用 | 通知 | 状态 |
|---|---|---|---|---|---|---|---|
| 4.1 | 看**商城待确认**（审批中心 tab） | finance/admin/boss | `GET /api/mall/admin/payments/pending` | — | 返含 vouchers 照片 | — | 🟢 |
| 4.2 | **确认收款**（1 个订单的所有 pending 凭证）| finance/admin/boss | `POST /api/mall/admin/orders/{id}/confirm-payment` | status ∈ {delivered, pending_payment_confirmation} · ≥1 pending 凭证 | 所有 pending MallPayment → confirmed · 累加 received_amount · **按 item 品牌拆 Receipt(source='mall_order') + master cash +=  + FundFlow(credit)** · 若 ≥ pay_amount： status=completed + trigger commission + profit_ledger_posted=True · 增加商品 total_sales | notify consumer + salesman | 🟢 |
| 4.3 | **驳回单个凭证** | finance/admin/boss | `POST /api/mall/admin/payments/{id}/reject` | payment.status=pending_confirmation · reason 必填 | status=rejected · 若订单所有 pending 都被驳回 → 订单回 delivered | notify_mall_user(salesman) "凭证被驳回"（entity=MallOrder 跳详情） | 🟢 |
| 4.4 | **admin 手动补录收款** | admin/boss/finance | `POST /api/mall/admin/payments/manual-record/{order_id}` | status ∈ {delivered, pending_payment_confirmation, partial_closed} · 金额 > 0 · 上限 pay×1.05 | 建 MallPayment(confirmed) · received_amount += amount · **按品牌拆 Receipt + master cash += + FundFlow(credit)** · 若全款 → completed + trigger commission（含 partial_closed top-up 差额 commission） · 若原是 partial_closed → 恢复 status 按金额判定 | — | 🟢 |

### E2E 测试状态：⏳ partial
- ✅ 4.2 主路径（凭证 → 确认 → completed + Receipt/master/FundFlow）走通 → `scripts/e2e_mall_cash_flow.py`
- ✅ 4.3 驳回 → 订单回 delivered 的状态机修过
- ❌ 4.4 manual-record 的 **partial_closed 恢复路径** 未端到端测
- ❌ **部分付款触发多次 commission 补差额** 从 commit 记录看有修过，但没跑过端到端回归

### 🔴 已知 gap
无明显。但 4.4 的 **partial_closed→completed 恢复** 因为改过 `completed_at` 逻辑，强烈建议 E2E 回归一次。

---

## 流 5：订单折损（partial_closed）

业务目标：60 天未全款订单自动转 partial_closed，按已收额结算提成 + 坏账进利润台账

### 状态机

```
delivered/pending_payment_confirmation
  ↓ (housekeeping job_detect_partial_close 每日扫描 >60天)
partial_closed
  ├─ commission posted 按 received_amount 切分（如果之前没 posted 过）
  ├─ profit_ledger 聚合时 mall_bad_debt 科目 = pay_amount - received_amount
  │
  └─ [客户又来付钱] → admin manual_record_payment
     ├─ received < pay → 仍 partial_closed
     └─ received ≥ pay → completed（completed_at 覆盖为此刻）+ 触发 top-up commission
```

### 原子动作表

| # | 动作 | 角色 | 端点 | 前置 | 副作用 | 通知 | 状态 |
|---|---|---|---|---|---|---|---|
| 5.1 | 定时**扫描 60 天未全款** | system | `housekeeping.job_detect_partial_close` (每日) | created_at ≤ cutoff · 未 profit_ledger_posted | status=partial_closed · 按当前 received 计 commission · profit_ledger_posted=True · completed_at 留空（区别于真 completed） | notify consumer + salesman + referrer "订单坏账关单" | 🟢 |
| 5.2 | admin 手动触发扫描 | admin/boss | `POST /api/mall/admin/housekeeping/detect-partial-close` | — | 同 5.1，trigger='manual' 落 MallJobLog | — | 🟢 |
| 5.3 | 查**执行历史** | admin/boss | `GET /api/mall/admin/housekeeping/logs[/summary]` | — | — | — | 🟢 |

### E2E 测试状态：❌ untested
- 定时任务**从未在生产数据上触发过** — 需要至少造一条 60 天前的订单测
- 5.1 触发后的利润台账 mall_bad_debt 聚合未验证过

### 🔴 已知 gap
- **未测试**本身就是 gap。plan 里明确 M4a 要 E2E。建议写一个 `e2e_verify_partial_close.py` 造数据 + 跑 job + 断言。

---

## 流 6：退货闭环

### 状态机

```
completed / partial_closed
  ↓ [consumer apply_return]
pending
  ├─ [admin approve]
  │   → MallOrder.status=refunded
  │   → mall_inventory +quantity + IN flow(ref_type=return)
  │   → MallInventoryBarcode outbound→in_stock
  │   → pending commission → reversed
  │   ↓
  │   approved
  │   ↓ [admin mark-refunded + refund_method]
  │   refunded（终态）
  │
  └─ [admin reject]
      → rejected（终态）
      订单留 completed/partial_closed 不变
```

### 原子动作表

| # | 动作 | 角色 | 端点 | 前置 | 副作用 | 通知 | 状态 |
|---|---|---|---|---|---|---|---|
| 6.1 | consumer **申请退货** | consumer | `POST /api/mall/orders/{no}/return` | status ∈ {completed, partial_closed} · 同订单无活跃申请 | MallReturnRequest(pending) | notify_roles(admin/boss/finance) | 🟢 |
| 6.2 | consumer **查退货状态** | consumer | `GET /api/mall/orders/{no}/return` | 属自己 | 返最新一条 | — | 🟢 |
| 6.3 | admin **列表 + 详情** | admin/boss/finance | `GET /api/mall/admin/returns[?status=][/{id}]` | — | — | — | 🟢 |
| 6.4 | admin **批准** | admin/boss/finance | `POST /api/mall/admin/returns/{id}/approve` | status=pending | 订单→refunded · 退库存 + IN flow · 条码回 in_stock · **FOR UPDATE 锁申请+订单（G12）** · pending commission→reversed · **settled commission→新建 is_adjustment=True 负数行 pending（决策 #1, m6c1）** · **扣 MallProduct.net_sales（决策 #4, m6c3）** · refund_amount 默认=received_amount · **log_audit mall_return.approve（G2）** | notify consumer + salesman（entity=MallOrder） | 🟢 |
| 6.5 | admin **驳回** | admin/boss/finance | `POST /api/mall/admin/returns/{id}/reject` | status=pending · reason 必填 | status=rejected | notify consumer | 🟢 |
| 6.6 | admin **标记已退款**（线下打款完成）| admin/boss/finance | `POST /api/mall/admin/returns/{id}/mark-refunded` | status=approved · refund_method ∈ {cash,bank,wechat,alipay} | status=refunded · refunded_at · refund_method | notify consumer | 🟢 |

### E2E 测试状态：✅ 全覆盖
- ✅ 6.1 → 6.4 → 6.6 主路径（`scripts/e2e_full_mall_flow.py`）
- ✅ 6.4 批准时条码回 in_stock + 订单隔离（`scripts/e2e_mall_return_barcode_revert.py`）
- ✅ settled commission 跨月退货追回完整链路（`scripts/e2e_cross_month_commission_clawback.py`，决策 #1 m6c1）
- ✅ 退货 approve 并发保护（`scripts/e2e_return_approve_concurrency.py`，G12 m6c6）
- ✅ 审计留痕（`scripts/e2e_audit_coverage.py`，G2 审计）

### ✅ 已解决 gap
- ~~6.4 settled commission 冲销~~ → **决策 #1 方案 2+B**：走负数 adjustment Commission + 工资不足挂账下月扣（m6c1）
- ~~6.4 并发双 approve 建双份 adjustment~~ → **FOR UPDATE + partial UNIQUE 双保**（m6c6）

### 🔴 剩余 gap
- **6.6** refund_method 存了但**不动账户**（线下打款）。如果想把退款从 brand cash account 扣除，需要加 disburse 动作。（业务决策：老板一般不从账户扣，现金退）

---

## 流 7：跳单告警 + 申诉裁决

### 状态机

```
[触发条件：同一 (customer, salesman) 30 天内非 dismissed skip_logs ≥ 3]
  ↓
mall_skip_alerts(open)
  ├─ [salesman appeal with reason]
  │   → 留 appeal_reason/appeal_at
  │   → notify admin/boss
  │
  └─ [admin resolve]
      ├─ resolved（告警成立）→ salesman 收通知
      └─ dismissed（申诉成立）→ 对应 skip_logs.dismissed=True 不计入下次阈值 → salesman 收通知
```

### 原子动作表

| # | 动作 | 角色 | 端点 | 前置 | 副作用 | 通知 | 状态 |
|---|---|---|---|---|---|---|---|
| 7.1 | **skip_log 自动触发**（release/reassign/timeout） | system | `_record_skip_log` in order_service | 非自买单 | MallCustomerSkipLog · 达阈值触发 MallSkipAlert | — | 🟢 |
| 7.2 | salesman 看**我的告警** | salesman | `GET /api/mall/salesman/skip-alerts` | — | 含客户脱敏昵称/手机 | — | 🟢 |
| 7.3 | salesman **申诉** | salesman | `POST /api/mall/salesman/skip-alerts/{id}/appeal` | alert.status=open · reason 1-500 字 | appeal_reason/appeal_at | notify_roles(admin, boss) "申诉待裁决" | 🟢 |
| 7.4 | admin **裁决**（resolved/dismissed） | admin/boss | `POST /api/mall/admin/skip-alerts/{id}/resolve` | alert.status=open | status=resolved/dismissed · dismissed 时把 trigger_log_ids 对应 skip_logs 标 dismissed=True | notify_mall_user(salesman) "告警已裁决" | 🟢 |

### E2E 测试状态：⏳ partial
- ✅ 7.1 触发逻辑（阈值 + 幂等）单元级验证
- ❌ 7.3 + 7.4 申诉→裁决端到端未跑
- ❌ dismissed 后**第二次达阈值是否正确计数**（排除 dismissed=True 的 skip_log）未回归

### 🔴 已知 gap 无

---

## 流 8：库存域（仓 + 条码 + 入仓）

### 入仓入口定位（2026-05 对齐 → 2026-05 扩展，必须遵守）

商城入仓三条路径，日常建议按工作量取舍：

- **🟢 调拨入 mall 仓**：`transfer_service` 从 ERP 非主仓 or 其他 mall 仓调入（每瓶扫码过户 + registry 跟迁）。Phase A + Gap 1 修复后全链路 ready。**适合已有 ERP 库存的商品**。
- **🟢 mall 仓管自采**：miniprogram `/api/mall/workspace/purchase-orders` 建单（target=`mall_warehouse`，仓管只能选自己 `MallWarehouse.manager_user_id` 指向的仓）→ boss/finance 在 ERP `/purchase-orders/{id}/approve` 审批 → 仓管在 miniprogram 扫码收货（`/purchase-receiving/{po_id}/receive`）。审批通过/驳回自动 `notify_po_creator` 推通知。**适合仓管直接对接供应商的场景**。
- **⚠️ admin inbound / barcodes import**（8.3 / 8.4）：**定位灰度 / 管理员 / 应急**。不作为日常业务入口推广；生产上优先走调拨或自采。

做 review 时：看到 mall_inbound 被频繁当常规入口 → 口径问题；仓管自采必须检查权限只能选自己管的仓（`_require_po_creator` / `_CreatorCtx.mall_wh_ids`）。门店侧同理，店长自采走同一个 workspace 端点，`assigned_store_id` 非空即识别。

### 状态机（条码）

```
in_stock ──ship──→ outbound (绑 outbound_order_id)
  │                │
  │                └──(order cancelled / return approved)──→ in_stock（清 outbound_*）
  │
  └──damage──→ damaged (终态)
```

### 原子动作表

| # | 动作 | 角色 | 端点 | 前置 | 副作用 | 通知 | 状态 |
|---|---|---|---|---|---|---|---|
| 8.1 | admin **仓库 CRUD** | admin/boss/warehouse | `/api/mall/admin/warehouses` | manager_user_id 必须 salesman（CHECK 约束 + trigger T1） | — | — | 🟢 |
| 8.2 | admin **禁用仓** | admin/boss/warehouse | `DELETE /api/mall/admin/warehouses/{id}` | 仓内无库存 · 无在途订单 | is_active=False | — | 🟢 |
| 8.3 | admin **入库 + 生成条码**（⚠️ 灰度/应急） | admin/boss/warehouse/purchase | `POST /api/mall/admin/inventory/inbound` | — | MallInventory +qty · 批量 MallInventoryBarcode(in_stock) · MallInventoryFlow(IN) · 加权平均成本更新 | — | 🟢（定位：应急；日常走调拨） |
| 8.4 | admin **批量导入预印条码**（⚠️ 灰度/应急） | admin/boss/warehouse/purchase | `POST /api/mall/admin/inventory/barcodes/import` | 所有条码不存在（任一存在即拒） | 同 8.3 | — | 🟢（定位：应急） |
| 8.5 | admin **单瓶损耗** | admin/boss/warehouse | `POST /api/mall/admin/inventory/barcodes/{barcode}/damage` | 条码.status=in_stock · quantity ≥ 1 | status=damaged · qty-1 · MallInventoryFlow(ADJUST) | — | 🟢 |
| 8.6 | 查**库存** | admin/boss/warehouse | `GET /api/mall/admin/inventory` | — | 过滤 low_stock | — | 🟢 |
| 8.7 | 查**库存流水** | admin/boss/warehouse | `GET /api/mall/admin/inventory/flows` | — | — | — | 🟢 |
| 8.8 | 查**条码** | admin/boss/warehouse | `GET /api/mall/admin/inventory/barcodes?status/warehouse/sku` | — | — | — | 🟢 |
| 8.9 | **采购入 mall 仓**（总部代建 or 仓管自建）| admin/boss/purchase（ERP 前端）或 mall 仓管（miniprogram） | `POST /api/purchase-orders` OR `POST /api/mall/workspace/purchase-orders` | MP item.product_id 必须有对应 MallProduct 映射；仓管自建只能选自己管的 mall 仓 | 按 PO 走 ERP 审批 · boss/finance approve/reject 后 `notify_po_creator` 推发起人 | ✅ 审批结果通知发起人 | 🟢 `e2e_self_purchase` 已验证 |
| 8.10 | **mall 仓收货** | admin/boss/warehouse/purchase（或 mall 仓管业务员 via miniprogram） | `POST /api/purchase-orders/{id}/receive?batch_no=` 或 `/api/mall/workspace/purchase-receiving/{po_id}/receive` | po.target_warehouse_type=mall_warehouse · 所有 item 有 MallProduct 映射 | MallInventory +qty · 加权平均成本 · MallInventoryFlow(IN, ref_type=purchase) · 扫码入库 mall_inventory_barcodes + registry | — | 🟢 `e2e_mall_salesman_po_receive` 已验证 |

### E2E 测试状态：⏳ partial
- ✅ 8.1 / 8.2 创建/禁用人工测过
- ✅ 8.3 inbound + 8.5 damage 单独跑过
- ✅ **8.9 + 8.10 采购入 mall 仓** — `e2e_self_purchase.py`（仓管自建 + 权限隔离 + 审批通知）+ `e2e_mall_salesman_po_receive.py`（仓管扫码收货）
- ❌ **下单扣库存后取消/退货 → 条码状态正确流转** 虽然单元代码有，但真实订单 E2E 没跑

### 🔴 已知 gap
- 8.10 无条码化的 mall 仓入库后，**业务员 ship 时扫不到条码**（因为没条码），要走"按 SKU 数量出库"路径。但现有 `ship_order` 要求扫码绑定 — 冲突。应在 ship 时检查 SKU 是否有条码，无条码的走数量扣减，有条码的走扫码。**这是生产阻塞级 P0**，必修。

---

## 流 9：业务员工作台（ERP 复用）

业务目标：mall 业务员在小程序打卡/请假/报销/稽查/查 KPI/看通知，数据进 ERP 的 attendance / expense_claims 等。

### 原子动作表

| # | 动作 | 角色 | 端点 | 前置 | 副作用 | 通知 | 状态 |
|---|---|---|---|---|---|---|---|
| 9.1 | **打卡** | salesman | `POST /api/mall/workspace/attendance/checkin` | linked_employee 存在且 active · GPS 在地理围栏内 | CheckinRecord | — | 🟢 |
| 9.2 | 查**今日打卡** | salesman | `GET /api/mall/workspace/attendance/today` | — | — | — | 🟢 |
| 9.3 | **拜访进店/出店** | salesman | `POST /api/mall/workspace/attendance/visits/enter\|leave` | — | Visit + end_visit_at | — | 🟢 |
| 9.4 | 月度考勤 | salesman | `GET /api/mall/workspace/attendance/monthly-summary` | — | — | — | 🟢 |
| 9.5 | **请假申请** | salesman | `GET/POST /api/mall/workspace/leave` | employee active · leave_type 合法 | LeaveRequest · 审计 | — | 🟢 |
| 9.6 | **报销申请** | salesman | `GET/POST /api/mall/workspace/expense` | employee active · F 类必带 brand_id | ExpenseClaim · 审计 | — | 🟢 |
| 9.7 | **扫码稽查** | salesman | `GET/POST /api/mall/workspace/inspection` | barcode\|qrcode 至少一项 · quantity > 0 | InspectionCase(status=pending) | — | 🟢 |
| 9.8 | 我的**KPI** | salesman | `GET /api/mall/workspace/kpi/my-dashboard` | — | 按 assigned_salesman_id + created_at 月份聚合 | — | 🟢 |
| 9.9 | 通知**列表/已读/未读数** | salesman/consumer | `GET /api/mall/workspace/notifications[/unread-count]` + `POST /{id}/mark-read` + `/mark-all-read` | recipient_type=mall_user · mall_user_id=self | 响应含 related_order_no 反查 | — | 🟢 |

### E2E 测试状态：✅ 主路径
- ✅ 9.1/9.5/9.6/9.7 人工测过（都是复用 ERP 成熟接口）
- ✅ 9.8 KPI 快照冻结（`scripts/e2e_kpi_snapshot.py`，决策 #2 m6c4）
- ❌ 9.3 拜访进店/出店的 **GPS 计时 + 结束时间生成**未实测

### ✅ 已解决 gap
- ~~9.8 KPI 跨月退货数据回改~~ → **决策 #2：快照 + 实时双模式**（m6c4）
  - 月初 1 号 00:05 `job_build_last_month_snapshot` 冻结上月 KPI
  - `GET /api/mall/admin/dashboard/salesman-ranking?mode=snapshot|realtime&year_month=YYYY-MM`
  - 发奖金看快照，看趋势看实时

---

## 流 10：运营后台（admin 配套）

| # | 动作 | 角色 | 端点 | 状态 |
|---|---|---|---|---|
| 10.1 | 商品 CRUD + 上下架 + 改价（含审计） | admin/boss | `/api/mall/admin/products` | 🟢 |
| 10.2 | 分类 CRUD + 标签 CRUD | admin/boss | `/api/mall/admin/categories, /tags` | 🟢 |
| 10.3 | 店铺公告 CRUD + 发布/撤回 | admin/boss | `/api/mall/admin/notices` | 🟢 |
| 10.4 | 邀请码查询 + 统计 + 作废 | admin/boss | `/api/mall/admin/invite-codes` | 🟢 |
| 10.5 | C 端用户列表 + 详情（含审批资料 + 退货记录） | admin/boss/finance | `/api/mall/admin/users` | 🟢 |
| 10.6 | 手动启用/禁用 C 端用户 | admin/boss | `/{id}/reactivate, /{id}/disable` | 🟢 |
| 10.7 | 换绑推荐人（带审计 + 3 方通知） | admin/boss | `PUT /{id}/referrer` | 🟢 |
| 10.8 | 业务员管理 CRUD + 禁用级联释放订单 | admin/boss/hr | `/api/mall/admin/salesmen` | 🟢 |
| 10.9 | 订单**改派** | admin/boss | `POST /api/mall/admin/orders/{id}/reassign` | 🟢（智能下拉已加）|
| 10.10 | 订单**取消**（已扣库存/已出库都支持）| admin/boss | `POST /api/mall/admin/orders/{id}/cancel` | 🟢 |
| 10.11 | **dashboard** 聚合（今日/昨日/本月/待处理/排行/低库存） | admin/boss/finance | `GET /api/mall/admin/dashboard/summary` | 🟢 |
| 10.12 | **登录日志** + **操作审计** | admin/boss | `/api/mall/admin/login-logs, /audit-logs` | 🟢 |
| 10.13 | **跳单告警**管理 | admin/boss | `/api/mall/admin/skip-alerts` | 🟢 |
| 10.14 | **housekeeping 执行历史** | admin/boss | `/api/mall/admin/housekeeping/logs` | 🟢 |

### E2E 测试状态：⏳ partial
大部分 admin 功能是单向查询/CRUD，前端上线就会用。但**整条业务网的端到端回归**从未做过（从 admin 建业务员 → 业务员扫码注册 → 下单 → ship → deliver → 确认收款 → 退货 → 退款完成 一条贯通）。

### 🔴 已知 gap 无单独 gap，但见**整体 E2E**缺失。

---

## 整体评估 · 生产上线前必做的 E2E

按优先级：

### P0（阻塞上线）

1. **流 5 整条**：造 60 天前订单 → `detect_partial_close` → 验证 `mall_bad_debt` 利润台账 + commission 按 received 计。
2. **流 8 的 8.10 mall 仓 ship**：mall 仓入库后业务员如何出库（条码 vs 数量）的语义冲突必须先设计再测。
3. **一条贯通的 E2E 脚本**（新建 `scripts/e2e_full_mall_flow.py`）：从 admin 创业务员 → 生成邀请码 → C 端注册 → 审批 → 下单 → 抢单 → 出库 → 送达 → 凭证 → 确认 → 提成入账 → 退货 → 退款。

### P1（上线后一周内）

4. **流 6 驳回后重新申请**：rejected → 再 apply_return 幂等吗？
5. **流 6 settled commission 在退货后的工资单处理**：业务决策 + 测。
6. **流 7 dismissed skip_log 不再计入阈值** 回归。
7. **流 9.8 KPI 在跨月退货时数字变化** 业务决策。

### P2（运营优化）

8. **2.6 热搜词** 加 admin 管理页。
9. **1.5 行政区划** 扩全国。
10. **2.15** 无成本价 SKU 告警进 dashboard。
11. **3.5** 出库扫码增加"条码属于订单 SKU 之一"校验。
12. **3.8** 单次凭证超过 pay×5% 的硬上限。

---

## 各流 E2E 状态速查

| 流 | 名称 | E2E 状态 | 拦路问题 |
|---|---|---|---|
| 1 | 注册审批 | ⏳ partial | 1.4 小程序码 + 1.5 全国区划 |
| 2 | 浏览下单 | ⏳ partial | 无成本价 SKU 告警 |
| 3 | 业务员履约 | ⏳ partial | **整条 ship→deliver→voucher 未端到端跑** |
| 4 | 财务确认 | ⏳ partial | partial_closed 恢复路径未回归 |
| 5 | 订单折损 | ❌ untested | **从未触发过** |
| 6 | 退货 | ⏳ partial | 条码回 in_stock 的修刚完成未验，settled commission 策略待定 |
| 7 | 跳单告警 | ⏳ partial | dismissed 逻辑未回归 |
| 8 | 库存 | ⏳ partial | **mall 仓 ship 语义冲突** |
| 9 | 工作台复用 | ⏳ partial | 9.8 跨月退货对 KPI 的影响待定 |
| 10 | 运营后台 | ⏳ partial | 无整体贯通 E2E |

**结论**：代码层面 90% 以上 🟢，但**端到端验证覆盖 <30%**。生产上线最大风险是 **P0 三项**，其次是一整条贯通脚本。
