# ERP 业务原子化与开发状态

本文件按**业务流**切分 ERP（管理台）的原子动作。配合 `business-atoms-mall.md` + `business-atoms-bridges.md` 构成完整业务网。

ERP 核心闭环 plan 明确"已稳定"（决策 #1，见 rustling-floating-treehouse.md），本文件粒度偏"主干动作 + 状态机"，不做 mall 那样逐端点穷举。

**图例同 mall**：🟢 done · 🟡 coded 未 E2E · 🔴 gap · ⚪ n/a

---

## 流 E1：B2B 订单建单 → 政策审批 → 出库 → 送达

### 关键铁律：合并接口

订单 + PolicyRequest 是**两条平行状态机**，必须**同步前进**才能通过 ship 校验。Agent **必须**用合并接口（前端正在用的真实路径）：

| 业务动作 | ❌ 禁用裸接口（断档风险） | ✅ 必须用合并接口 |
|---|---|---|
| 建单 | `POST /api/orders` | `POST /api/orders/create-with-policy` |
| 批准政策 | `POST /api/orders/{id}/approve-policy` | `POST /api/orders/{id}/approve-policy-with-request` |
| 驳回政策 | `POST /api/orders/{id}/reject-policy` | `POST /api/orders/{id}/reject-policy-with-request` |

裸接口只动 Order 一边，PolicyRequest 不存在 / 不更新 → 出库时 `ship_order` 校验 PolicyRequest 失败 400 "无法出库"。详见 `SKILL.md` §4.6。

### 状态机

```
pending ──submit-policy──→ policy_pending_internal
                                 ↓ approve-policy-with-request（boss，同步动 Order + PR）
                    ┌────────────┼────────────┐
                    ↓                         ↓
       (need_external=False)    (need_external=True)
                    ↓                         ↓
                approved         policy_pending_external
                                              ↓ confirm-external（厂家）
                                          approved
                    └────────────┬────────────┘
                                 ↓ ship（warehouse 扫码）
                              shipped
                                 ↓ upload-delivery + confirm-delivery
                              delivered
                                 ↓ （凭证 + 财务审批流见流 E2）
                              completed
```

### 原子动作表

| # | 动作 | 角色 | 端点 | 前置 | 副作用 | 通知 | 状态 |
|---|---|---|---|---|---|---|---|
| E1.1 | **预览订单**（匹配政策）| salesman/sm_mgr/boss | `POST /api/orders/preview` | 客户可见（RLS） · 政策模板匹配 | 返预算金额 | — | 🟢 |
| E1.2 | **建单**（合并：Order + PolicyRequest + items + submit-policy）| salesman/sm_mgr/boss | **`POST /api/orders/create-with-policy`** ⭐ | — | Order(policy_pending_internal) + items + PolicyRequest + request_items[] · 按结算模式预填 customer_paid_amount · 一个事务 | 给 boss | 🟢 |
| E1.2-deprecated | ~~只建 Order，不建 PR~~ | — | ~~`POST /api/orders`~~ ❌ **禁用** | — | 只产 Order，**没有 PolicyRequest** → 后续 ship 必失败 | — | ⚠️ legacy |
| E1.3 | 删除 pending 订单 | salesman/boss | `DELETE /api/orders/{id}` | status=pending | — | — | 🟢 |
| E1.4 | **提交政策审批**（如走老的分步路径）| salesman/sm_mgr | `POST /api/orders/{id}/submit-policy` | status=pending | status=policy_pending_internal | 给 boss | 🟢（合并接口已包含此步）|
| E1.5 | **批准政策**（合并：Order + PR 同时推进）| boss | **`POST /api/orders/{id}/approve-policy-with-request`** ⭐ | Order.status=policy_pending_internal · 必有未批 PR | Order → approved（或 policy_pending_external，若 need_external=true）+ PolicyRequest.status=approved | — | 🟢 |
| E1.5-deprecated | ~~只推 Order.status，不动 PR~~ | — | ~~`POST /api/orders/{id}/approve-policy`~~ ❌ **禁用** | — | Order=approved 但 PR 仍 pending → ship 必失败 | — | ⚠️ legacy |
| E1.6 | **驳回政策**（合并：Order + PR 同时回退）| boss | **`POST /api/orders/{id}/reject-policy-with-request`** ⭐ | status ∈ policy_pending_* | status=policy_rejected · PolicyRequest.status=rejected · reason | 给 salesman | 🟢 |
| E1.6-deprecated | ~~只推 Order.status，不动 PR~~ | — | ~~`POST /api/orders/{id}/reject-policy`~~ ❌ **禁用** | — | 同上断档风险 | — | ⚠️ legacy |
| E1.7 | **重提**（驳回后改单） | salesman/boss | `POST /api/orders/{id}/resubmit` | status=policy_rejected | status=policy_pending_internal | — | 🟢 |
| E1.8 | 厂家确认（外审） | manufacturer_staff | `POST /api/orders/{id}/confirm-external` | status=policy_pending_external | status=approved | 给 salesman | 🟢 |
| E1.9 | **出库**（扫码）| warehouse/boss | `POST /api/orders/{id}/ship` | status=approved · 扫满箱数 | 扣 inventory（按 LIFO/FIFO 批次）· StockFlow(order_out) · barcodes OUTBOUND · status=shipped | — | 🟢 |
| E1.10 | 上传**送货照片** | warehouse/boss | `POST /api/orders/{id}/upload-delivery` | status=shipped | Attachment | — | 🟢 |
| E1.11 | **确认送达** | warehouse/boss | `POST /api/orders/{id}/confirm-delivery` | status=shipped · 至少 1 张送货照 | status=delivered | 给 salesman | 🟢 |
| E1.12 | 查利润 | finance/boss | `GET /api/orders/{id}/profit` | status=completed | 聚合 ProfitLedger | — | 🟢 |

### E2E 测试状态：🟢 tested（ERP 历史核心闭环，生产使用中）

---

## 流 E2：收款凭证 → 审批 → completed + 提成

### 状态机

```
order.status=delivered + payment_status=unpaid
  ↓ upload-payment-voucher
payment_status=pending_confirmation
  Receipt(status=pending_confirmation)
  ├─ finance approve（/orders/{id}/confirm-payment）
  │   → Receipt→confirmed · 入 master 现金 · 累加 customer_paid_amount
  │   → (若累计 ≥ 应收) → order.status=completed · payment_status=fully_paid · 生成 Commission · F 类政策解锁兑付
  │   → (累计 < 应收) → payment_status=partially_paid 保持
  │
  └─ finance reject（/orders/{id}/reject-payment-receipts）
      → Receipt→rejected · 不动账 · salesman 收通知重传
```

### 原子动作表

| # | 动作 | 角色 | 端点 | 前置 | 副作用 | 通知 | 状态 |
|---|---|---|---|---|---|---|---|
| E2.1 | 业务员**上传凭证** | salesman/sm_mgr/boss | `POST /api/orders/{id}/upload-payment-voucher` | status=delivered/partially_paid | Receipt(pending) · MallAttachment-like · payment_status → pending_confirmation | — | 🟢 |
| E2.2 | finance 直接建 Receipt（无需业务员）| finance/boss | `POST /api/receipts` | — | Receipt(status=**confirmed**) 立即入账 | — | 🟢 |
| E2.3 | **批准凭证**（整单的 pending 批量）| finance/boss | `POST /api/orders/{id}/confirm-payment` | ≥1 pending Receipt | 所有 pending → confirmed · 入 master · 累加 customer_paid_amount · 若全款 → completed + Commission | — | 🟢 |
| E2.4 | **驳回凭证**（单张 / 批量）| finance/boss | `POST /api/orders/{id}/reject-payment-receipts` | receipt.status=pending | 全批 rejected · payment_status 回 unpaid/partially_paid | salesman 收通知 | 🟢 |
| E2.5 | 查订单的**所有 Receipt** | finance/boss/salesman | `GET /api/orders/{id}/receipts` | — | — | — | 🟢 |
| E2.6 | **删除凭证**（错传） | finance/boss | `DELETE /api/receipts/{id}` | status=pending（confirmed 不可删）| — | — | 🟢 |

### E2E 测试状态：🟢 tested

---

## 流 E3：政策模板 + F 类账户 + 兑付

### 状态机（Policy 单子）

```
draft ──submit──→ pending ──approve──→ active ──execute──→ executed
                              ↓
                          rejected
```

（订单里挂载的 policy_snapshot 不是独立状态机，跟随订单走）

### 原子动作表

| # | 动作 | 角色 | 端点 | 前置 | 副作用 | 通知 | 状态 |
|---|---|---|---|---|---|---|---|
| E3.1 | 政策模板 CRUD | boss/finance | `/api/policy-templates` | — | — | — | 🟢 |
| E3.2 | 政策**匹配** | 任何员工 | `GET /api/policy-templates/templates/match?brand_id=&cases=&unit_price=` | — | 返最优模板 | — | 🟢 |
| E3.3 | 政策**启用/禁用** | boss | `PUT /api/policy-templates/{id}/status` | — | — | — | 🟢 |
| E3.4 | **F 类政策应收**（厂家返利挂账）| system（订单 completed 自动）| 订单完成联动 | 已 confirm external | F 类 Receivable 挂到品牌 | finance | 🟢 |
| E3.5 | **F 类到账** | finance/boss | `POST /api/accounts/f-class-receive` | — | 入品牌 F 类账户 · Receivable.status=received | — | 🟢 |
| E3.6 | F 类**兑付**（salesman 自费订单的差额）| finance/boss | `POST /api/policies/{id}/execute` | F 类账户有足额 | 品牌 F 类减账 · 业务员拿补贴 · ProfitLedger record | salesman | 🟢 |

### E2E 测试状态：🟢 tested

---

## 流 E4：提成结算 + 工资单

### 状态机（SalaryRecord）

```
draft（系统生成月度草稿）
  ↓ submit_for_approval
pending_approval
  ├─ approve（boss）→ approved
  │                    ↓ pay_salary
  │                 paid（终态 · 对应 commission 标 settled）
  │
  └─ reject（boss）→ draft（重算）
```

### 原子动作表

| # | 动作 | 角色 | 端点 | 前置 | 副作用 | 通知 | 状态 |
|---|---|---|---|---|---|---|---|
| E4.1 | 订单 completed**自动生成 Commission** | system | `post_commission_for_order` in receipt/order service | order.status=completed · mall_order 用 commission_service.post_commission_for_order | Commission(status=pending, employee_id=linked or 直属) | — | 🟢 |
| E4.2 | **Commission 冲销**（mall/store 退货 approved）| system | `approve_return` in return_service / store_return_service | return.status=pending | **pending** commission → reversed；**settled** commission → 新建 is_adjustment=True 负数行（决策 #1 m6c1） | — | 🟢 |
| E4.2a | **跨月追回 adjustment**（决策 #1） | system | 同 E4.2 的 settled 分支 | 原 commission.status=settled | Commission(is_adjustment=True, amount=-原, status=pending, adjustment_source=原.id) · partial UNIQUE 保证幂等 | — | 🟢 |
| E4.3 | **partial_closed top-up**（欠款后补交全款）| system | `manual_record_payment` | 订单之前 partial_closed → 现在 received≥pay | 新补一笔 Commission 差额（避免 commission_posted 卡住）| — | 🟢 |
| E4.4 | 月末**生成工资单** | hr/boss | `POST /api/payroll/generate/{year}/{month}` | 本月无 draft | SalaryRecord(draft) · 汇总 pending Commission（含负数 adjustment）· **先扣历史挂账 SalaryAdjustmentPending** · 当月仍负→挂账下月 | — | 🟢 |
| E4.5 | 提交审批 | hr | `POST /api/payroll/{id}/submit` | status=draft | status=pending_approval | boss | 🟢 |
| E4.6 | **批准工资** | boss | `POST /api/payroll/{id}/approve` | status=pending_approval | status=approved | — | 🟢 |
| E4.7 | **发放工资** | finance/boss | `POST /api/payroll/{id}/pay-salary` | status=approved | status=paid · 关联 Commission.status=settled · settled_at · 结清挂账 `settled_in_salary_id` | salesman | 🟢 |
| E4.8 | 驳回工资单 | boss | `POST /api/payroll/{id}/reject` | status=pending_approval | status=draft（重算） | hr | 🟢 |

### E2E 测试状态：✅ 全覆盖
- ✅ `e2e_reversed_commission_excluded` reversed commission 不进工资单
- ✅ `e2e_cross_month_commission_clawback` 跨月追回 + 挂账完整链路（决策 #1 m6c1）
- ✅ `e2e_return_approve_concurrency` G12 并发 approve 兜底（m6c6）
- ✅ `e2e_store_commission_in_payroll` 门店零售 commission 进工资单
- ✅ `e2e_clawback_transparency` salary_detail 返 clawback_details（G4）

### ✅ 已解决 gap
- ~~E4.2 reversed commission 是否进工资单~~ → 已回归（filter `status='pending'` 自动排除）
- ~~settled 后退货处理~~ → 决策 #1 方案 2+B（m6c1）

---

## 流 E5：稽查案件（A1 亏损扣款）

### 状态机

```
pending ──submit──→ (审批流由 boss/finance 驳回/批准)
  ├─ rejected → 终态
  └─ approved ──execute──→ executed（终态 · 品牌现金扣款 + 利润台账）
```

### 原子动作表

| # | 动作 | 角色 | 端点 | 前置 | 副作用 | 通知 | 状态 |
|---|---|---|---|---|---|---|---|
| E5.1 | 财务/老板**正式建案**；业务员走 mall workspace 提报 | boss/finance | `POST /api/inspection-cases` | barcode/qrcode 至少一项 · 数量 > 0 · 外流必须有原始订单 · A1/A2/B1/B2 价格字段齐全 | InspectionCase(pending) | finance/boss | 🟢 |
| E5.2 | **批准**案件 | boss/finance | `PUT /api/inspection-cases/{id}` `status=approved` | status=pending | status=approved | — | 🟢 |
| E5.3 | **执行扣款** | finance/boss | `POST /api/inspection-cases/{id}/execute` | status=approved | brand cash -A1_loss · ProfitLedger(inspection_loss) · 扣 salesman 提成 | — | 🟢 |
| E5.4 | 驳回案件 | boss/finance | `PUT /api/inspection-cases/{id}` `status=rejected` | status=pending | status=rejected | — | 🟢 |

### E2E 测试状态：🟢 tested

### 🔴 已知 gap 无，但注意 mall 业务员通过 workspace 创建的 inspection 只能到 **pending**，执行权还在 ERP 原审批流。

---

## 流 E6：采购单（含跨仓入 mall）

### 状态机

```
pending ──approve-finance──→ paid（现金+F 类+融资合计=total）
           │                    ↓
           ├─ cancel → cancelled
           │
           └─ ship（厂家）→ shipped
                            ↓
                       receive（warehouse 扫码）
                            ↓
                         received（存货入 ERP/mall 仓）
                            ↓
                         completed（票据归档）
```

### 原子动作表

| # | 动作 | 角色 | 端点 | 前置 | 副作用 | 通知 | 状态 |
|---|---|---|---|---|---|---|---|
| E6.1 | 建采购单 | purchase/warehouse/boss | `POST /api/purchase-orders` | **scope ∈ {liquor, store, mall} 必填** · target_warehouse_type 跟 scope 必须一致（liquor/store → erp_warehouse；mall → mall_warehouse）· 付款合计=total | PO + items | finance | 🟢 |
| E6.2 | **批准付款** | finance/boss | `POST /api/purchase-orders/{id}/approve` | status=pending · 账户足额 | 品牌现金/F 类/融资扣款 · status=paid | 供应商 | 🟢 |
| E6.3 | 驳回 | finance/boss | `POST /api/purchase-orders/{id}/reject` | status=pending | status=cancelled · 退款（未扣）| — | 🟢 |
| E6.4 | 撤销（已批准后）| boss/finance | `POST /api/purchase-orders/{id}/cancel` | status=paid/shipped · 未 receive | 退款回账户 | — | 🟢 |
| E6.5 | **收货**（ERP 仓 main/backup/tasting/store）| warehouse/boss/purchase | `POST /api/purchase-orders/{id}/receive` · target=erp_warehouse | status=paid/shipped · warehouse_id 合法 · **barcodes_by_item 必填** | Inventory +qty · StockFlow(inbound) · InventoryBarcode · **registry + events 同事务**（Phase B 三表合一） | — | 🟢 |
| E6.6 | **收货**（mall 仓）| warehouse/boss/purchase | 同上 · target=mall_warehouse | mall_warehouse_id 合法 · 每 item 有 MallProduct 映射 · barcodes_by_item 必填 | MallInventory +qty · 加权平均成本 · MallInventoryFlow(IN, ref_type=purchase) · MallInventoryBarcode · **registry + events 同事务** | — | 🟢 |
| ~~E6.7~~ | ~~扫码批量导入条码~~ | — | ~~`POST /api/inventory/barcodes/batch-import`~~ | — | **Phase B 已删除**（合并入 E6.5）| — | ✗ |

### E2E 测试状态：⏳ partial
- ✅ E6.1-6.5 ERP 仓路径 tested
- ❌ **E6.6 mall 仓路径没有端到端跑过**（mall 的 P0 阻塞项，详见 mall 文档流 8）

---

## 流 E7：客户 + 政策兑付

### 原子动作

| # | 动作 | 角色 | 端点 | 状态 |
|---|---|---|---|---|
| E7.1 | 客户 CRUD | salesman/sm_mgr/boss | `/api/customers` | 🟢 |
| E7.2 | 业务员**归属**绑定客户 | boss/sm_mgr | `PUT /api/customers/{id}/assign` | 🟢 |
| E7.3 | 客户 **信用额度** 管理 | boss/finance | `PUT /api/customers/{id}/credit-limit` | 🟢 |
| E7.4 | 客户订单历史 | salesman/boss/finance | `GET /api/customers/{id}/orders` | 🟢 |
| E7.5 | 客户应收挂账 | finance | `/api/customers/{id}/receivables` | 🟢 |

### E2E 测试状态：🟢 tested

---

## 流 E8：考勤 / 请假 / 报销 / 绩效 / KPI

### 原子动作

| # | 动作 | 角色 | 端点 | 状态 |
|---|---|---|---|---|
| E8.1 | 打卡（含地理围栏） | 员工 | `POST /api/attendance/checkin` | 🟢 |
| E8.2 | 拜访客户（进店/出店） | salesman | `POST /api/attendance/visits/enter\|leave` | 🟢 |
| E8.3 | 月度考勤 | 员工/hr | `GET /api/attendance/monthly-summary` | 🟢 |
| E8.4 | 请假申请 + 审批 | 员工/hr | `GET/POST /api/attendance/leave-requests` + `/approve\|reject` | 🟢 |
| E8.5 | 报销申请 + 审批 + 支付 | 员工/finance | `/api/expense-claims` | 🟢 |
| E8.6 | 销售目标 + 奖金档位（admin 配） | boss/hr | `/api/sales-targets` | 🟢 |
| E8.7 | 业务员看自己的 KPI | salesman | `GET /api/sales-targets/my-dashboard` | 🟢 |
| E8.8 | 考勤规则（地理围栏 + 时间段） | admin/hr | `/api/attendance/rules` | 🟢 |

### E2E 测试状态：🟢 tested

---

## 流 E9：账户 / 资金池 / 调拨

### 原子动作

| # | 动作 | 角色 | 端点 | 状态 |
|---|---|---|---|---|
| E9.1 | 账户 CRUD（master / 品牌现金 / F 类 / 融资）| boss/finance | `/api/accounts` | 🟢 |
| E9.2 | 账户余额查询 | finance/boss | `GET /api/accounts/summary` | 🟢 |
| E9.3 | 账户流水 | finance/boss | `GET /api/accounts/{id}/flows` | 🟢 |
| E9.4 | 资金调拨（master → 品牌）| boss/finance | `POST /api/accounts/transfer-internal` | 🟢 |
| E9.5 | 资金批准（transfer 要走审批）| boss | `POST /api/accounts/transfers/{id}/approve` | 🟢 |
| E9.6 | 融资到账 + 还款 | finance/boss | `/api/financing/*` | 🟢 |
| E9.7 | 支付单（付供应商 / F 类兑付等） | finance/boss | `/api/finance/payment-requests` | 🟢 |
| E9.8 | 财务审批中心 | finance/boss | `/api/approvals/finance` | 🟢（已加 mall 退货 tab） |

### E2E 测试状态：🟢 tested

---

## 流 E10：审批中心 / 通知 / 审计 / 品鉴仓

### 原子动作

| # | 动作 | 角色 | 端点 | 状态 |
|---|---|---|---|---|
| E10.1 | 审批中心聚合（政策 + 凭证 + 付款 + F 到账 + transfer + **商城待确认** + **商城退货**）| finance/boss | `GET /api/approvals/finance` | 🟢 |
| E10.2 | 通知列表 + 未读数 + 标已读 | 员工 | `/api/notifications` | 🟢 |
| E10.3 | 审计日志查询 + 导出 | boss/finance | `/api/audit-logs` | 🟢 |
| E10.4 | 登录日志（C 端）| admin/boss | `/api/mall/admin/login-logs` | 🟢 |
| E10.5 | 品鉴物料仓入库/出库/兑付 | manufacturer_staff/warehouse | `/api/tasting/*` | 🟢 |
| E10.6 | 绩效系数/奖金规则 | boss/hr | `/api/performance/*` | 🟢 |
| E10.7 | Dashboard（ERP）| 任何 | `/api/dashboard/*` | 🟢 |

### E2E 测试状态：🟢 tested

---

## ERP 整体评估

- ERP 核心闭环（E1 + E2 + E4 + E5 + E6 + E9）**已生产级稳定**
- 与 mall 强关联的 3 处：
  - **E4.1 Commission 生成**（mall 订单 completed → 走 commission_service.post_commission_for_order）→ 已对接
  - **E4.2 退货冲销**（mall approve_return → pending commission 标 reversed）→ 已对接但未回归
  - **E6.6 采购入 mall 仓**（P0 未端到端跑）→ **上线阻塞**

ERP 单独的 🔴 gap 极少；所有"进行中"的问题都在 **ERP ⇄ mall 连接点**，详见 `business-atoms-bridges.md`。
