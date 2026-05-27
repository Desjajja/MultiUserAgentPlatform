# 三种结算模式（跨模块共享概念）

每单必须选一种结算模式。**金额计算和提成发放完全依赖这个字段**，Agent 不要混。

## 三种模式定义

### `customer_pay` — 客户按指导价付

- 客户付：**指导价** × 数量
- 业务员负担：无
- 公司应收：**指导价**（`customer_paid_amount = total_amount`）
- `policy_gap`（政策差）= 0（没有差额）
- 提成基数：**指导价**
- 典型场景：客户按牌价拿货，不压价

### `employee_pay` — 业务员垫差额

- 客户付：**到手价**（deal_amount）
- 业务员垫：**指导价 - 到手价**（policy_gap）
- 公司应收：**指导价**（`customer_paid_amount = total_amount`）
- `policy_gap` > 0
- 提成基数：**指导价**
- 典型场景：业务员自己贴钱给客户优惠换销量
- **收款凭证要凑两笔**：客户付到手价的凭证 + 业务员补差额的凭证

### `company_pay` — 公司让利

- 客户付：**到手价**（deal_amount）
- 业务员负担：无
- 公司应收：**到手价**（`customer_paid_amount = deal_amount`）
- `policy_gap` > 0，等厂家政策兑付后进 F 类账户
- 提成基数：**到手价**（因为公司实际只收这么多）
- 典型场景：公司给客户让利，等厂家返政策

## 后端 preview 接口返回这些字段

```
{
  "total_amount": 27000.00,           // 指导价总额
  "deal_amount": 25500.00,            // 到手价总额
  "customer_paid_amount": 27000.00,   // 公司应收（随 mode 变）
  "policy_gap": 1500.00,              // 政策差
  "policy_receivable": 0 / 1500.00,   // 向厂家的政策应收（customer_pay=0，其他=policy_gap）
  "settlement_mode": "customer_pay"
}
```

Agent 展示给用户时**直接用这些字段**，不要自己算。

## 前端展示上"政策应收"逻辑

UI 上"政策应收"是**从公司角度看的未收款**：
- `customer_pay`：0（客户付全）
- `employee_pay`：0（差额是业务员给的，不是公司应收）
- `company_pay`：policy_gap（等厂家兑付）

## 提成计算

订单 `completed` 后，按提成基数 × 品牌提成率 生成 Commission 记录（`status=pending`，等工资单结算时发放）。

- 提成率来自 `employee_brand_positions.commission_rate`（员工本人品牌率），没有就用 `brand_salary_schemes.commission_rate`（品牌岗位默认率）
- 订单多次部分收款时，Commission 只在**首次 fully_paid** 时生成**一次**（幂等：按 order_id 查重）

### mall 订单 + 门店零售的提成口径

⚠️ **边界**：这一节描述的是 mall_orders / store_sales **两条独立链路的提成逻辑**，它们**不复用** ERP 主线 `receipt_service.py` 的 `comm_base = customer_paid_amount or total_amount` 计算路径。三条链路的提成代码各自独立、各自表：

| 来源 | 提成由谁触发 | 提成基数 | 提成率字段 |
|---|---|---|---|
| ERP 渠道/团购订单（orders） | `confirm-payment` 时（receipt_service.py:229） | `customer_paid_amount or total_amount` | employee_brand_positions / brand_salary_schemes |
| **mall_orders** | partial_closed → fully_paid 推进时（mall_service） | `received_amount` 实收 | brand 级提成率 |
| **store_sales（门店零售 B12）** | 收银 create_store_sale 时即生成 pending | `(sale_price - cost_price)` 利润 | retail_commission_rates.rate_on_profit（每员工×每商品独立配） |

- mall 订单 partial_closed 后补 top-up commission（按差额）
- Commission 表来源三选一：`order_id / mall_order_id / store_sale_id`（CHECK 约束保证恰一个非空）
- Agent 帮用户查提成时**先确认来自哪条链路**，三条的退货冲销逻辑也不一样

### 退货 / 冲销 / 跨月追回（决策 #1 · m6c1）

- 退货 approve 时 pending commission → `reversed`
- 退货 approve 时 settled commission（上月已发工资）→ 新建 `is_adjustment=True` 负数 commission（`status=pending`），下月工资单自动扫入扣回
- 工资不够扣 → `SalaryAdjustmentPending` 挂账下月扣（先进先扣）
- DB UNIQUE 兜底防双扣（m6c6 `uq_commission_adjustment_source`）

## Agent 提示用户时的说法

如果用户只说"建个单"没说模式，Agent **必须**先问清模式：

> "这单按哪种结算方式？（1）客户按指导价付 ¥27000；（2）客户按到手价 ¥25500 付，业务员补差 ¥1500；（3）客户按到手价 ¥25500 付，差额等厂家政策兑付"

不要默认为 `customer_pay`。
