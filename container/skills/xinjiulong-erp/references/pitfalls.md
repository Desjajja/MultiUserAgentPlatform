# 常见坑位与历史 bug 总结

**作用**：把项目过去犯过的所有业务 bug 归类总结，Agent 读完以后**绝对不能重复犯这些错误**。
每一条都是线上真出过问题才修的，不是理论推演。

---

## 一、幂等缺失类（重复调用 → 账务膨胀）

### 坑 1：把 `settled_amount` 当“归档金额”来写，导致核销口径串账

**事发**：早期把 `confirm_fulfill` 和 `settled_amount` 绑在一起，后来又引入厂家结算核销，结果同一个字段既表示“已归档”又表示“已核销”，口径冲突。

**正确写法**：
- `confirm_fulfill` 只负责把 `fulfill_status` 变成 `settled`
- `settled_amount` 只允许 `confirm_settlement_allocation` 累计写入
- 归档幂等仍然保留：`if item.fulfill_status == 'settled': return '已归档'`

**Agent 怎么避免**：调幂等接口前 `GET` 查当前状态，看到已是终态直接返回友好提示，不重复调。

### 坑 2：`confirm_arrival` 对已 `arrived` item 不跳过 → F 类账户重复加款

**事发**：同一 Excel 对账批两次，F 类账户 balance 被加两轮。

**正确写法**：`for item in items: if item.arrival_at is not None: continue` 必须有；并且已 `fulfilled/settled` 的条目只补 arrival 字段，不回退兑付状态。

**Agent 怎么避免**：调对账前不必检查（后端已防），但遇超时**绝不自动重试**。

### 坑 3：`confirm-payment` 端点重复调用多次动 master

**事发**：财务手抖双击或网络抖动重发请求。

**正确写法**：`POST /orders/{id}/confirm-payment` 入口先判 Order 的 pending Receipt 个数，0 个返回 200 "已无待审凭证"。

**Agent 怎么避免**：
- 遇超时等 5 秒后 GET 查 Order.payment_status 确认结果
- 结果是 `fully_paid / partially_paid` → 成功，不重试
- 仍 `pending_confirmation` → 可重试一次
- 重试**最多一次**，再超时告诉用户联系技术

---

## 二、并发 race 类（多请求同时落）

### 坑 4：`approve_repayment` 并发 → 本金销账丢笔

**事发**：boss 在两个浏览器同时批两笔还款，后端都读到 `repaid_principal=0`，各自 `+= 5000`，最终只加一次。

**正确写法**：`SELECT ... FOR UPDATE` 锁 FinancingRepayment 和 FinancingOrder。

**Agent 怎么避免**：不要让两个用户同时操作同一单（通过前端锁 + 按钮 disabled 提示）。

### 坑 5：`execute_inspection_case` 并发双扣

**事发**：两个 boss 同时点 execute，账户被扣两次。

**正确写法**：`SELECT ... FOR UPDATE` 锁 InspectionCase 行。

**Agent 怎么避免**：推卡片时把案号 + 品牌放 ctx_id 里，同一 ctx_id 的按钮点过就失效。

### 坑 6：`cancel_paid_purchase_order` 并发让 `payment_to_mfr` 变负

**事发**：两个 finance 同时撤销同一单。

**正确写法**：`SELECT FOR UPDATE` 锁 payment_to_mfr 账户 + 余额校验。

---

## 三、状态机漏判类（该拒没拒 / 该转没转）

### 坑 7：InspectionCase delete 不检查 `executed` → 已执行案件被删库存账户错乱

**事发**：delete 接口的禁止列表只写了 `closed`，`executed` 漏了。

**正确写法**：`if case.status in ('executed', 'closed'): raise 400`。

**Agent 怎么避免**：调 delete 前 GET 查 status，只允许 pending/approved/rejected 调。

### 坑 8：MCP `receive_purchase_order` 没校验"已 received / completed"

**事发**：AI Agent 调 MCP receive 同一采购单两次，库存入两次。

**正确写法**：MCP 必须对齐 HTTP 的状态前置校验。

**Agent 怎么避免**：调任何入库类前端点之前先 GET 查 status。

### 坑 9：share_out 只存在 master/payment_to_mfr 其一就硬做

**事发**：payment_to_mfr 账户缺失时只加了 master 没扣 ptm，账务失衡。

**正确写法**：两个账户都必须存在才执行，缺一整体 400。

**Agent 怎么避免**：调 share_out 前先调 `GET /accounts/summary` 确认两账户都在。

### 坑 10：ExpenseClaim delete 不检查状态 → 删已 approved 的 share_out

**事发**：`approved` 状态的 share_out 已经动过账（master +=, ptm -=），直接删 claim 记录但账户不回滚。

**正确写法**：delete 仅允许 `pending / rejected`。approved 后的通过反向流水冲正。

---

## 四、聚合过滤漏 `status='confirmed'` 类

### 坑 11：业务员上传凭证进 pending Receipt → 被误计绩效/提成

**事发**：`SUM(Receipt.amount)` 没加 `status='confirmed'`，把 pending 凭证也算进回款，业务员刷 KPI。

**正确写法**：所有 `SUM(Receipt.amount)` 必须 `WHERE status='confirmed'`。

**项目里已修的位置**（Agent 读代码时注意别改错）：
- `performance_service.get_monthly_performance`
- `dashboard_service.get_summary`
- `commission_service.compute`
- `order_service.get_order_balance`
- `kpi_service.refresh_actual`

**Agent 怎么避免**：写 SQL 或读指标时，看到"回款"类字段先问是不是 confirmed。

### 坑 12：订单 `status` 过滤漏 `cancelled / rejected`

**事发**：月度销售额统计把已 cancel 订单也算进去。

**正确写法**：`Order.status.notin_(['cancelled', 'policy_rejected'])`。

---

## 五、跨品牌串账类

### 坑 13：`submit_repayment` 不校验 `pay_acc.brand_id == order.brand_id`

**事发**：A 品牌融资用 B 品牌现金还款，账户串了。

**正确写法**：两层校验 —— pay_acc 品牌 + f_class 品牌都必须匹配 order 品牌。

### 坑 14：`confirm_settlement_allocation` 跨品牌分配 PolicyClaim

**事发**：用 A 品牌的 ManufacturerSettlement 分配给 B 品牌的 PolicyClaim，`company_pay` 路径动了 B 品牌账户。

**正确写法**：`if settlement.brand_id != claim.brand_id: raise 400`。

### 坑 15：salesman 查账户返回 master 余额

**事发**：业务员接口没做 level 过滤，JSON 里带 `master` 余额泄露。

**正确写法**：API 层 `if current_user.role=='salesman': query.where(Account.level != 'master')`。

**Agent 怎么避免**：给 salesman 角色的人推卡片时**绝不**带 master 数字，哪怕后端返了也脱敏。

---

## 六、MCP 工具绕开 HTTP 校验类

### 坑 16：MCP `confirm_order_payment` 直接改 Order.payment_status

**事发**：MCP 老版本没走 receipt_service，直接 SQL update Order，绕开 apply_per_receipt_effects，不生成 Commission 不刷 KPI。

**正确写法**：MCP 全部调用 service 层函数，不自己写 update。

**Agent 怎么避免**：调 MCP 工具前看工具描述"是否对齐 HTTP 层"，对齐的才用。

### 坑 17：MCP `register_payment` 建 Receipt 不触发后续效应

**事发**：MCP 建了 confirmed Receipt 但没调 `apply_post_confirmation_effects`，订单 fully_paid 了但无 Commission。

**正确写法**：调 receipt_service 的标准流程（`apply_per_receipt_effects` + `apply_post_confirmation_effects`）。

### 坑 18：MCP `receive_purchase_order` 跳过状态校验

**事发**：MCP 没挡 `received` 状态，重复入库。

**正确写法**：MCP 和 HTTP 共用一份 service 函数。

---

## 七、字段语义错配类

### 坑 19：用 `total_amount` 判断"是否全款"

**事发**：有人用 `SUM(Receipt.amount) >= Order.total_amount` 判全款。但 `total_amount` 是指导价合计，employee_pay / company_pay 下客户实付是 `deal_amount`。

**正确写法**：`SUM(confirmed Receipt.amount) >= Order.customer_paid_amount`。

**字段记忆口诀**：
- `total_amount` = 指导价总额（**不变**）
- `deal_amount` = 到手价总额（可能 < total）
- `customer_paid_amount` = 公司应收 = 客户应付总额（按模式变）

### 坑 20：KPI 系数 linear 模式计算反转

**事发**：`kpi_coefficient = 1 / completion_rate` 写反了（应该 `= completion_rate`）。完成 50% 给了 2.0 系数，完成 200% 给了 0.5。

**正确写法**：`linear` 模式下 `kpi_coefficient = completion_rate`。

**Agent 怎么避免**：生成工资单后展示 KPI 系数时做 sanity check：完成率 <50% 的不应超过 1.0。

### 坑 21：提成基数用错模式

**事发**：employee_pay 订单的 comm_base 被算成 total_amount（指导价 27000），应该按"公司实收"（客户付 19500 + 业务员垫 7500 = 27000... 但历史决策是按 customer_paid_amount 19500）。

**正确写法**：`comm_base = Order.customer_paid_amount or Order.total_amount`。

**业务决策**：提成按"公司应收"，而 customer_paid_amount 是公司应收。employee_pay 下业务员自己垫的不给自己算提成——这是故意的。

**Agent 不要改这个逻辑**，改之前先问 boss。

---

## 八、金额校验类

### 坑 22：采购付款金额不对齐整体通过

**事发**：`cash + f_class + financing != SUM(qty × price)` 时没挡，账户乱扣。

**正确写法**：前端允许 ±0.01 误差，后端 `abs(diff) > 0.01 → 400`。

### 坑 23：融资还款 F 类不足静默跳过

**事发**：F 类 balance 不够，现金已扣，F 类没扣，资产负债表差一笔。

**正确写法**：F 类预校验失败整体 400，不动任何账户。

### 坑 24：厂家补贴到账金额不校验

**事发**：后端收到"到账 5000"但实际应收 4800，多出 200 进了 cash 账户。

**正确写法**：`arrived_amount` 必须严格等于 `SUM(pending + advanced subsidies)`。

---

## 九、数据库约束 / 模型层类

### 坑 25：`server_default=sa.text('now()')` 在 asyncpg 下不工作

**事发**：建 Receipt 时 `created_at` 为 NULL。

**正确写法**：Pydantic / ORM 层显式赋 `datetime.utcnow()` 而不是依赖 server_default。

### 坑 26：SQLAlchemy `autoflush=False` 下 INSERT 后查 SUM 拿旧值

**事发**：业务员上传凭证 → 建 Receipt → 查 `SUM(Receipt.amount)` 判是否全款，结果新 Receipt 没落库，SUM 是旧值，永远判不到 fully_paid。

**正确写法**：`db.add(receipt); await db.flush(); sum_result = await db.execute(...)` — **先 flush 再 SUM**。

**Agent 读代码时注意**：看到"INSERT 后立刻 SUM 同表"的代码，第一反应是"flush 了吗？"

### 坑 27：`kpi_rule_snapshot` 字段没冻结 → 工资改规则后历史重算

**事发**：4 月规则改了，但 3 月已归档工资单没冻结当时规则，回查时算出来不一样。

**正确写法**：生成 SalaryRecord 时把当时生效的规则 JSONB 冻进 `kpi_rule_snapshot`，之后读这个字段展示。

---

## 十、文件上传 / 凭证类

### 坑 28：飞书图片下载 Content-Type 写死 `image/jpeg`

**事发**：用户传 png，后端 Content-Type 写 jpeg，ERP uploads 存了错文件头。

**正确写法**：飞书下载响应的 `Content-Type` 原样传递。

### 坑 29：多图上传用户多次发图 Agent 不等待就入库

**事发**：用户连发 3 张图，Agent 收到第一张就建 Receipt 了。

**正确写法**：Agent 必须静默等 30 秒看是否继续收到图，或用卡片"完成上传"按钮明确结束。

---

## 十一、通知 / 状态同步类

### 坑 30：里程碑 delta 计算用累计值而非本次增量

**事发**：订单累计回款从 95% 跨到 120%，推了"达成 100%"但之前的 100% 也推了一次。

**正确写法**：`apply_post_confirmation_effects(newly_confirmed_amount=...)` 传**本次新增**金额，对比 "(旧累计, 旧累计+新增]" 区间推里程碑。

### 坑 31：工资发放后不发通知

**事发**：工资 `pay` 成功后忘调 `send_salary_notification`，员工不知道工资发了。

**正确写法**：支付成功后 async 推送飞书通知 + app 消息。

---

## 十二、删除类（最容易漏）

### 坑 32：已 executed / paid / completed 数据被误删

**事发**：前端没禁掉删除按钮，后端也没校验，用户手抖删了已动账数据。

**通用规则**：凡是"动过账/动过库存"的实体，**只能走反向凭证不能直接删**。

对应规则：
- Receipt confirmed → 建 reversed Receipt，不删
- SalaryRecord paid → 建反向工资流水，不删
- InspectionCase executed → 建反向调账，不删
- PurchaseOrder received → 走退货流程，不删
- TransferRequest approved → 反向调拨，不删

---

## 十二点五、2026 Q2 新增决策 + 加固（Agent 一定要知道）

### 坑 Q2-1：跨月退货不能直接"冲减上月已发工资"

**事发**：业务员 3 月工资 ¥6000 已发，4 月某单退货 ¥300 提成要追回。老板问 "为啥 4 月发 ¥5700？" —— 实际是 3 月退货 ¥300 冲到 4 月扣。
**正确做法**（决策 #1 · m6c1）：
- 系统**不动**已 settled 的 commission（审计历史保留）
- 新建 `Commission(is_adjustment=True, amount=-300, status=pending)`
- 下月工资单自动扫入
- Agent 回答时先查 `clawback_details[]`，告诉业务员"是 3 月 MO-xxx 单客户退货冲减"，不要说"系统扣你工资"

### 坑 Q2-2：工资不够扣走"挂账"而不是"欠公司"

**事发**：员工当月只来 3 天班 + 刚好退货 ¥500 → `total_pay = -¥200`。若写 -¥200 到工资条，员工以为要倒贴公司。
**正确做法**（决策 #1 · Step B）：
- `actual_pay = 0`，挂一条 `SalaryAdjustmentPending(pending_amount=200)`
- 下月工资**先扣历史挂账**（`ORDER BY created_at ASC` 先进先扣）
- Agent 回答："本月没有倒贴，只是把 ¥200 挂到下月继续扣"

### 坑 Q2-3：月底"业务员排行榜"不能只看实时

**事发**：老板 5 月 5 日发了 4 月奖金给 Top3，5 月 10 日客户退货导致某 Top3 的 4 月 GMV 实时排行掉到第 5，老板问 "我发错奖金了吗？"
**正确做法**（决策 #2 · m6c4）：
- 每月 1 号 00:05 定时 `job_build_last_month_snapshot` 冻结快照
- `mall_monthly_kpi_snapshot(employee_id, period UNIQUE)` 表存 gmv/order_count/commission
- API `GET /api/mall/admin/dashboard/salesman-ranking?mode=snapshot|realtime&year_month=YYYY-MM`
- Agent 回答排名时**主动说明**："快照视图是 5 月 1 日冻结的（¥XX，Top1）；实时视图剔除了退货，Top1 已经换了"

### 坑 Q2-4：门店散客收银 customer_id 可以为空

**事发**（决策 #3 · m6c2）：门店零售的客户不都是小程序会员，允许"散客"直接买。
- `store_sales.customer_id` **nullable**；`customer_walk_in_name/phone` 做文本快照（营销用）
- `store_sale_returns.customer_id` 同步 nullable（散客原单也能退）
- Agent 收银时不能强制让店员"必须选一个会员"，看到散客入参直接提交

### 坑 Q2-5：商品销量显示要区分 total vs net

**事发**（决策 #4 · m6c3）：老板问"A 商品 4 月销量 1000 瓶，怎么榜单显 980？"
- `MallProduct.total_sales` = 曾售卖瓶数（含退货，不回退）
- `MallProduct.net_sales` = 净销量（退货时扣，`max(0, net - qty)`）
- 首页/搜索/榜单排序都切换到 `net_sales`
- 管理后台 ProductList 列显示 "总/净"，净 < 总时标红
- Agent 回答销量时用 `net_sales`（除非老板明确问"曾经卖过多少"）

### 坑 Q2-6：退货 approve 双击 = 双扣提成（G12 已修）

**事发**：财务按"批准"按钮后网卡，3 秒重按，两次请求并发。应用层 pending check 不够，会建两条 adjustment Commission 使业务员下月被双扣。
**正确做法**（m6c6 修复）：
- `return_service.approve_return` 开头 `SELECT FOR UPDATE` 锁 return request + order
- DB 层给 `commissions.adjustment_source_commission_id` 加 partial UNIQUE（`WHERE is_adjustment=true`）兜底
- Agent 看到 "UniqueViolation adjustment source" 报错**不要重试**，告知"系统已建过追回，不能重复"

### 坑 Q2-7：业务员切门店不能直接改（G14）

**事发**：业务员王五 A 店当天开了 ¥8000 销售单，晚上被 admin 调到 B 店 → 次日 A 店客户来退货，王五在 B 店提不起 return（`403 非本店店员`）。
**正确做法**：
- `update_salesman` 切 `assigned_store_id` 前自动检查：
  - 有待审退货 → 409 阻塞（必须处理完再切）
  - 24h 内 completed 销售单 → 409 + 要求 `force_switch=true`
- Agent 调 update-salesman 时如果带 store 切换，先 GET 业务员在途状态告诉用户 "王五 A 店还有 3 笔今天开的单，切到 B 店后他无法处理退货，确认继续吗？"

### 坑 Q2-8：业务员看客户手机号要脱敏 + reveal 审计（G16）

**事发**：离职业务员临走前拉完所有客户手机号。
**正确做法**：
- `/api/mall/salesman/my-customers` 列表返回脱敏号（`138****1234`）
- `/api/mall/salesman/my-customers/{id}/phone` 揭示完整号 + 写 `mall_customer.reveal_phone` 审计
- miniprogram 点"拨号"按钮才调 reveal 端点
- Agent 代业务员"发短信 / 查电话"类请求时必须走 reveal 流程，不能批量捞

### 坑 Q2-9：凭证上传超时不是一定有人看（G15）

**事发**：业务员周五 18:00 上传凭证，下周一才有人处理，中间 67 小时无告警。
**正确做法**：
- APScheduler 每小时 :15 扫 `mall_payments.status=PENDING_CONFIRMATION`
- 超 24h → 推 admin/boss/finance；超 48h 二次提醒
- Agent 被问"凭证多久没人看了"时查 `created_at` 并告诉业务员"已挂 X 小时"

### 坑 Q2-10：门店收银搜客户关键字 < 5 字符会被拒（G11）

**事发**（修复前）：店员输 "138" 能拉全库手机号。
**正确做法**：
- 关键字 `min_length=5`（数字前缀/姓名）
- 返回脱敏手机号 + `is_local_customer` 标
- 本店消费过的客户排前
- Agent 帮店员建客户卡片时如果只给 3 位，提示"至少输 5 位 / 改用新建客户端点"

### 坑 Q2-11：禁用业务员要通知客户（G17）

**事发**：业务员违规被 admin 禁用 → 系统释放了 5 单，但客户昨天还看到"已接单"通知，今天变回"待接单"，打客服电话质问。
**正确做法**：
- `disable_salesman` 释放每条 assigned 订单时自动 `notify_mall_user` 客户"订单配送员变更"
- Agent 执行禁用操作前**先 GET 业务员 assigned 订单数**告诉 admin："王五有 5 单在配送中，禁用后这些客户会收到重新派单通知，确认继续？"

---

## 十三、Agent 交互类（AI 特有的坑）

### 坑 33：Agent 猜用户意图直接调接口

**场景**：用户说"给张三下个单"，Agent 自己脑补 settlement_mode 和品牌，直接建单。

**后果**：建错单，用户发现后还要删 / 改。

**正确做法**：**宁可多问一轮，也不要错动账**。每个写入接口调用前必须推卡片让用户按按钮确认。

### 坑 34：Agent 自己算金额

**场景**：用户说"5 箱青花郎 900 一瓶"，Agent 算 5×10×900=45000 建单。

**后果**：政策赠品 / 政策差没算，金额错。

**正确做法**：**所有金额用 `POST /orders/preview` 返回的值**，Agent 不自己算。

### 坑 35：Agent 自动重试动账接口

**场景**：调 confirm-payment 超时，Agent 自动重试 3 次。

**后果**：重复动账，master 多加 3 倍。

**正确做法**：动账接口超时后 —— 等 5 秒 → GET 查状态 → 成功则不重试 → 失败告诉用户"可能已执行，请联系技术确认"。

### 坑 36：Agent 代用户点"同意"按钮

**场景**：boss 说"批了"，Agent 自动调 approve 接口。

**后果**：未经卡片确认的审批，boss 可以抵赖"我没点过"。

**正确做法**：Agent 推"确认审批"卡片 → boss **亲自点按钮** → 后端才调 approve。文字"批了"不算授权。

### 坑 37：Agent 泄露 master 余额给 salesman

**场景**：salesman 说"看看账户"，Agent 调 `/accounts/summary` 返回所有账户含 master。

**后果**：salesman 知道公司总资金池金额，信息泄露。

**正确做法**：Agent 根据当前用户角色过滤返回值，salesman 只看品牌级账户。

### 坑 38：Agent 对话记忆过长导致串词

**场景**：Agent 记了 20 轮，前 10 轮是建客户 A，后 10 轮是建客户 B，最终建单时把 A 的 id 配 B 的商品。

**正确做法**：每完成一个闭环（建单成功 / 审批完成）清空上下文，对话记忆 ≤ 10 轮。

---

## 十四、"对自己说一遍"核对清单（Agent 写代码 / 调接口前用）

每次 Agent 做事前默念这些问题，有一个答"不确定"就先停手查证：

1. **这个接口的幂等性是怎么保证的？** 我能随便重试吗？
2. **当前实体状态是什么？允许转到目标状态吗？**
3. **会动哪些账户 / 库存 / 状态？** 每个都对吗？
4. **有没有 `SELECT FOR UPDATE` 锁？** 并发场景安全吗？
5. **金额我是自己算的还是后端返的？** 自己算的不能信。
6. **权限够吗？** 当前角色能调这个接口吗？
7. **错了能反吗？** 不可逆操作用户知情吗？
8. **对话记忆是不是太长了？** 有没有串词风险？

---

## 十四点五、身份绑定类（权限隔离的地基）

### 坑 39：Agent 用 admin / service account 万能 token 帮所有人查数据

**事发**：Agent 图省事用一个 admin JWT 代所有用户调接口，salesman 来问"我的客户"时 Agent 查了**全公司**所有客户返回。
**后果**：
- RLS 完全失效（admin 看全部，Agent 把 admin 视角的数据原样给了 salesman）
- 审计日志 user_id 全落 admin，追责无从下手
- master 账户金额泄露给业务员

**正确做法**：Agent **永远不持有固定 token**。每次对话开始用该员工的 `open_id` 去 `/api/feishu/exchange-token` 换**本人**的短期 JWT，用这个 JWT 调 ERP。后端 RLS 会自动按他的 role/brand_ids 过滤。

### 坑 40：Agent 跨对话复用 JWT

**事发**：Agent 缓存了 A 的 JWT，B 来对话时直接用。
**正确做法**：JWT 按 open_id 分桶缓存，**严禁交叉使用**。

### 坑 41：员工离职 / 调岗后 token 还在用旧权限

**事发**：前 salesman 调成 finance，Agent 缓存的 JWT 里 role 还是 salesman，继续按旧权限给他查数据。
**正确做法**：JWT 过期重新 exchange；发现返回的 role / brand_ids 和缓存不一致时立即丢缓存。

### 坑 42：ERP 密码明文留在对话 / memory

**事发**：bind 流程让用户输密码，Agent 把整个对话历史包括密码存进 memory。
**正确做法**：密码字段在 bind 成功后**立即从上下文 / memory 擦除**，只保留"已绑定"这个状态标记。

### 坑 43：一个 open_id 对应多个 ERP 账号

**事发**：员工 A 用 open_id X 绑了账号 a1；后来用另一台手机把 X 又绑成 a2，前端没挡住，动账归属混乱。
**正确做法**：后端 `feishu/bind` 已做唯一约束 (open_id UNIQUE)。Agent 遇到 "该 open_id 已绑定其他身份" 时告诉用户"请先解绑旧账号"，不硬绑。

---

## 十五、Agent 绝对红线（再次强调）

这些事**无论在什么情况下都不能做**：

1. ❌ 猜用户意图直接动账（哪怕 95% 把握）
2. ❌ 重试动账接口（哪怕网络错误）
3. ❌ 替用户点审批按钮（卡片点击 = 唯一授权方式）
4. ❌ 自己算金额（必须 preview 接口）
5. ❌ 泄露 master 给 salesman（多一层脱敏保护）
6. ❌ 删除已动账实体（走反向凭证）
7. ❌ 伪造 source_type / 跨品牌调拨不走 transfer 端点
8. ❌ 忽略业务校验（如"余额不足"直接告诉用户"我重试下" → 必须让用户明确决策）
9. ❌ 绕开卡片确认直接执行
10. ❌ 自作主张改 KPI 规则 / 提成率 / 薪酬方案（那是 HR/boss 专属）
11. ❌ **用别人的 JWT / admin 万能 token 代当前用户操作**（永远用对话用户自己的 JWT，继承他本人的 RBAC+RLS）
12. ❌ **跨对话 / 跨 open_id 复用 JWT**（按 open_id 分桶缓存，离职 / 调岗自动失效）
13. ❌ **把 ERP 密码记进 memory / 对话历史**（bind 成功立即擦除）

---

## 十六、使用建议

Agent 每次开始工作前**扫读一遍这份**（至少读第十四 + 第十五节）。

遇到不确定的坑，优先：
1. GET 查当前状态
2. 读 service 层源码确认行为
3. 推卡片让用户确认

**不要假设"我肯定对"**——这个项目里每一条坑都是"有人假设他肯定对"导致的。

---

## 十七、Excel 对账（厂家结算）特有坑

### 坑 X1：路径冲突——`/manufacturer-settlements/{id}` 吃掉 `/manufacturer-settlements/xxx-action`

**事发**：原本想给"调整匹配"下拉做候选项端点 `/manufacturer-settlements/reconcile-candidates`，结果返回 `{"detail":"ManufacturerSettlement not found"}`——因为 `/manufacturer-settlements/{settlement_id}` 在前面注册，把 `reconcile-candidates` 当成了 ID。

**修复**：候选项端点改成独立前缀 `/reconcile-candidates`。

**Agent 怎么避免**：调"看似挂在 /resource/ 下、但其实是 action"的端点前，先 GET 一次确认；遇到 404 detail 提到资源名，怀疑被 `{id}` 路由吃了。

### 坑 X2：扩展名是 `.xlsx` 但内容是 OLE2 老 xls

**事发**：厂家发的"xlsx"其实是 WPS 导出的 `.xls`（OLE2），openpyxl 报 "File is not a zip file"。

**修复**：`_parse_excel_rows` 改用 magic-byte 探测：`PK\x03\x04` → openpyxl；`\xd0\xcf\x11\xe0...` → xlrd。

**Agent 怎么避免**：调 import-excel 报"无法读取"时，建议用户用 WPS"另存为 xlsx"再上传，不要相信扩展名。

### 坑 X3：已入账过的政策项重复出现在导入预览的"需人工"列

**事发**：用户每次导厂家 Excel，明明 F34038480 上次已经入账了，"需人工"段还是会出现这一行，提示"已确认到账于 2026-05-17"。

**修复**：候选池从 `policy_request_items` 拉时**强制** `arrival_at IS NULL`，已入账的方案号单独放 `arrived_scheme_nos` 集合，遇到这种行**整条跳过**，不进任何列表。

**Agent 怎么避免**：用户问"为啥已经对账过的还显示在表里"，先 `SELECT scheme_no, arrival_at FROM policy_request_items WHERE scheme_no=...` 看是不是已入账，是的话告诉用户"已入账过的方案号在 v2 已经跳过、若仍出现请清缓存或重启后端"。

### 坑 X4：response_model 校验 datetime → str 失败，回滚整个事务

**事发**：`PUT /api/policies/expenses/{id}` 在修改公司垫付费用后已经动了账，但返回时 `ExpenseItemResponse.created_at: Optional[str]` 拿到 datetime 报 `ResponseValidationError`，FastAPI 抛 500，事务回滚 → 账户、actual_cost 全部退回。

**修复**：把 `created_at: Optional[str]` 改 `Optional[datetime]`，让 Pydantic 自动序列化。

**Agent 怎么避免**：调动账接口后**必须**等 200 才算成功；遇到 500 别假设"动账已落库"，再 GET 查现状。

### 坑 X5：actual_cost 在 customer/employee 垫付场景下漏算 → 利润台账虚高

**事发**：CLAUDE.md 里 `fclass_diff = arrival_amount - actual_cost`。客户垫付 1350、厂家拨 1350、还客户 1350，应该净 0。但 actual_cost 一直留 0 → 报表显示净盈 1350。

**修复**：`POST /api/payment-requests/{id}/confirm-payment` 批准 `advance_refund` 且 `payee_type in (customer,employee)` 时，自动 `actual_cost += amount`。需要 `payment_requests.source_request_item_id` 字段（m6ct migration 已加）。

**Agent 怎么避免**：用户问"为什么这条政策利润有 1350 盈余"，去查 advance_refund 类 PaymentRequest 是否走完 confirm-payment；没批的状态下 actual_cost 应该是 0 但 arrival_amount 也是 0（还没厂家拨）。

---

## 十八、公司垫付动账特有坑

### 坑 Y1：保存关联费用就动账，不能"草稿"

**事发**：用户在"添加关联费用"弹窗里随便填了试试，结果品牌现金账户立刻 -8000。

**正确认知**：`payer_type=company` 的 PolicyItemExpense **创建即扣账**。系统不存在"草稿模式"。

**Agent 怎么避免**：弹窗里加文案"录入即扣款，请确认金额无误"，并把当前账户余额展示出来。

### 坑 Y2：删除已 settled 政策项的关联费用，反向流水写到封盘项上

**事发**：政策项已 settled，但用户还能调 DELETE 删它的关联费用，回滚现金账户 + actual_cost。但 settled 通常意味着账已经"封盘"，不该再动。

**修复**：`_apply_company_expense` 头部校验 `ri.fulfill_status='settled'` 直接拒。

**Agent 怎么避免**：删/改 PolicyItemExpense 前先 GET 政策项 fulfill_status，settled 的告诉用户"已归档不能改，必要时找老板手工冲账"。


---

## 十九、门店权限隔离特有坑（m6cy 后）

### 坑 Z1：员工换绑门店后老 token 还带旧 store_ids

**事发**：HR 在管理端给业务员加了门店"青花郎专卖店"权限。业务员立刻打开手机查门店库存——还是 403/空，以为系统坏了。

**正确认知**：`store_ids` 是登录时 build_jwt_payload **聚合写进 JWT** 的，已签发的 token 不会自动更新。员工必须**重新登录**才能拿新 store_ids。

**Agent 怎么避免**：改员工 store 绑定后告诉用户"已绑定，让该员工退出小程序/ERP 重新登录刷新权限"。

### 坑 Z2：employees.assigned_store_id 单值字段已经"半弃用"，新代码勿写

**事发**：开发改员工档案，按老习惯写 `employee.assigned_store_id = "xxx"`。结果 JWT 里 store_ids 没更新——因为 build_jwt_payload 读的是 `employee_store_assignments` 多对多表。

**正确认知**：m6cx 起权威源是 `employee_store_assignments`。旧字段保留向后兼容，但 RLS / JWT 都读多对多表。

**Agent 怎么避免**：绑/解绑门店一律走 `employee_store_assignments` 的增删，不要碰 `employees.assigned_store_id`。

### 坑 Z3：admin/boss/finance/hr 的 store_ids 包含**所有**门店

**事发**：写报表统计"门店流水"，因为业务员的 store_ids 是子集，admin 是全集，按 `WHERE store_id = ANY(store_ids)` 过滤时 admin 看到的数据比预期多。

**正确认知**：JWT build 时 `is_admin OR finance OR hr` → `store_ids = 所有 warehouse_type='store' 的仓`。这是合理设计（这些角色本来就能看所有店）。

**Agent 怎么避免**：业务侧统计"全公司门店"用 admin role 跑就行，store_ids 自动覆盖全部。
