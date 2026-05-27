# 关键字段语义精确定义

**为什么要写这个**：同一个字段名在不同结算模式下值不同，不搞清楚写代码必错。Agent 读用户自然语言时也要精确知道用户在问哪个字段。

---

## Order（订单）核心金额字段

### 三种结算模式（`Order.settlement_mode`）

| 模式 | 客户实付 | 业务员垫付 | 公司应收 | 提成基数 | 典型场景 |
|---|---|---|---|---|---|
| `customer_pay` | 指导价 | 不需要 | 指导价（高） | 指导价 | 客户不砍价，全额付 |
| `employee_pay` | 到手价 | 差额（业务员掏） | 指导价（高） | 指导价 | 业务员给客户让利后自己补差 |
| `company_pay` | 到手价 | 不需要 | 到手价（低） | 到手价 | 公司主动让利，老板批准 |

### 订单的金额字段对照表

| 字段 | 含义 | customer_pay | employee_pay | company_pay |
|---|---|---|---|---|
| `Order.unit_price` | 指导价 | 900 | 900 | 900 |
| `Order.deal_unit_price` | 到手价（实际销售价） | 900（= 指导价） | 650 | 650 |
| `Order.total_amount` | 指导价总额（= unit_price × cases） | 27,000 | 27,000 | 27,000 |
| `Order.deal_amount` | 到手价总额 | 27,000 | 19,500 | 19,500 |
| `Order.customer_paid_amount` | **公司应收**（客户付的金额） | 27,000 | 19,500 | 19,500 |
| `Order.employee_advance_amount` | 业务员垫付额 | 0 | 7,500 | 0 |
| `Order.policy_value` | 政策总价值 | 2,000 | 2,000 | 2,000 |
| `Order.policy_gap` | 政策差 = total - deal - policy_value | 0 | 5,500 | 5,500 |

**⚠️ 核心陷阱**：
- `customer_paid_amount` **不是**"客户已付款金额"，是**"客户应付总额"**（也是公司应收）
- `total_amount` 永远是指导价合计，**不是**"客户该付的钱"
- 判全款：`SUM(confirmed Receipt.amount) >= order.customer_paid_amount`（**不要用 total_amount**）

### 提成计算

```
Commission.commission_amount = comm_base × commission_rate × kpi_coefficient
```

- `comm_base` = `Order.customer_paid_amount or Order.total_amount`（**公司实收基数**）
  - customer_pay: 27,000
  - employee_pay: 19,500（**注意**：提成按"公司实际收到的钱"即 deal_amount，不按指导价）
  - company_pay: 19,500

  ⚠️ **当前代码行为**：`customer_paid_amount or total_amount`——这里有个业务决策：
  - customer_pay → 27,000（全额）
  - employee_pay → 19,500（客户付的）——但指导价 27,000 其实才是公司应收……
  - company_pay → 19,500（应收就是这个）

  历史文档写"提成基数 = 公司应收 = 指导价/到手价"，**跟代码有偏差**。读具体业务需求时要确认。

- `commission_rate` 取值顺序：
  1. `EmployeeBrandPosition.commission_rate`（个性化，null 则看下一级）
  2. `BrandSalaryScheme.commission_rate`（品牌×岗位默认）
  3. 0（都没配）

- `kpi_coefficient` 由 `kpi_coefficient_rules` 表按员工回款完成率查：
  - `fixed` 模式：系数 = 区间配置的 fixed_value
  - `linear` 模式：系数 = 完成率本身
  - 查不到规则：兜底 1.0（保守不少发）

---

## Receipt（收款凭证）

| 字段 | 含义 | 关键规则 |
|---|---|---|
| `Receipt.amount` | 本次收款金额 | > 0；**不是**订单应收 |
| `Receipt.status` | 审批状态 | 三态：`pending_confirmation` / `confirmed` / `rejected` |
| `Receipt.account_id` | 收款进哪个账户 | 业务员上传时=None（看不到 master），财务审批时填 master |
| `Receipt.receipt_date` | 收款日期 | **业务员上传时写 `today`**，不是审批时间 |
| `Receipt.confirmed_at` | 财务确认时间 | status → confirmed 时填 |
| `Receipt.source_type` | 来源类型 | `customer`（默认）/ `employee_advance`（业务员补款）；`company_advance` 文档声明保留但代码无强分流（model 默认 `customer`，路由仅 orders.py:1216 注释了前两种）。**不要传 `policy_f`** —— 代码不识别，会被忽略 |

**铁律**：所有 `SUM(Receipt.amount)` 聚合必须过滤 `status='confirmed'`（否则 pending/rejected 被算进去，业务员能刷绩效，误触发 Commission 生成）。

---

## Account（账户）的 5 种类型

### 按 `account_type`

代码事实（accounts.py:372 强校验）：`account_type ∈ {cash, f_class, financing, payment_to_mfr}` 四值。**master 不是 type，是 level**。

| type | 中文 | 作用 | 钱进来 | 钱出去 |
|---|---|---|---|---|
| `cash` | 现金账户 | 付工资/付政策垫付/付稽查回收（按 `level` 区分品牌现金 vs master 现金池） | 调拨进来 / 厂家补贴到账 / **master 收所有客户回款** | 发工资 / 付款 / 调拨给品牌 |
| `f_class` | F 类账户 | 接厂家政策兑付款 | 政策到账 | 调拨给品牌现金 |
| `financing` | 融资账户 | 融资本金 | 融资放款 | 还款 |
| `payment_to_mfr` | 应付给厂家 | 采购付款记账 | 采购付款 / inflow_transfer | 撤销采购 / outflow_transfer |

**master 现金池查询**：`level='master' AND account_type='cash'`（finance.py:230-234；没配会 400 阻断收款入账）。

### 按 `level`
- `master`：公司级（没有 brand_id；`select().where(level='master')` 查它）—— 实际只有 `account_type='cash'` 一条
- `project`：品牌级（有 brand_id）

⚠️ **RLS 限制**：salesman 角色看不到 `level='master'` 的账户（避免泄露公司总资金）。

---

## PolicyRequestItem（政策申请明细）核心金额

| 字段 | 含义 | 用途 |
|---|---|---|
| `standard_total` | 政策规定标准值 | 模板上写的"这种政策该给客户多少钱的礼" |
| `total_value` | 实际开给客户的价值 | 可能低于 standard_total（业务员少给）或高（超发） |
| `actual_cost` | 实际花费 | submit-voucher 时填，比如礼品市价 |
| `arrival_amount` | 厂家到账金额 | confirm-arrival 时写；可能≠standard_total（厂家打折） |
| `settled_amount` | 已核销金额 | confirm-settlement-allocation 时按厂家结算分配累计；不是 confirm-fulfill 写入 |
| `profit_loss` | 盈亏 | `standard_total - total_value - actual_cost`（正=赚，负=亏） |

**铁律**：
- `settled_amount` 只表示厂家结算核销进度，**不要**和兑付归档状态混用
- `confirm_arrival` 对已写 `arrival_at` 的 item 直接跳过（幂等）

---

## 库存数量单位

**字段 `quantity_unit`**：值域 `"箱" / "瓶"`

**单位换算**：`Product.bottles_per_case` 定义一箱多少瓶。

**铁律**：
- 存 `Inventory.quantity` **统一用"瓶"**（不管入库时用什么单位）
- 入库/出库时：`箱 × bottles_per_case = 瓶`
- 成本价 `cost_price` **统一用"瓶"的价格**（箱单价 ÷ bottles_per_case）
- 展示给用户时按 `quantity_unit` 显示

---

## Customer 的结算方式（`settlement_mode`）

| 值 | 中文 | 含义 |
|---|---|---|
| `cash` | 现结 | 下单即付款 |
| `credit` | 赊销 | 有账期 `credit_days`（默认 30 天） |

**赊销客户**会生成 `Receivable` 记录跟踪应收账款，每次 Receipt confirmed 时分摊。

---

## Employee 的主属品牌（EmployeeBrandPosition）

| 字段 | 含义 | 铁律 |
|---|---|---|
| `is_primary` | 主属品牌标记 | 每个员工**必须有且仅有 1 条 `is_primary=true`**（否则工资生成报错"未设主属品牌"） |
| `commission_rate` | 个性化提成率 | null 则回落到 `BrandSalaryScheme` 默认 |
| `manufacturer_subsidy` | 厂家月补贴额 | 按在岗天数折算 |
| `position_code` | 岗位 | `salesman` / `sales_manager` / `admin` / `finance` / `hr` / 等 |

**底薪来源**：主属品牌 × 岗位的 `BrandSalaryScheme.fixed_salary + variable_salary_max × 考核完成率`。

---

## InspectionCase 5 种类型

`case_type` + `direction` 决定业务逻辑和公式：

| case_type | direction | 中文 | profit_loss 公式 |
|---|---|---|---|
| `outflow_malicious` | outflow | A1 恶意外流 | `-(purchase_price - deal_price) × bottles - penalty` |
| `outflow_nonmalicious` | outflow | A2 非恶意外流 | `(sale_price - purchase_price) × bottles - penalty` |
| `outflow_transfer` | outflow | A3 被转码 | `-penalty` |
| `inflow_resell` | inflow | B1 回售入库 | `(resell_price - purchase_price) × bottles + reward` |
| `inflow_transfer` | inflow | B2 转码入库 | `(sale_price - purchase_price) × bottles + reward` |

**字段语义**：
- `purchase_price`：回收价（A 系列）或买入价（B 系列）
- `deal_unit_price`：原本卖客户的到手价
- `original_sale_price`：指导价（从源订单带出）
- `resell_price`：B1 回售出去的价格
- `transfer_amount`：A3 被转码抵扣的回款金额

---

## 利润台账 11 科目（dashboard/profit-summary）

| # | 科目 | 方向 | 数据源 | 过滤条件 |
|---|---|---|---|---|
| 1 | 订单销售利润 | 收入 | `(sell_price - cost) × qty` | StockOutAllocation JOIN Order（已出库） |
| 2 | 政策兑付盈利 | 收入 | `SUM(PolicyRequestItem.profit_loss > 0)` | 创建时间内 |
| 3 | 稽查清理盈利 | 收入 | `SUM(InspectionCase.profit_loss > 0)` | status in (executed, closed) + closed_at 范围 |
| 4 | F类到账差额 | 收入 | `SUM(arrival_amount - actual_cost)` | 历史 `PolicyRequest.request_source='f_class'` + 新 `ExpenseClaim.claim_type='f_class'` |
| 5 | 回款返利 | 收入 | 手动（暂 0） | - |
| 6 | 报销费用 | 支出 | `SUM(Expense.amount)` | status='paid' |
| 7 | 政策兑付亏损 | 支出 | `SUM(\|profit_loss\|)` where `profit_loss < 0` | - |
| 8 | 稽查外流亏损 | 支出 | `SUM(\|profit_loss\|)` where `profit_loss < 0` | status in (executed, closed) |
| 9 | 融资利息 | 支出 | `SUM(FinancingRepayment.interest_amount)` | status='approved' |
| 10 | 分货差价 | 支出 | 手动（暂 0） | - |
| 11 | 人力成本净额 | 支出 | `SUM(actual_pay + social_security) + 公司社保 - 厂家补贴实际回款` | - |

**仅按品牌聚合时**额外 where `brand_id=X`；未筛品牌按全部。

---

## 审批流的金额流向

### 订单闭环（完整链路）
```
建单（customer_paid_amount 写入）
  → 政策审批
  → 出库（扣库存，不动账户）
  → 送达
  → 业务员上传凭证 N 次（Receipt status=pending_confirmation，不动账）
  → 财务审批中心点"确认收款"
      → 每笔 Receipt.amount 进 master 现金池（level='master' AND account_type='cash'）+ 写 fund_flow
      → Receipt.status → confirmed
      → Receivable.paid_amount 按比例分摊
  → 累计 confirmed 金额 ≥ customer_paid_amount 时：
      → Order.payment_status = fully_paid
      → Order.status = completed
      → 生成 Commission（pending）
      → 刷新 KPI / 推里程碑
```

### 政策兑付（完整链路）
```
建政策申请（PolicyRequest + PolicyRequestItem）
  → fulfill-materials（出库物料 → 扣库存，更新 fulfilled_qty）
  → submit-voucher（写 actual_cost + 算 profit_loss）
  → confirm-fulfill（只做兑付归档，不改 settled_amount）
  → 如果 advance_payer=employee → 自动生成 PaymentRequest（给业务员返垫付）
  → 厂家到账主录入：ManufacturerSettlement（品牌 F 类主账入账）
  → confirm-arrival（补记政策项 arrival 字段；历史 F 类条目仍在这里进 F 类）
```

---

## 常见的"看起来同名实际不同"的字段对比

| 字段 A | 字段 B | 区别 |
|---|---|---|
| `Order.total_amount` | `Order.customer_paid_amount` | A=指导价总额（不变）；B=公司应收（按模式变） |
| `Receipt.amount` | `Receivable.amount` | A=单笔收款；B=整单应收（欠款） |
| `Receipt.receipt_date` | `Receipt.confirmed_at` | A=业务员上传当天；B=财务批准时间 |
| `PolicyRequestItem.settled_amount` | `PolicyRequestItem.arrival_amount` | A=厂家结算已核销金额；B=厂家到账金额（可能不同） |
| `SalaryRecord.total_pay` | `SalaryRecord.actual_pay` | A=应发（扣个人社保后）；B=实发（一般=total_pay，HR 可手改） |
| `Inventory.quantity` | `PurchaseOrderItem.quantity` | A=瓶（统一）；B=按 quantity_unit（箱/瓶） |

**Agent 跟用户对话时的默认语义**：
- 用户说"订单多少钱" → 默认给 `customer_paid_amount`（公司应收）
- 用户说"这单该付多少" → 给 `customer_paid_amount`
- 用户说"这单欠多少" → `customer_paid_amount - SUM(confirmed Receipt.amount)`
- 用户说"这单已收多少" → `SUM(confirmed Receipt.amount)`（绝对不含 pending）

---

## 2026 Q2 新增字段

### Commission 追回字段（决策 #1，m6c1）

| 字段 | 语义 |
|---|---|
| `commissions.is_adjustment` | 布尔；True = 跨月退货追回的负数 commission 行 |
| `commissions.adjustment_source_commission_id` | 指向原 settled commission；partial UNIQUE `WHERE is_adjustment=true`（m6c6） |
| `commissions.store_sale_id` | 新增；门店零售的 commission 来源三选一（order_id / mall_order_id / store_sale_id） |

### SalaryAdjustmentPending（决策 #1，m6c1）

| 字段 | 语义 |
|---|---|
| `employee_id` | 欠扣员工 |
| `pending_amount` | 欠扣金额（正数；CHECK > 0） |
| `source_salary_record_id` | 产生挂账的源工资单（当月工资不足） |
| `settled_in_salary_id` | 扣清挂账的目标工资单（NULL=未结清） |
| `settled_at` | 扣清时间 |
| `reason` | 挂账原因（如 "2026-05 当月工资不足扣减" 或 "跨月退货追回"） |

**Agent 读取入口**：`GET /api/payroll/salary-records/{id}/detail` 的 `clawback_new_pending[]`

### MallMonthlyKpiSnapshot（决策 #2，m6c4）

| 字段 | 语义 |
|---|---|
| `employee_id` | 业务员对应 employees.id |
| `period` | `YYYY-MM` |
| `gmv / order_count / commission_amount` | 冻结值 |
| `snapshot_at` | 冻结时间（冻结后不再改） |
| UNIQUE(employee_id, period) | 每员工每月最多一条 |

**Agent 读法**：调 `GET /api/mall/admin/dashboard/salesman-ranking?mode=snapshot` 透明封装

### StoreSale walk-in 字段（决策 #3，m6c2）

| 字段 | 语义 |
|---|---|
| `store_sales.customer_id` | 改 **nullable**：散客场景为 NULL |
| `store_sales.customer_walk_in_name` | String(100)，散客姓名（选填） |
| `store_sales.customer_walk_in_phone` | String(20)，散客手机号（选填） |
| `store_sale_returns.customer_id` | 同步 nullable（散客原单退货） |

**展示口径**：
- `customer_id` 非空 → 查 MallUser 取 nickname/real_name
- `customer_id` NULL + `walk_in_name` 非空 → "散客·张三"
- `customer_id` NULL + 只有 `walk_in_phone` → "散客·尾号1234"
- 都 NULL → "散客"

### MallProduct.net_sales（决策 #4，m6c3）

| 字段 | 语义 |
|---|---|
| `mall_products.total_sales` | 累计售卖瓶数（不回退，审计口径） |
| `mall_products.net_sales` | 净销量（退货时扣，保底 0，榜单口径） |

**写入点**：
- confirm_payment / partial_close：total_sales += qty；net_sales += qty
- approve_return：net_sales = max(0, net_sales - qty)；total_sales 不动

### audit_logs FK（G1/G2/G8，m6c5 硬化）

| 字段 | 语义 |
|---|---|
| `audit_logs.actor_id` | 原员工 id；FK `ON DELETE SET NULL`（员工离职后审计记录保留不丢失） |
| `audit_logs.mall_user_id` | 原 mall_user id；同上 SET NULL |
| `audit_logs.actor_type` | `employee` / `mall_user` |

### 审计 action 值清单（常用）

| action | 触发点 |
|---|---|
| `store_sale.create` | 店员小程序收银 |
| `store_sale.create_by_admin` | 管理端代下 |
| `store_return.apply/approve/reject` | 门店退货三状态 |
| `mall_return.apply/approve/reject/mark_refunded` | mall 退货四状态 |
| `mall_customer.reveal_phone` | 业务员点拨号查客户手机号（G16） |
| `mall_salesman.disable/enable/rebind-employee` | 业务员管理 |
| `retail_commission_rate.create/update/delete` | 提成率维护 |


---

## JWT payload 字段（auth.py:build_jwt_payload）

每个员工登录后拿到的 JWT 里 7 个权限字段，决定 RLS 怎么过滤：

| 字段 | 含义 | 怎么算（auth.py 实现） |
|---|---|---|
| `sub` | User.id | |
| `username` | 登录名 | |
| `employee_id` | 关联 employees.id | 可空（admin 系统账号没绑员工）|
| `roles` | 角色 code 列表 | user_roles JOIN roles |
| `brand_ids` | 可见品牌 id 列表 | admin/boss/finance/hr → 所有 brand；其他 → `employee_brand_positions.brand_id` 聚合 |
| `store_ids` | 可见门店仓 id 列表（m6cx 起）| admin/boss/finance/hr → 所有 `warehouse_type='store'`；其他 → `employee_store_assignments.warehouse_id` 聚合 |
| `is_admin` | 角色含 admin/boss | |
| `can_see_master` | 同 is_admin | 决定 accounts 表 master 行是否可见 |

**关键铁律**：JWT 字段一旦写到 token 里就**不会动态更新**。HR 改员工绑定 brand / store 后，员工必须**重新登录**才能拿到新 brand_ids / store_ids。

业务员的 brand_ids 命中 → 看本品牌 orders/customers/policy_requests/...；store_ids 命中 → 看那家门店的 inventory + store_sales 流水。两套权限独立，互不依赖。
