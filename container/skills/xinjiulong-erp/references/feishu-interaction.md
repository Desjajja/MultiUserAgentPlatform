# 飞书交互模式（所有操作必读）

Agent 跟用户的**所有**交互都走飞书。这个文件定义统一的交互套路，其他业务模块（orders/policies/…）直接复用。

## 第一次对话：绑定身份

用户第一次在飞书找 Agent 说话时，**Agent 必须先确认绑定**。

### 1.1 检查绑定

收到用户消息后，Agent 用当前用户的飞书 `open_id` 调：

```
POST {ERP}/api/feishu/exchange-token
Header: X-Agent-Service-Key: <FEISHU_AGENT_SERVICE_KEY>
Body:   { "open_id": "<用户 open_id>" }
```

- `200` → 拿到 `access_token`（15 分钟 TTL）+ `roles` + `user_id`，后续所有调用用这个 token
- `404` "open_id 未绑定或已解绑" → 进入绑定流程
- `403` "账号已停用" → 回复用户"你的账号已停用，请联系管理员"

### 1.2 引导绑定

Agent 推一张卡片让用户填 ERP 用户名密码：

```json
{
  "header": {"title": {"tag": "plain_text", "content": "绑定 ERP 账号"}},
  "elements": [
    {"tag": "form", "name": "bind_form", "elements": [
      {"tag": "input", "name": "username", "placeholder": {"tag": "plain_text", "content": "ERP 用户名"}},
      {"tag": "input", "name": "password", "input_type": "password",
       "placeholder": {"tag": "plain_text", "content": "密码"}},
      {"tag": "button", "text": {"tag": "plain_text", "content": "绑定"},
       "type": "primary", "action_type": "form_submit", "name": "submit"}
    ]}
  ]
}
```

收到 `card.action.trigger` 后 Agent 调：

```
POST {ERP}/api/feishu/bind
Header: X-Agent-Service-Key: <...>
Body:   { "open_id": "<用户 open_id>", "username": "...", "password": "..." }
```

成功后 `update_card` 改为"绑定成功，欢迎 {employee_name}"。

**Token 缓存**：Agent 为每个 open_id 缓存 exchange-token 返回的 JWT（10 分钟内复用，避免每次都换）。

## 接收用户发的图片

用户在飞书直接发图 → Agent 收到 `im.message.receive_v1` 事件，message 里有 `image_key`。

### 2.1 从飞书下载

```python
# 伪代码（见 scripts/feishu_image_to_upload.py 实际实现）
resp = feishu_api.get(f"/open-apis/im/v1/messages/{message_id}/resources/{image_key}?type=image")
image_bytes = resp.content  # binary
```

### 2.2 转发到 ERP uploads

```python
files = {'file': ('image.jpg', image_bytes, 'image/jpeg')}
headers = {'Authorization': f'Bearer {erp_jwt}'}
r = httpx.post(f"{ERP}/api/uploads", files=files, headers=headers)
url = r.json()['url']  # /api/uploads/files/YYYY-MM/<uuid>.jpg
```

**关键**：不要手工设 `Content-Type: multipart/form-data`，让 httpx/requests 自己加 boundary，否则 ERP 返回 400。

### 2.3 多张图

用户可能连续发多张。Agent 收集（比如等 30 秒静默后判定"传完"）再一次性用在下游调用。或者用 Form 卡片里的"上传凭证"按钮让用户分批上传后点"提交"明确结束。

## 确认动作卡片模板（所有写入操作通用）

**凡是要动数据的操作**，Agent 必须推卡片让用户按按钮确认，**不要**依赖用户打字"确认"。

```json
{
  "header": {"title": {"tag": "plain_text", "content": "确认<动作>"}, "template": "orange"},
  "elements": [
    {"tag": "div", "text": {"tag": "lark_md", "content":
      "**订单**：SO-xxx\n**客户**：张三烟酒店\n**金额**：¥27,000\n**模式**：客户按指导价付"
    }},
    {"tag": "action", "actions": [
      {"tag": "button", "text": {"tag": "plain_text", "content": "确认执行"},
       "type": "primary", "value": {"action": "confirm", "ctx_id": "<缓存键>"}},
      {"tag": "button", "text": {"tag": "plain_text", "content": "取消"},
       "type": "default", "value": {"action": "cancel", "ctx_id": "<缓存键>"}}
    ]}
  ]
}
```

### 3.1 ctx_id 机制

Agent 推卡片前先把**完整的执行参数**存到本地缓存（KV / Redis），key 是 `ctx_id`（随机 UUID）。卡片 button 的 `value.ctx_id` 带上。

用户点"确认执行" → 飞书回调 `card.action.trigger` → Agent 用 `ctx_id` 从缓存取参数，再调 ERP 接口。

**为啥要 ctx_id**：卡片 value 字段体积有限；把参数摘要放卡片文字里给用户看，执行细节放缓存里。

### 3.2 用户点"取消"

`update_card` 改卡片为"已取消"状态 + 禁用按钮。缓存里的 ctx_id 删掉。

### 3.3 卡片超时未操作

缓存 TTL 设 5-10 分钟。过期后用户再点按钮，Agent 回"操作已过期，请重新发起"。

## 操作结果卡片模板

执行成功后 `update_card`：

```json
{
  "header": {"title": {"tag": "plain_text", "content": "✅ 订单已建"}, "template": "green"},
  "elements": [
    {"tag": "div", "text": {"tag": "lark_md", "content":
      "**订单号**：SO-20260427091234\n**金额**：¥27,000\n**下一步**：[提交政策审批]"
    }},
    {"tag": "action", "actions": [
      {"tag": "button", "text": {"tag": "plain_text", "content": "立即提交审批"},
       "type": "primary", "value": {"action": "submit_policy", "order_id": "..."}}
    ]}
  ]
}
```

失败：

```json
{
  "header": {"title": {"tag": "plain_text", "content": "❌ 建单失败"}, "template": "red"},
  "elements": [
    {"tag": "div", "text": {"tag": "lark_md", "content":
      "**原因**：settlement_mode 必须为 customer_pay/employee_pay/company_pay\n**建议**：重新发起并明确结算模式"
    }}
  ]
}
```

**原样展示后端 detail，不要改写**。

## 长列表查询结果

超过 5 条的列表（订单、客户、政策兑付项）用卡片分页展示。每页 5 条 + "上一页 / 下一页"按钮。详细示例参见各模块文件。

## 表单卡片（收集多个字段）

建单、建客户这种要多字段输入的操作，用 Form 容器：

```json
{
  "elements": [{"tag": "form", "name": "create_order", "elements": [
    {"tag": "select_static", "name": "customer_id", "placeholder": "选择客户",
     "options": [{"text": {"tag": "plain_text", "content": "张三烟酒店"}, "value": "cust-001"}, ...]},
    {"tag": "select_static", "name": "settlement_mode", "placeholder": "结算模式",
     "options": [
       {"text": {"tag": "plain_text", "content": "客户按指导价付"}, "value": "customer_pay"},
       {"text": {"tag": "plain_text", "content": "业务员垫差额"}, "value": "employee_pay"},
       {"text": {"tag": "plain_text", "content": "公司让利"}, "value": "company_pay"}
     ]},
    {"tag": "input", "name": "cases", "input_type": "number",
     "placeholder": {"tag": "plain_text", "content": "箱数"}},
    {"tag": "button", "text": {"tag": "plain_text", "content": "预览金额"},
     "action_type": "form_submit", "name": "submit"}
  ]}]
}
```

**流程**：
1. 用户填表 → 提交
2. Agent 调 preview 拿金额
3. **update_card** 把表单改成"确认卡片"（展示预览 + 确认按钮，如 3.1 所述）
4. 用户点确认 → Agent 真建单

**不要**让用户填一次就直接建单——preview + 确认是两步。

## 错误时的回复

| 场景 | Agent 说法 |
|---|---|
| 没绑定（404 exchange-token） | 推绑定卡片 |
| 账号停用（403 exchange-token） | "你的账号已停用，请联系管理员" |
| RLS 挡住（某订单 404） | "找不到该订单，可能不在你权限范围内" |
| 业务校验 400 | 原样引用后端 `detail` |
| 网络/500 | "系统暂时有问题，稍后再试。要继续操作吗？" |
| 用户说话 Agent 听不懂 | "没太听懂。你可以说：建单 / 查订单 / 上传凭证 / …" |

## 所有按钮 action 类型汇总

Agent 在卡片 button 的 `value.action` 约定这些 action 类型（本 skill 全局用）：

| action | 含义 | 对应 ERP 端点 |
|---|---|---|
| `bind` | 绑定 ERP 账号 | POST /api/feishu/bind |
| `confirm` | 确认一个待执行动作（结合 ctx_id） | 各业务端点 |
| `cancel` | 取消确认流程 | 无 |
| `create_order` | 创建订单 | POST /api/orders |
| `submit_policy` | 提交订单政策审批 | POST /api/orders/{id}/submit-policy |
| `upload_voucher` | 上传收款凭证 | POST /api/orders/{id}/upload-payment-voucher |
| `confirm_payment` | 财务批准收款（审批中心） | POST /api/orders/{id}/confirm-payment |
| `reject_payment` | 财务拒绝收款 | POST /api/orders/{id}/reject-payment-receipts |
| `approve_policy` | boss 批准政策 | POST /api/orders/{id}/approve-policy |
| `list_next_page` | 列表翻页 | - |
| ... | 各业务模块自行定义 | - |

新增业务动作时扩展本表。

## 推送审批通知（Agent 主动找人）

ERP 发 `POST /api/notifications` 或通过 webhook 让 Agent 主动推消息给特定员工：

- 待审凭证 → 推送给所有 finance/boss 角色
- 政策审批 → 推送给 boss
- 工资审批 → 推送给 hr/boss

通知卡片里带"直接批准 / 打开详情"按钮，不用用户先打字唤起 Agent。

详细的推送触发点在各业务模块里标注。

## 安全

- **exchange-token 的 X-Agent-Service-Key** 存在环境变量 `FEISHU_AGENT_SERVICE_KEY`，Agent 不要写死在代码里
- 用户的 **ERP JWT** 缓存在内存（或 Redis），不持久化；**过期重新 exchange**
- 业务员在飞书说"把所有客户导出给我"——如果 Agent 的 JWT 是 salesman 角色，RLS 自动限制返回范围，不需 Agent 额外过滤
- **不要把 JWT 发给用户看**，log 里也要脱敏
