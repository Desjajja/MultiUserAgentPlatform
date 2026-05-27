# 辅助脚本（Agent 可直接执行）

Agent 调用 ERP 时重复的流程写成脚本，避免每次重写 curl / httpx 样板。

## 环境变量

所有脚本读这些 env：

```bash
ERP_BASE_URL=http://localhost:8000
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_AGENT_SERVICE_KEY=xxx          # ERP 端 X-Agent-Service-Key 共享密钥
```

## 脚本列表

| 脚本 | 场景 | 依赖 |
|---|---|---|
| `feishu_image_to_upload.py` | 飞书图片 → 下载 → POST 到 ERP uploads | httpx, FEISHU_* |
| `login_and_exchange.py` | open_id → ERP JWT（处理 404 绑定流程） | httpx |
| `preview_order.py` | 建单预览 | httpx, JWT |
| `fetch_approvals.py` | 聚合审批中心所有待审 | httpx, JWT |
| `match_policy.py` | 查建单时可选政策模板 | httpx, JWT |

## 用法

所有脚本既可以当 CLI 用（`python3 foo.py ...`），也可以 import 它们的函数到 Agent 自己的业务代码里。

### CLI 示例

```bash
# 飞书图片转发到 ERP uploads
python3 feishu_image_to_upload.py \
  --message-id om_xxx \
  --image-key img_xxx \
  --erp-jwt "<Bearer token>"

# 建单预览
python3 preview_order.py \
  --erp-jwt "<...>" \
  --customer-id cust-001 \
  --brand-id brand-001 \
  --settlement-mode customer_pay \
  --items '[{"product_id":"p1","quantity":5,"unit":"箱"}]'
```

### Import 示例

```python
from scripts.feishu_image_to_upload import feishu_image_to_erp

url = feishu_image_to_erp(message_id="om_xxx", image_key="img_xxx", erp_jwt="...")
# url = "/api/uploads/files/2026-04/uuid.jpg"
```

## 依赖

```bash
pip install httpx>=0.27
```

所有脚本都是纯 Python 3.10+ + httpx，**不依赖** Claude Code 特有的环境。可以部署到任何 Agent 运行环境。
