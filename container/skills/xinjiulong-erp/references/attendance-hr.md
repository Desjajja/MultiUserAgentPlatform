# 考勤 / 请假 / 拜访 / 员工 / KPI

## 考勤数据模型

```
AttendanceRule            打卡规则（上下班时间、地点 geofence、迟到容忍）
AttendanceRecord          打卡记录（每人每天 1-2 条：上班/下班）
CustomerVisit             客户拜访（进店-出店）
LeaveRequest              请假申请
Employee                  员工
KPI                       考核项定义（revenue、customers、visits）
```

## Agent 场景 1：打卡

**不要 Agent 代打**！打卡必须员工本人在现场（geo-fence 校验），Agent 不能帮忙打卡。

Agent 仅引导用户："打卡需在公司定位范围内，打开飞书移动端『打卡』小程序自行操作"。

查打卡记录：

```
GET /api/attendance/checkin?employee_id=X&date_from=2026-04-01&date_to=2026-04-30
```

## Agent 场景 2：客户拜访

业务员到客户店里打卡进店，离开时打卡出店。

### 进店

```
POST /api/attendance/visits/enter
{
  "customer_id": "...",
  "location": {"lat": 30.x, "lng": 104.x},
  "photo_url": "...",          // 店面照片
  "notes": "谈下周订货"
}
```

Agent 不代操作（要现场 GPS），但可以查：

```
GET /api/attendance/visits?employee_id=X&date_from=...
```

"李四本月已拜访 23 家客户"。

### 出店

```
POST /api/attendance/visits/leave
{
  "visit_id": "...",
  "location": {"lat": ..., "lng": ...},
  "result": "达成意向 10 箱",
  "voucher_urls": ["..."]
}
```

## Agent 场景 3：请假

### 建请假

```
POST /api/attendance/leave-requests
{
  "employee_id": "<员工 id 或名字解析>",
  "leave_type": "sick",          // sick / annual / personal / marriage / maternity
  "start_date": "2026-04-27",
  "end_date": "2026-04-29",
  "days": 3,
  "reason": "感冒发烧",
  "voucher_urls": ["<医院证明图>"]
}
```

**Agent 引导业务员请假**：
1. 用户："我 4/27~4/29 病假"
2. Agent 推 Form 卡片让填 leave_type / reason / 是否有证明图片
3. 用户填完 + 可能上传图片
4. Agent 预览卡片："你要请病假 3 天 (2026-04-27 ~ 2026-04-29)，理由：感冒。确认提交？"
5. 确认后调接口
6. Agent 告诉用户"已提交请假申请，等 HR/领导审批"

### 审批

```
POST /api/attendance/leave-requests/{id}/approve
{ "action": "approve" | "reject", "reason": "（驳回时填）" }
```

**权限**：hr（一般假），boss（超 5 天或敏感假）。

### 查请假

```
GET /api/attendance/leave-requests?employee_id=X&status=pending
```

## Agent 场景 4：月度考勤汇总

```
GET /api/attendance/monthly-summary?employee_id=X&period=2026-04
```

返回：出勤天数 / 迟到次数 / 早退次数 / 请假天数 / 客户拜访次数。

Agent 用于回答业务员"我本月出勤怎么样"或 HR 月底对数据。

## Agent 场景 5：员工档案

### 查员工

```
GET /api/hr/employees?keyword=李四&status=active
GET /api/hr/employees/{id}
```

返回：姓名、手机、岗位、主属品牌、入职日期、月薪。

### 建员工（HR 操作）

```
POST /api/hr/employees
{
  "name": "王五",
  "phone": "138xxx",
  "id_number": "身份证",
  "join_date": "2026-04-01",
  "status": "active"
}
```

建完后 HR 还要：
1. 创建对应用户账号 `POST /api/auth/users`
2. 建 EmployeeBrandPosition `POST /api/payroll/employees/{id}/brand-positions`（主属品牌）
3. 可能建 CBS 把他归到某些客户上

Agent 不代替 HR 建员工（涉及身份证等敏感信息），只引导 HR 去网页端操作。

### 查员工绑定的品牌/岗位

```
GET /api/payroll/employees/{id}/brand-positions
```

返回该员工在各品牌的岗位，主属品牌 `is_primary=true`。

## Agent 场景 6：KPI 定义和进度

### 查本月 KPI 考核项

```
GET /api/payroll/assessment-items?employee_id=X&period=2026-04
```

返回：
```json
[
  {
    "id": "...",
    "metric_key": "revenue",          // 回款额
    "target_value": 100000,
    "actual_value": 87500,
    "weight": 0.6,
    "completion_rate": 0.875
  },
  {
    "metric_key": "new_customers",
    "target_value": 5,
    "actual_value": 3,
    ...
  }
]
```

Agent 给业务员看"我本月业绩到哪了"。

### 刷新实际值

```
POST /api/performance/refresh-assessment-actual
{ "employee_id": "...", "period": "2026-04" }
```

**后端**：
- 按最新订单/收款数据重算 actual_value
- 推送销售目标里程碑通知（50%/80%/100%/120%）

Agent 用户点"刷新"按钮时调。

## Agent 场景 7：我的绩效

```
GET /api/performance/me
```

返回当前用户：本月绩效得分、所有 KPI 完成度、预估绩效工资。

业务员查自己，老板查大家（走 `/api/performance/employee-monthly` 参数带员工 id）。

## Agent 场景 8：销售目标

三级目标：company（公司）→ brand（品牌）→ employee（员工）。

### 查我的目标
```
GET /api/sales-targets/my-dashboard
```

业务员的本月目标 + 当前进度 + 剩余天数。

### 建目标（老板做）
```
POST /api/sales-targets
{
  "target_level": "employee",
  "target_id": "<employee id>",
  "brand_id": "...",
  "metric": "revenue",
  "target_value": 100000,
  "period": "2026-04",
  "period_type": "monthly"
}
```

建完要 `POST /sales-targets/{id}/approve` 才生效。

## Agent 场景 9：提成

提成是订单 fully_paid 后**自动生成**的（不用 Agent 手动建）。

查我的提成（ERP）：

```
GET /api/hr/commissions?employee_id=X&status=pending&period=2026-04
```

mall 业务员自查（**G6 · 决策 #1 透明化**，在小程序里用）：
```
GET /api/mall/workspace/my-commissions?status=all|pending|settled|reversed|adjustment&year=2026&month=4
GET /api/mall/workspace/my-commissions/stats?year=2026&month=4
```

返回未结算的提成列表。Agent 给业务员回答"我这月有多少提成"。

**提成规则**（见 settlement-modes.md）：
- customer_pay / employee_pay：基于指导价
- company_pay：基于到手价
- 提成率从 EBP.commission_rate 取（没配则用 BrandSalaryScheme 默认）
- mall 订单基于 `received_amount`（实收）；门店零售基于 `sale_price - cost_price` × `retail_commission_rates.rate_on_profit`

### 跨月退货追回（决策 #1）

如果业务员问"为什么我工资少 ¥100"：
1. 调 `GET /api/payroll/salary-records/{rec_id}/detail`
2. 看 `clawback_details[]`：每条有 `origin_order_no / origin_amount / amount`（负数）
3. 翻译："是 3 月 MO-xxx 单客户退货冲减，上月已发 ¥100 提成本月扣回"
4. 不要说"系统扣你工资"，要归因到具体订单

详见 `payroll.md` 场景 6.1 "跨月退货追回 + 挂账"。

## 常见错误

| detail | 解释 |
|---|---|
| "员工未设置主属品牌" | EBP 没 is_primary=true，工资/KPI 无法生成 |
| "该日已打卡" | 重复打卡 |
| "打卡位置超出范围" | geofence 校验失败（Agent 告诉员工要到公司地点打） |
| "请假天数计算不对" | start/end 包含周末时看规则是否把周末算进去 |

## Agent 推送触发

| 事件 | 推给谁 |
|---|---|
| 业务员月中进度 50% / 80% / 100% / 120% | 本人 + sales_manager |
| 请假被批/驳 | 申请人 |
| 月底考勤汇总出炉 | HR（检查异常：迟到多的、出勤不足的）|
| 新员工入职 | HR / 所在品牌 sales_manager（提示建 CBS 绑定）|

## Agent 禁忌

- ❌ **不代打卡**。GPS 必须真实的。
- ❌ **不代请假**（必须员工本人发起，Agent 只帮填表）。
- ❌ **不告诉 A 员工 B 员工的工资/绩效**。employees 表（m6cv）+ salary_records 表都有 RLS：普通员工查 `SELECT employee_id, base_salary FROM ...` 走 erp_app 只能看到自己。但 Agent 走 admin 通道（admin_session）会**绕过 RLS**——所以 Agent 即使技术上能查到全部，**业务上也不能告诉 A B 的工资**。Agent 自己拦截。
- ❌ **不主动修改 KPI 目标**（老板职责）。
