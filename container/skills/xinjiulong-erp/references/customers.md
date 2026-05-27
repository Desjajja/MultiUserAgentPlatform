# 客户管理

## 核心数据模型

```
Customer（客户本体）
  - id / code / name / contact_name / contact_phone / settlement_mode
  - 不包含 brand_id 字段

CustomerBrandSalesman (CBS)（多对多绑定）
  - customer_id × brand_id × salesman_id
  - 唯一约束：(customer_id, brand_id) —— 一个客户在一个品牌下只能有一个业务员
  - 一个客户可以绑多个品牌（每个品牌不同业务员）
```

**关键**：客户的**可见性由 CBS 决定**（P2b RLS）。salesman 登录后查 `/api/customers`，只能看到 `CBS.salesman_id = 我 AND CBS.brand_id ∈ 我绑的品牌` 的客户。

## Agent 分步：建客户

### 前置问题（Agent 收集）

- **客户名称**（必填）
- **编号**（可选，不传后端自动生成）
- **客户类型** `channel`（渠道）/ `group_purchase`（团购）
- **结算方式** `cash`（现结）/ `credit`（赊销，若赊销要问账期天数）
- **联系人 / 电话**
- **归属品牌**（必填！）——业务员建客户时必须指定一个品牌，系统自动建 CBS 绑定到当前业务员
- **归属业务员**（可选）——admin/boss 建客户时可以指定别人，默认自己

### Agent 用的卡片（Form 容器）

```json
{
  "header": {"title": "新建客户"},
  "elements": [{"tag": "form", "name": "new_customer", "elements": [
    {"tag": "input", "name": "name", "placeholder": "客户名称 *"},
    {"tag": "select_static", "name": "customer_type", "options": [
      {"value": "channel", "text": "渠道客户"},
      {"value": "group_purchase", "text": "团购客户"}
    ]},
    {"tag": "select_static", "name": "brand_id", "placeholder": "归属品牌 *",
     "options": "<从 /api/products/brands 获取>"},
    {"tag": "select_static", "name": "settlement_mode", "options": [
      {"value": "cash", "text": "现结"}, {"value": "credit", "text": "赊销"}
    ]},
    {"tag": "input", "name": "credit_days", "placeholder": "账期（赊销才需要）"},
    {"tag": "input", "name": "contact_name", "placeholder": "联系人"},
    {"tag": "input", "name": "contact_phone", "placeholder": "电话"},
    {"tag": "button", "text": "确认建客户", "action_type": "form_submit"}
  ]}]
}
```

### API 调用

```
POST /api/customers
{
  "name": "张三烟酒店",
  "customer_type": "channel",
  "settlement_mode": "cash",
  "brand_id": "<品牌 id>",              // salesman 必须传；后端自动建 CBS
  "salesman_id": "<员工 id>",           // 可选，admin 用
  "contact_name": "张三",
  "contact_phone": "138..."
}
```

后端自动：
- 建 Customer 记录
- 按 (brand_id, salesman_id) 建 CBS 绑定

## Agent 分步：查客户

### 简单查询

```
GET /api/customers?brand_id=X&keyword=张三&skip=0&limit=20
```

返回的是 salesman 当前角色可见的（RLS 自动过滤）。

### 客户 360 视图

```
GET /api/customers/{id}/360
```

返回：基本信息 + 近期订单 + 应收账款 + 政策申请历史。

Agent 用这个给用户展示"客户档案"。

## Agent 分步：多品牌绑定

用户："把张三烟酒店也挂到汾酒品牌，业务员是李四"。

Agent:
1. 查 customer_id（按名字查询）
2. 查 brand_id（汾酒）
3. 查 salesman_id（李四 employee_id）
4. 确认卡片："将把【张三烟酒店】绑到【汾酒】品牌下，业务员【李四】。确认？"
5. 调 `POST /api/customers/{id}/brand-salesman`
   ```json
   { "brand_id": "...", "salesman_id": "..." }
   ```

**后果**：李四会在他的客户列表里看到张三烟酒店（RLS 放行）。

### 解绑

```
DELETE /api/customers/{customer_id}/brand-salesman/{brand_id}
```

解绑后该品牌下的业务员看不到这个客户。**但**不影响 Customer 本身，其他品牌绑定保留。

## Agent 分步：改客户

```
PUT /api/customers/{id}
```

只改基础字段（名字/电话/结算方式）。不改 CBS 绑定——走独立端点。

## 删客户

```
DELETE /api/customers/{id}
```

**有未完结订单会 400**。Agent 告诉用户"客户还有 N 个未完结订单，不能删除"。

## RLS 产生的"看得到但动不了"场景

业务员 A 绑到青花郎 + 五粮液，看到客户张三（通过 QHL 品牌绑定）。  
业务员 B 绑到汾酒，**看不到**张三。

A 执行 `PUT /api/customers/{张三 id}` 改电话 → 成功（A 能看到这客户）。  
但 A 能改全局的名字/电话，**影响 B 品牌的业务员**——这是业务设计：客户档案共享，业务关系按品牌隔离。

Agent 给用户改客户基础信息前**提示**："修改客户基础信息会影响所有绑定品牌的业务员视角，确认？"

## 常见错误

| detail | 解释 |
|---|---|
| "业务员创建客户必须指定 brand_id" | salesman 建客户时要传 brand_id |
| "业务员只能在自己绑定的品牌下建客户" | brand_id 不在 salesman 品牌范围 |
| "客户 XXX 还有未完结订单，不能删除" | 删之前先处理订单 |
| 404 "Customer not found" | 不在 RLS 可见范围 |

## 查询用的筛选字段

| 参数 | 说明 |
|---|---|
| `brand_id` | 按绑定品牌 |
| `salesman_id` | 按绑定业务员 |
| `keyword` | 模糊搜 name/code/contact_phone |
| `settlement_mode` | cash/credit |
| `customer_type` | channel/group_purchase |
| `status` | active/inactive |
