# 工资 / 提成 / 厂家补贴

## 数据模型

```
Position                       岗位（salesman / sales_manager / admin / finance / hr / ...）
BrandSalaryScheme              品牌 × 岗位的薪酬方案（底薪/提成率/全勤奖/绩效工资）
EmployeeBrandPosition (EBP)    员工 × 品牌 × 岗位（一员工可在多品牌兼职，主属品牌决定底薪）
  - is_primary: bool           主属品牌 → 底薪从这里取
  - commission_rate            员工个性化提成率（覆盖方案默认）
  - manufacturer_subsidy       厂家补贴月额

SalaryRecord                   月度工资单（draft → pending_approval → approved → paid）
  └─ SalaryOrderLink           该月关联的订单（提成明细）
      唯一约束：(order_id, is_manager_share)
ManufacturerSalarySubsidy      厂家工资补贴（pending → advanced → reimbursed）

Commission                     单笔提成（订单 fully_paid 后生成，status=pending）
                               结算到 SalaryRecord 时 status=settled
AssessmentItem                 KPI 考核项（kpi_revenue / kpi_customers 等）
```

## 工资生成流程（月底）

```
1. 生成本月所有员工工资单
   POST /api/payroll/salary-records/generate
   → 每员工一条 SalaryRecord (status=draft)
   → 底薪按主属品牌 EBP 的 BrandSalaryScheme 取
   → 关联已 fully_paid 的订单 Commission（挂 SalaryOrderLink）
   → 算迟到扣款、全勤奖、绩效工资
   → 算 actual_pay

2. 人事逐条审查
   PUT /api/payroll/salary-records/{id}  # 调整明细（罚款/奖金）

3. 提交审批
   POST /api/payroll/salary-records/{id}/submit (status → pending_approval)
   或批量：POST /api/payroll/salary-records/batch-submit

4. 老板/财务审批
   POST /api/payroll/salary-records/{id}/approve (status → approved)

5. 财务发放
   POST /api/payroll/salary-records/{id}/pay      # 品牌现金账户扣款
   或批量：POST /api/payroll/salary-records/batch-pay
```

## Agent 场景 1：生成本月工资单

用户："生成 2026-04 工资单"

Agent:
1. 确认卡片："即将为 N 个员工生成 2026-04 工资单，按主属品牌算底薪，关联本月已全款订单的提成。确认？"
2. 调 `POST /api/payroll/salary-records/generate { "period": "2026-04" }`
3. 返回：
   ```json
   {
     "created": 15,       // 新建的
     "skipped": [{"employee_id": "...", "reason": "未设主属品牌"}]
   }
   ```
4. Agent 告诉用户"已生成 15 份，3 人跳过（详见 skipped 列表）"

## Agent 场景 2：看某员工工资单详情

```
GET /api/payroll/salary-records/{id}/detail
```

返回：底薪、全勤奖、罚款、各品牌提成明细、应发、实发。

Agent 给员工本人（用 `/me` 查自己），或 HR/boss 查任意员工。

## Agent 场景 3：改工资单（调整明细）

```
PUT /api/payroll/salary-records/{id}
{
  "fine_deduction": 200,        // 罚款
  "bonus_other": 500,           // 其他奖金
  "actual_pay": 8500             // 留空=系统算；填了=手动覆盖
}
```

HR 能改 draft / rejected 状态的。已 approved/paid 的拒绝改。

## Agent 场景 4：审批发放工资

**审批**（老板视角）：

```
POST /api/payroll/salary-records/{id}/approve
```

Agent 收到推送后展示摘要 + "批准 / 驳回"按钮。

**发放**（财务视角）：

```
POST /api/payroll/salary-records/{id}/pay
Body: { "account_id": "<品牌现金账户>" }
```

后端扣该品牌现金账户余额（如果不够会 400 提示要调拨）。

Agent 关键提醒："发放是钱从品牌现金账户出的，发放后不可逆；余额不足先做调拨。"

## Agent 场景 5：厂家工资补贴

厂家给员工的月度补贴（独立走政策应收，不进工资条）。

### 生成本月应收

```
POST /api/payroll/manufacturer-subsidies/generate-expected
{ "period": "2026-04", "brand_id": "..." }
```

按 EBP.manufacturer_subsidy × 在岗天数 / 月天数。

### 确认到账（厂家打款了）

```
POST /api/payroll/manufacturer-subsidies/confirm-arrival
{
  "brand_id": "...",
  "period": "2026-04",
  "arrived_total": 5000.00       // 厂家实际打款金额
}
```

**关键校验**：`arrived_total` 必须严格等于该品牌该期应收总额，否则 400。Agent 告诉用户"金额不符，需手工调整"。

后端：
- 找到所有 (brand, period, status=pending+advanced) 的补贴 → status=reimbursed
- 品牌现金账户 += arrived_total + 写 fund_flow
- 如果之前是 advanced（公司已垫付），返还公司

### 手工标记到账（金额不严格匹配时）

```
POST /api/payroll/manufacturer-subsidies/manual-mark-arrived
{ "subsidy_id": "...", "arrived_amount": 480 }
```

单条处理，有审计日志。Agent 仅在批量确认 400 后的兜底场景用，并且**明确强调**"手工标记不经过完整校验，请确认金额无误"。

## Agent 场景 6：提成结算

Order fully_paid 后自动生成 Commission（`status=pending`）。

**手动结算**（挂到某工资单）：

```
POST /api/hr/commissions/{id}/settle
{ "salary_record_id": "..." }
```

一般 `/salary-records/generate` 会自动做，Agent 很少手动操作。

**关键约束（Bug #3 修复）**：`SalaryOrderLink` 有 `(order_id, is_manager_share)` 唯一约束。并发生成工资单时第二个请求会 IntegrityError——Agent 遇到这个错误时**不要自动重试**，告诉用户"该订单提成已被其他工资单领取"。

### 提成来源三合一（B2B / mall / store）

`Commission` 可以挂三种订单，Agent 查明细时注意字段三选一非空：
- `Commission.order_id` → ERP B2B 订单
- `Commission.mall_order_id` → 小程序订单
- `Commission.store_sale_id` → 门店零售（桥 B12）

`SalaryOrderLink` 同样三选一（`ck_salary_order_link_exclusive_ref` CHECK 约束）。  
**工资单扫描 filter**（`generate_salary_records`）：
```sql
WHERE employee_id = ?
  AND (mall_order_id IS NOT NULL OR store_sale_id IS NOT NULL OR order_id IS NOT NULL)
  AND status = 'pending'
```
`reversed` 永远不会进工资单。`is_adjustment=True` 的负数行**是 pending 状态**，所以会被扫入抵扣。

## Agent 场景 6.1：跨月退货追回 + 挂账（决策 #1，m6c1）

### 机制

当退货 approve 时发现原 commission 已 `settled`（上月工资已发），系统：
1. **不动**原 commission（审计历史保留）
2. **新建** `Commission(is_adjustment=True, commission_amount=-原金额, status=pending)`
3. 下月 `generate_salary_records` 自动把这条负数扫入工资单 → 实扣

**工资仍不够扣的挂账**（`salary_adjustments_pending` 表）：
- 当月 `total_pay < 0` → `actual_pay=0` + 新建 `SalaryAdjustmentPending(pending_amount=-total_pay, source_salary_record_id=rec.id)`
- 下月 `generate_salary_records` 先扫挂账（先进先扣），扣完标 `settled_in_salary_id=新 rec.id`

### Agent 回答话术

**员工问："上月工资条写的 ¥5000 怎么实发只到 ¥4900？"**
1. 调 `GET /api/payroll/salary-records/{rec_id}/detail`
2. 看 `clawback_details[]` 数组：每条有 `origin_order_no / origin_amount / amount`（负数）
3. 翻译："你 3 月 X 号的订单 MO2026XXX 客户退货了，原 ¥100 提成上月已发，本月扣回"

**员工问："本月工资 ¥0 还挂账了？"**
- 看 `clawback_new_pending[]`：`pending_amount` + `reason`
- 翻译："本月退货冲销 ¥X 但工资不够扣，系统挂账到下月，下月发薪时自动扣"

**员工问："今年我被扣回多少？"**
- mall 业务员调 `/api/mall/workspace/my-commissions/stats?year=2026`
- 翻译："追回 commission 合计 ¥X，共 N 笔"

### 老板回答话术

**"为什么业务员 X 上月工资条比我预期的少？"**
- 确认是否有跨月退货：查 clawback_details
- 如果有待扣挂账：看 SalaryAdjustmentPending 表，admin/boss 可调 `/api/payroll/salary-records/{id}/detail`

### 幂等保证

- 同一 Commission 只能产生一条 adjustment（DB UNIQUE `uq_commission_adjustment_source` m6c6）
- `SalaryAdjustmentPending.settled_in_salary_id` 确保挂账只被扣一次

## Agent 场景 7：KPI 考核项

```
GET /api/payroll/assessment-items?employee_id=X&period=2026-04
```

返回员工本月 KPI 进度（回款额、客户数等）。Agent 用来回答"我本月业绩到哪了"。

### 刷新实际值

```
POST /api/performance/refresh-assessment-actual
{ "employee_id": "...", "period": "2026-04" }
```

按最新收款/订单重算 `actual_value`，同时**推销售目标里程碑通知**（50%/80%/100%/120%，已修复 bug #C）。

## 常见错误

| detail | 解释 |
|---|---|
| "未设置主属品牌，无法生成底薪" | EBP 没 is_primary=true 的 |
| "账户余额不足 ¥X，请先调拨" | 发工资时品牌现金不够 |
| "补贴金额不符：应收 ¥A，实际 ¥B" | confirm-arrival 金额严格校验 |
| "该订单提成已被其他工资单领取" | UniqueConstraint 冲突 |

## 工资单状态中文

| status | 中文 |
|---|---|
| draft | 草稿 |
| pending_approval | 待审批 |
| approved | 已审批 |
| paid | 已发放 |
| rejected | 已驳回 |

---

## AI Agent 调用 SOP（工资 / 提成 / 厂家补贴）

| 业务动作 | 端点 / operation | 风险等级 | Agent 调用方式 |
|---|---|---|---|
| 查工资单列表 | `GET /api/payroll/salary-records` | L0 | 直调 |
| 生成月度工资单（draft） | `POST /api/payroll/salary-records/generate` | L1 | 直调（落 `pending_approval`，不动账） |
| 提交工资单审批 | `POST /api/payroll/salary-records/{id}/submit` | L1 | 直调 |
| 审批工资单（approved） | `POST /api/payroll/salary-records/{id}/approve` | L1 | 直调（推荐 Gateway） |
| **批量发工资（动账）** | `payroll.batch_pay_salary` | **L2 不可逆** | **drafts 两阶段强制**。单批 > 20 人直接 400，必须拆批 |
| 单条发工资 | `POST /api/payroll/salary-records/{id}/pay` | **L2 不可逆** | 建议 drafts；至少必须走 Gateway dryRun + token |
| 工资单重算 | `POST /api/payroll/salary-records/{id}/recompute` | L1 | 直调（仅刷 commission/subsidy 引用） |
| **确认厂家补贴到账** | `payroll.confirm_subsidy_arrival` | **L2** | **Gateway dryRun + token**（动品牌现金 + 改 N 条 subsidy 状态） |
| 配置 KPI 系数规则 | `POST /api/payroll/kpi-coefficient-rules` | L1 | 直调 |
| 查我的提成流水（业务员自查） | `GET /api/mall/workspace/my-commissions` | L0 | 直调（mall workspace 入口，按本人过滤） |

**关键交互模板**（批量发工资，对应剧本场景 12）：

```
# 拆批：每批 ≤ 20 人，每批一个 draft + 一个 token
for batch in chunks(employee_ids, size=20):
    draft = drafts.create  payload={
        action: "payroll.batch_pay",
        payload: { period: "2026-04", employee_ids: batch }
    }
    # 卡片预览 → /api/confirm-tokens(action=drafts.commit, draft_id)
    drafts.commit  payload={draft_id} + X-User-Confirm: <token>
```

**批量上限触发的 400**：
```json
{ "detail": "批量发放单批不能超过 20 人，请拆分" }
```
Agent 收到后**自动**按 20 拆批，每批一个独立 draft + 独立 token，**不要把同一 token 用于多个 draft**。

**厂家补贴到账**（场景 18）：先查 pending subsidy 合计金额是否等于实到金额；不相等 → 直接告诉用户金额不符，不进入 dryRun。

详见 `ai-gateway.md` §5、剧本场景 12 / 18、`business-rules.md` §九。

