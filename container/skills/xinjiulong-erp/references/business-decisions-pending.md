# 跨月退货 & 提成追溯 — 业务逻辑参考

本文给 openclaw 智能体在飞书对话中回答"退货了业务员的钱怎么办"、"跨月的单子退了要追回吗"类问题用。
内容是系统的**当前行为 + 未决策的边界场景**，不是执行 TODO。

---

## 现有行为（已上线，定稿）

### Commission 生命周期

```
created(pending) ──月结生成工资单──→ settled(已发工资)
   │
   └──客户申请退货 + admin approve──→ reversed（同一条记录 status 变）
```

**关键字段**：
- `commissions.status` ∈ {`pending`, `settled`, `reversed`}
- `commissions.settled_at` — 仅 status=settled 时填
- `commissions.mall_order_id` — 区分 mall / B2B 来源
- `mall_orders.status`: `completed` → `refunded`（退货 approve 后）

### 退货对 Commission 的影响

| 场景 | 现在行为 | 代码位置 |
|---|---|---|
| commission.status=pending → 退货批准 | status → reversed | `return_service.approve_return:162` |
| commission.status=settled → 退货批准 | status **不变**，只加审计 notes | `return_service.approve_return:167`（注释说明"已 settled 不动"）|

### 退货对 KPI / 利润台账的影响

| 聚合维度 | 时间口径 | partial_closed 处理 | refunded 处理 |
|---|---|---|---|
| `profit_service.aggregate_mall_profit` | delivered_at（partial_closed）/ completed_at（completed）| 纳入，扣 bad_debt | **排除**（`status in [completed, partial_closed]`）|
| 业务员 `stats` 页本月 GMV | 同上 | 纳入 | 排除 |
| admin dashboard 商品/业务员排行 | 同上 | 纳入 | 排除 |

**排除 refunded 意味着**：C 端退款后，上月业务员 KPI 统计里那笔单子**已经算过**；本月不再显示，但**上月历史视图**依然保留（因为报表接口按时间窗口查）。

### 工资单扫描规则

`payroll.generate_salary_records` 扫 Commission 的 filter：
```sql
WHERE Commission.employee_id = ?
  AND Commission.mall_order_id IS NOT NULL
  AND Commission.status = 'pending'
```

所以 `reversed` commission **永远进不了任何月份的工资单** —— 这一层逻辑已经闭环。

---

## 未决策的边界场景

这两个是唯一让 mall 团队还没敢拍板的问题。回答老板时需要先问清楚他的**业务预期**再给方案。

### 场景 A：本月订单 completed → 下月退货批准 ✅ 已决策（方案 2+B）

**老板决定**：跨月退货的提成必须追回；工资不足扣时挂账下月扣。

**实现（migration m6c1）**：
- `commissions` 加 `is_adjustment` + `adjustment_source_commission_id` 两字段
- approve_return（mall + 门店双端）逻辑改：
  - pending → reversed（原逻辑）
  - settled → **建一条负数 Commission**（is_adjustment=True, status=pending, amount=-original, source=original.id）
  - 幂等：同一 Commission 只能产生一条 adjustment
- 下月 payroll.generate_salary_records 自然扫入负数 commission（原 filter `status='pending'` 涵盖）
- 新表 `salary_adjustments_pending` 挂账：
  - 当月 total_pay 扣完所有 commission（含负数）仍 < 0 → 实发 0 + 挂账 shortage
  - 下月生成工资单时优先扣历史挂账（按 created_at 先进先扣）
  - 扣完 settled_in_salary_id 标上，未扣完保留 pending_amount - deduction

**E2E**: `scripts/e2e_cross_month_commission_clawback.py` 覆盖完整链路

### 场景 B：业务员 KPI / 排行榜对已退货订单的追溯 ✅ 已决策（快照 + 实时双模式）

**老板决定**：方案 1 + 2 合并 —— 月初冻结快照（发奖金定格），前端同时提供实时查询让运营看趋势。

**实现（migration m6c4）**：
- 新表 `mall_monthly_kpi_snapshot`（employee_id + period UNIQUE）
- APScheduler 月初 1 号 00:05 自动跑 `kpi_snapshot_service.job_build_last_month_snapshot` 冻结上月
- 端点 `GET /api/mall/admin/dashboard/salesman-ranking?mode=snapshot|realtime&year_month=YYYY-MM`
  - `realtime`：按当前 DB 数据实时聚合（refunded 排除，每次查会变）
  - `snapshot`：查快照表（冻结一次不动，老板发奖金后看这里）
- 端点 `POST /api/mall/admin/dashboard/salesman-ranking/build-snapshot?year_month=YYYY-MM`（admin/boss 手工回补）
- 幂等：重复跑同月会 UPSERT 而非建新行

**E2E**：`scripts/e2e_kpi_snapshot.py` 覆盖冻结 → 退货 → 实时 vs 快照双模式差异 → UPSERT 幂等

### 场景 D：门店散客（无会员账号）收银 ✅ 已决策（方案：支持）

**老板决定**：C 端没注册会员的客户也要能在门店买酒。提成、利润、条码管理不受影响。

**实现（migration m6c2）**：
- `store_sales.customer_id` 改 nullable；加 `customer_walk_in_name(100)` + `customer_walk_in_phone(20)` 两列（选填快照，营销用）
- `store_sale_returns.customer_id` 同步 nullable（散客退货原单 customer_id 就是 NULL）
- 服务/API 层允许 customer_id=None；小程序收银页加 **会员/散客** 两个模式 Toggle
- Commission、Inventory、条码、利润台账不依赖 customer_id，散客场景全部走通
- 散客姓名/手机号**不强制**，可完全匿名（`散客 ****1234` 或直接显示"散客"）

**E2E**：`scripts/e2e_store_walk_in.py` 覆盖 散客下单 + 纯匿名 + 散客退货

### 场景 C：商品销量 `MallProduct.total_sales` 是否回退 ✅ 已决策（双字段）

**老板决定**：total 和 net 都要有 —— 首页榜单看 net，历史报表看 total。

**实现（migration m6c3）**：
- `mall_products` 新增 `net_sales` 列（历史数据初始化 = total_sales）
- confirm_payment / partial_close 时 total_sales + net_sales 都 +
- approve_return 时只扣 net_sales（`max(0, net_sales - qty)`，不回退 total_sales）
- 首页榜单 `/api/mall/products?sort=hot` + `/api/mall/search/products` 按 `net_sales desc` 排序
- 管理后台 ProductList 销量列"总/净"双显（净 < 总时标红提示有退货）
- schema 返回 `soldNum`（原）+ `netSoldNum`（新，前端可选）

**E2E**：`scripts/e2e_mall_product_net_sales.py` 覆盖单调递增/扣减/保底 0/再下单

---

## 给智能体的回答模板

**用户问：业务员退货的提成要扣吗？**

> 看订单状态：
> - 如果客户**本月下单本月退货**，业务员的提成还在 pending 阶段，系统会自动 reversed，业务员最终拿不到。
> - 如果客户**跨月退货**（上月订单本月退），业务员的提成上月已经 settled 进工资单，现在系统保留不动 —— 公司承担损失。
> 这个跨月场景老板如果想追溯扣回，需要走工资单"提成调整项"人工操作，或者找开发加一个负数 commission 自动机制（工期 1-2 小时）。

**用户问：为什么上月排行榜的 GMV 变了？**

> 因为退货订单 status 会从 completed 变 refunded，排行榜是实时查的，refunded 被过滤掉了。如果希望排行榜数据发出去就别变，可以加一个月初快照表。

**用户问：某业务员本月退了多少单？**

> 走 MallReturnRequest 表查询：`status='approved' AND reviewed_at >= 月初` + 关联 MallOrder 查 assigned_salesman_id。这不是现成端点，但 MCP `query_mall_returns` 或 SQL 可以直接跑。

---

## 版本历史

- 2026-05-03 首版：列出现行逻辑 + 2 个未决场景 + 1 个相关疑点（销量不回退）
