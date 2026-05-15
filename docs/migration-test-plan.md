# OpenClaw → FrontLane 迁移测试方案

> 对应任务表：`OpenClaw_任务规划表.xlsx`（4/24 制定）。
> 本文档覆盖 14 个任务的端到端验收，以及 6 个本轮修复的回归测试。
> 测试目标：跑完一遍能回答 "可以上演示了吗？" 这个问题。

---

## ⚡ 当下可执行清单（2026-05-15 现场情况）

**当前后端可达性**：只有本地 `localhost:7001`（RAG + lab-db）通。所有远程内网后端（移液 / 图像 / Windows B / 远程 MQTT broker / 摄像头 PPE 推送 / 机械臂）都**没通**。公网（semantic-scholar / arxiv / duckduckgo / Feishu API）按需测。

### ✅ 现在就能完整测的（不依赖远程）

| 用例 | 类型 | 跑测耗时 |
|---|---|---|
| Task 1 — 打招呼 | frontdesk 自答 | 30s |
| Task 2 — 介绍职责 | frontdesk 自答 | 30s |
| Task 5 — 实验路线 | 纯 LLM 生成 → knowledge-worker | 1 min |
| Task 9 — PPE OK 短确认 | frontdesk 自答 | 30s |
| Task 13 — 分析实验结果（多模态） | 用本地 jpg 喂 → labops-worker | 2 min |
| Fix R1 — PPE webhook handler | curl 自测 5 个状态码 | 2 min |
| Fix R2 — analyze-result skill 加载 | 容器 spawn 后看 prompt | 1 min |
| Fix R3 — frontdesk 路由 + PPE OK 模板 | 7 个触发词/反例 | 5 min |

**8 项小计约 15 分钟跑完。** 这一批最有价值：能验证本轮 11 处代码修改的正确性，且不依赖任何远程后端。

### 🟡 依赖 `localhost:7001` 后端（用户已说通，但要先 curl 自检）

先验后端：
```bash
curl http://localhost:7001/api/health 2>&1 | head -3       # RAG 健康
curl http://localhost:7001/api/experiments/ingest -X POST \
  -H 'Content-Type: application/json' -d '{}' 2>&1 | head -3   # lab-db 是否实现 experiments endpoint
```

`/api/experiments/ingest` 如返回 4xx with "missing field"——OK，endpoint 存在。如返回 404——lab-db 部分未实现。

后端确认 OK 后可测：

| 用例 | 备注 |
|---|---|
| Task 3 — 查热点 + 入 RAG | 前置需公网通到 api.semanticscholar.org / export.arxiv.org / duckduckgo |
| Task 6 — 实验卡片 | 依赖 `/api/experiments/ingest` |
| Task 14a — 数据存档 | 依赖 ingest + `/api/knowledge/upload`；端到端跑完 + 容器内 `ls /workspace/agent/archives/` 验 Fix R4 |
| Fix R4 — experiment-archive 路径 | 上一项的副产物 |

### 🟠 webhook handler 单元可测，端到端 trigger 需后端配合

| 用例 | 当下能做 | 当下做不了 |
|---|---|---|
| Task 8 — PPE webhook | 用 curl 模拟摄像头后端发 POST（5 个状态码全测）→ 验证 host 收到后能把 inbound 投到 monitor-worker | 等摄像头后端真接 webhook，**且需要用户告诉后端 endpoint = `http://<host>:3000/webhook/ppe-alert` + payload schema** |
| Task 7c — voice MQTT | 如果远程 broker 不可达，**临时本地起一个 mosquitto**：`brew install mosquitto && mosquitto -p 1883` → 设 `MQTT_BROKER_URL=mqtt://localhost:1883` `MQTT_TOPICS=voice/cmd` → `mosquitto_pub -t voice/cmd -m '开始实验'` 测整条链路 | 远程 broker 真打通 |

### ❌ 暂时跑不了（等远程后端）

| 用例 | 依赖后端 |
|---|---|
| Task 4 — 送包 | 远程 MQTT broker + 底盘机 |
| Task 7a — 灵巧手 + 末端 | MQTT broker + 设备 |
| Task 7b — 健康检查 | 移液 pipeline `192.168.66.154:8008` |
| Task 10 — 发送图像 | 图像后端 `192.168.66.31:8000` |
| Task 11 / 12a — 移液 | pipeline 同上 |
| Task 12b — IC 实验 | Windows B `192.168.66.246:8000` |
| Task 14b — 汇报张震 | 需用户给 open_id 且确认 Feishu API 通 |
| Fix R5 / R6 端到端 | 远程 pipeline / MQTT broker |

**这些可以现在做的是 grep 验证**（确保代码层 rename 干净）：

```bash
grep -rn "/Users/realityloop" container/skills/remote-liquid-exec/   # R5: 应 0 hit
grep -rn "openclaw_pub" container/skills/chassis-move/                 # R6: 应 0 hit
grep -rn "openclaw" container/skills/experiment-archive/               # R4 残留: 应 0 hit
```

---

## 0. 测试前置

### 0.1 环境变量

宿主机 `.env`（或导出到 shell）：

| 变量 | 必填 | 用途 |
|---|---|---|
| `MQTT_BROKER_URL` | demo 上 voice/底盘话题用 | host 端 MQTT inbound |
| `MQTT_TOPICS` | 同上 | 订阅清单（逗号分隔），至少含 voice topic 和 `semantic_nav/ack` |
| `MQTT_USERNAME` / `MQTT_PASSWORD`（或 `EMQX_PASSWORD`） | 是 | broker 凭证 |
| `MQTT_TARGET_PLATFORM_ID` | 是 | inbound 落到哪个 platform_id（路由给 robot-worker / monitor-worker） |
| `PPE_WEBHOOK_TARGET_PLATFORM_ID` | 是 | PPE webhook inbound 落到哪个 platform_id（路由给 monitor-worker） |
| `PPE_WEBHOOK_SHARED_SECRET` | 可选 | 摄像头后端调 webhook 时带 `x-ppe-secret` 头；未设则不校验 |
| `OPENAI_API_KEY` / `CLAUDE_API_KEY` | 至少一个 | provider 选用对应 key（labops-worker 默认 openai） |
| `RAG_BASE_URL` | 任务 3/14a | 默认 `http://localhost:7001`，需此服务起着 |
| `LARK_*` | 任务 14b | lark-cli 已 bake 进 image (commit 8a825c5)，授权 token 单独配 |

### 0.2 依赖后端

| 服务 | 用途 | 测试前自检命令 |
|---|---|---|
| 移液 pipeline `192.168.66.154:8008` | 任务 11/12a | `curl http://192.168.66.154:8008/health` |
| Windows B `192.168.66.246:8000` | 任务 12b | `curl http://192.168.66.246:8000/health` |
| 图像后端 `192.168.66.31:8000` | 任务 10 | `curl http://192.168.66.31:8000/api/v1/cameras` |
| MQTT broker `x2219abf.ala.cn-hangzhou.emqxsl.cn:8883` | 任务 4/7c | `mosquitto_sub -h x2219abf.ala.cn-hangzhou.emqxsl.cn -p 8883 -u emqx -P $EMQX_PASSWORD -t 'semantic_nav/#' --capath /etc/ssl/certs/` |
| 语音 7000 后端 | 任务 7c | `curl http://localhost:7000/health`（用户已通） |
| 摄像头 PPE 推送后端 | 任务 8 | 待用户给出 endpoint |
| RAG `:7001` | 任务 3/14a | `curl http://localhost:7001/api/health` |

### 0.3 平台启动

```bash
pnpm install
pnpm build           # 必须先 build；新加的 ppe-webhook channel 走 tsc
pnpm dev             # 或 pnpm start
```

启动后 grep log：
- `MQTT channel connected` 出现 → MQTT inbound 已通
- `PPE webhook channel ready` 出现 → PPE webhook 已注册
- `Webhook server started` 出现 → HTTP listener 起来（默认 3000，或 `WEBHOOK_PORT`）

### 0.4 通用通过判据

每个用例都按这个对照看：
1. **frontdesk 立刻发"已收到：…"** 确认消息（CLAUDE.local.md 步骤 1，不可跳）
2. **frontdesk 派发到正确 worker**（在 `messages_out` 表看 `a2a-*` 流向）
3. **worker 调用正确 skill**（`outbound.db.trace_spans` 里看 skill 名）
4. **结果返回 frontdesk 后被翻译**（不是把 worker 原文直接转发）
5. **附件类输出走 `send_file`**（用 `[file: ... — saved to ...]` 触发）

---

## 1. 14 个任务测试用例

### Task 1 — 打招呼

| 项 | 内容 |
|---|---|
| Trigger | 用户发 "你好啊"（或任意打招呼短语） |
| 期望路径 | frontdesk 命中固定回复模板 → **不派发任何 worker** |
| 期望输出 | "你好，我是 FrontLane Desk，企业 ERP 助手的前台。有什么需要帮助的？" |
| 通过判据 | `messages_out` 只有 frontdesk 一行回复，无 a2a 派发 |
| 缺口 | 措辞与原计划的"小环"IP 不同，如需保留旧 IP 单独改 frontdesk CLAUDE.local.md |

### Task 2 — 介绍职责

| 项 | 内容 |
|---|---|
| Trigger | "你能做什么" / "你是谁" / "介绍一下" |
| 期望路径 | frontdesk 命中自我介绍模板 |
| 期望输出 | 列出 13 个 worker 的简介 |
| 通过判据 | 同 Task 1，无 a2a |

### Task 3 — 查热点 + 入 RAG

| 项 | 内容 |
|---|---|
| Trigger | "帮我查一下最新的科研热点，将与我们有关的记录到 RAG 知识库中，方向是 AI+环境" |
| 期望路径 | frontdesk → knowledge-worker。worker 内 先 `semantic-scholar`，兜底 `arxiv`、`websearch`；整合后调 `rag-upload` |
| 期望输出 | 整合的 markdown 文件（标日期）+ RAG upload 完成回执 |
| 通过判据 | (a) `trace_spans` 里依次出现 3 个搜索 skill 的 LLM call；(b) `POST /api/knowledge/upload` 命中 RAG（log 或 RAG 后端确认）；(c) frontdesk 把"已入库"和 md 文件路径回给用户 |
| 缺口 | knowledge-worker 决策树是否有 "整合成 md 文件上传" 的明确逻辑；如果 worker 输出散，需在 `frontlane-knowledge-worker/CLAUDE.local.md` 补一条"整合策略" |

### Task 4 — 送包（底盘）

| 项 | 内容 |
|---|---|
| Trigger | "先将包送到东航老师办公室" |
| 期望路径 | frontdesk → robot-worker → `chassis-move` skill → MQTT publish `semantic_nav` |
| 期望输出 | "MQTT publish 成功，等待底盘 ack" |
| 通过判据 | (a) MQTT broker 上 `semantic_nav` topic 收到目标 label；(b) `semantic_nav/ack` topic 收到后底盘机执行；(c) frontdesk 转告 ack 给用户 |
| 缺口 | `semantic_points.yaml` 里的标签得有 "东航办公室"——目前 SKILL.md 只列了 door/lab_table。需要用户先把 semantic_points.yaml 补全或确认 label |

### Task 5 — 实验路线

| 项 | 内容 |
|---|---|
| Trigger | "给出 CO2 创新提取锂的实验路线" |
| 期望路径 | frontdesk → knowledge-worker（按修复后的 routing） |
| 期望输出 | knowledge-worker 用 LLM 生成 3 条路线（JSON 或表格） |
| 通过判据 | 输出含 ≥3 条路线、每条带步骤；不调任何 search skill 也不调 RAG（纯生成） |
| 缺口 | 当前 frontdesk 路由表把"实验路线"派给了 knowledge-worker，但 knowledge-worker 默认会去查 arxiv。如果实测发现 worker 先去搜文献了，需在 `frontlane-knowledge-worker/CLAUDE.local.md` 加一条："收到'生成实验路线'类请求 → 直接 LLM 生成 3 条，不调搜索 skill" |

### Task 6 — 生成实验卡片

| 项 | 内容 |
|---|---|
| Trigger | （在 Task 5 之后）"我选路线 1，生成实验卡片" |
| 期望路径 | frontdesk → labops-worker → `experiment-card` + `lab-db` |
| 期望输出 | 8 字段 JSON（exp_id / created_at / title / route / params / status=planned / operator / notes）+ lab-db ingest 回执 |
| 通过判据 | `lab-db` 对应表里看到一行 `status=planned`；frontdesk 把 exp_id 回告用户 |
| 缺口 | lab-db endpoint 必须配（默认 `http://localhost:7001/api/experiments/ingest`） |

### Task 7a — 开始实验（灵巧手 + 末端）

| 项 | 内容 |
|---|---|
| Trigger | "开始实验" |
| 期望路径 | frontdesk → robot-worker → `robot-hand` + `robot-pipette` |
| 期望输出 | 两个 skill 各自的 MQTT 下行命令 + 反馈 |
| 通过判据 | MQTT broker 上看到两个独立 topic 的 publish；ack 回到 worker |
| 缺口 | 灵巧手/末端的 MQTT topic、payload 格式 — SKILL.md 应该已带（commit 8f7790d），但实测时需要看 broker 是否实际响应。如果设备不在线，需 mock 一个 MQTT subscriber 模拟 ack |

### Task 7b — 健康检查

| 项 | 内容 |
|---|---|
| Trigger | "开始实验前先做个健康检查" |
| 期望路径 | frontdesk → robot-worker → `remote-liquid-exec health`（复用，移液 pipeline `192.168.66.154:8008/health`） |
| 期望输出 | "pipeline 健康，可继续" / "pipeline 离线，建议联系运维" |
| 通过判据 | `remote_liquid_exec.py health` 返回 0 / 非 0 被翻译给用户 |
| **若机械臂本身要独立 health**（用户原计划意图）| **需后端补 endpoint**。Prompt 给后端的：<br>"请加一个机械臂自检 endpoint，期望：`GET http://<机械臂 ip>:<port>/health` 返回 `{ status: 'ok'\|'degraded'\|'down', subsystems: { motors:..., gripper:..., camera:... }, last_error: ... }`，超时 3s。我们 FrontLane 会在'开始实验'前调用这个端点；调不通 / 任何 subsystem≠'ok' 就要求用户人工确认才继续。" |

### Task 7c — voice MQTT 监听

| 项 | 内容 |
|---|---|
| Trigger | 用户对着语音设备说"开始实验"，7000 后端识别后 publish 到约定 MQTT topic（如 `voice/cmd`） |
| 期望路径 | host MQTT channel 收到 → onInbound 投到 `MQTT_TARGET_PLATFORM_ID` → 路由到 frontdesk（语音 platform 应绑 frontdesk）→ 按文字消息走 Task 7a/4/等 |
| 期望输出 | frontdesk 像收到文字消息一样响应 |
| 通过判据 | (a) host log 出现 `MQTT subscribed` 含 voice topic；(b) 模拟一条 publish (`mosquitto_pub -t voice/cmd -m '开始实验'`) 后 1s 内 frontdesk 发"已收到：开始实验"确认 |
| 缺口 | `MQTT_TOPICS` 要包含 voice topic；`agent_destinations` 表里 `MQTT_TARGET_PLATFORM_ID` 要绑到 frontdesk |

### Task 8 — 被动 PPE 告警（webhook 推送，本轮新加）

| 项 | 内容 |
|---|---|
| Trigger | 摄像头后端 POST `http://<host>:3000/webhook/ppe-alert` JSON |
| 期望路径 | webhook handler → onInbound → 路由到 monitor-worker → 触发 `ppe-alert` skill → frontdesk 翻译 → 发飞书红色卡片 |
| Curl 自检命令 | <pre>curl -X POST http://localhost:3000/webhook/ppe-alert \\<br>  -H 'Content-Type: application/json' \\<br>  -H 'x-ppe-secret: $PPE_WEBHOOK_SHARED_SECRET' \\<br>  -d '{"alert_type":"no_lab_coat","camera_id":"lab-cam-1","detected_at":"2026-05-15T09:12:34Z","snapshot_url":"http://192.168.66.31/snapshots/abc.jpg","confidence":0.92,"notes":"operator at bench 3"}'</pre> |
| 期望响应 | `202 { ok: true, id: "ppe-..." }` |
| 通过判据 | (a) 收到 202；(b) `messages_in` 表里 platform_id=`$PPE_WEBHOOK_TARGET_PLATFORM_ID` 多一行 ；(c) monitor-worker 容器被 wake；(d) 飞书会话里出现 ppe-alert 卡片 |
| 失败用例 | (e) 去掉 `x-ppe-secret` → 期望 401；(f) 发非 JSON body → 期望 400；(g) >64KB body → 期望 413；(h) GET 方法 → 期望 405 |
| 缺口 | `agent_destinations` 必须把 `$PPE_WEBHOOK_TARGET_PLATFORM_ID` 绑到 monitor-worker。需要 init 脚本时手动 INSERT 或 pnpm 一条命令 |

### Task 9 — PPE OK 短确认（本轮新加 frontdesk 模板）

| 项 | 内容 |
|---|---|
| Trigger | 用户消息**整体**等于 "PPE OK"（去空白、不分大小写） |
| 期望路径 | frontdesk 命中固定回复 → **不派发任何 worker** |
| 期望输出 | "已确认 PPE，解除暂停。可以继续。" |
| 通过判据 | `messages_out` 仅 frontdesk 一条；ppe-recheck skill **未** 被触发 |
| 反例 | 用户发 "PPE OK，下一步是什么" → **不**命中（含其他内容） → 应走正常路由（可能派 labops/robot） |
| 反例 | 用户发 "请重新检测 PPE" → 派 monitor-worker → `ppe-recheck` skill 走多模态复检 |

### Task 10 — 发送图像

| 项 | 内容 |
|---|---|
| Trigger | "发送三号台的图像给我" |
| 期望路径 | frontdesk → monitor-worker → `image-fetch` skill → HTTP `GET 192.168.66.31:8000/api/v1/cameras/cam2/snapshot` → 文件落 `/workspace/inbox/...` |
| 期望输出 | worker reply 带 `[file: snapshot.jpg — saved to <abs_path>]` → frontdesk `send_file` 发给用户 |
| 通过判据 | 飞书消息出现一张 JPEG；frontdesk 同会话也 send_message 一句文字说明 |
| 缺口 | "三号台" 到 `cam2` 的映射在 image-fetch SKILL.md 里要有；如果用户说"3 号台"/"台 3" 也要命中（检查映射表覆盖度） |

### Task 11 — 移液（烧杯到试管）

| 项 | 内容 |
|---|---|
| Trigger | "开始采样，从烧杯采样到试管 1 至 6 中进行排空" |
| 期望路径 | frontdesk → robot-worker → `remote-liquid-exec` skill → `POST 192.168.66.154:8008/api/pipette/start` 默认参数 task_count=4 |
| 期望输出 | "采样任务已提交，task_count=4，预计 X 分钟" + 完成后的"移液完成/失败" |
| 通过判据 | pipeline 后端 log 看到 start + 终态返回；frontdesk 转告 |
| **注意** | 用户说 "1 至 6 试管" → task_count=6；如果默认 4 不匹配用户意图，**worker 应走路径 B（拆解-确认）** 而不是默认提交。验收时确认 worker 没硬塞 4 |
| 缺口 | 修复后路径已改用 `{baseDir}/scripts/remote_liquid_exec.py`，需确认 container 内 `{baseDir}` 展开正确（可在容器内 `ls $baseDir/scripts/remote_liquid_exec.py` 自检） |

### Task 12a — 转移至离子色谱

| 项 | 内容 |
|---|---|
| Trigger | "将样本转移至离子色谱仪" |
| 期望路径 | 同 Task 11（复用 pipeline） |
| 通过判据 | pipeline 后端能区分这个任务（target=ic）—— **用户回复确认"不需要考虑其他事情，直接调 pipeline"**，所以接受统一 endpoint |

### Task 12b — IC 实验自动化（Chromeleon SOP）

| 项 | 内容 |
|---|---|
| Trigger | "按照我们的方法完成离子色谱实验" |
| 期望路径 | frontdesk → 走 **业务执行类** 二次确认模板（CLAUDE.local.md 第 76 节）→ 用户回复"确定执行" → frontdesk → remote-worker → `win-remote-control` skill 跑 28 步 SOP |
| 期望输出 | Step 1 → Step 28 顺序执行，每步发一条进度（"Step N: <动作>, OK"） |
| 通过判据 | (a) 没有跳步（看 SOP 输出的 step 编号是否 1→28 连续）；(b) Windows B 上 Chromeleon UI 真的有 click 命中（coords 92% 已校准，剩 Step 21 + 25 demo 当天补）；(c) 任何 step 失败，worker 停下报告，不硬跑 |
| 风险点 | win-remote-control 是 **业务执行类**，frontdesk **必须** 走二次确认。如果实测 frontdesk 没走确认就派发 → 修 frontdesk 触发词识别 |

### Task 13 — 分析实验结果（本轮新加 skill）

| 项 | 内容 |
|---|---|
| Trigger | "看看实验结果有什么问题"（同会话之前应有图被 frontdesk 投到 worker inbox） |
| 期望路径 | frontdesk → labops-worker → `analyze-result` skill（LLM 多模态看图）|
| 期望输出 | 5 维度结构化输出（类型 / 观察 / 对比预期 / 异常诊断 / 建议）|
| 通过判据 | (a) labops-worker 容器读到 inbox 里的图文件；(b) provider 是多模态 model（OpenAI gpt-4o / claude sonnet）；(c) 输出含"低置信度"标记当看不清时 |
| 反例 | 用户没贴图就发"看看结果" → 期望 worker 回 status=failed "没看到附件" |
| 反例 | 用户给历史 exp_id "跟 EXP-20260514-001 比" → 期望 worker 先查 lab-db 拿历史，再多模态对比，输出"差异表" |
| 缺口 | labops-worker.provider="openai" 已设置；需要确认实际 model 是 gpt-4o（支持多模态）而非 gpt-4-turbo-text-only。看 `container/agent-runner/src/providers/openai.ts` 的 model env 配置 |

### Task 14a — 数据存档

| 项 | 内容 |
|---|---|
| Trigger | （Task 12b 完成后）"数据存档" |
| 期望路径 | frontdesk → labops-worker → `experiment-archive` skill → 三处存储 |
| 期望输出 | 一份"存档明细"列出三处状态：<br>1. lab-db ingest（status=finished）<br>2. `/workspace/agent/archives/{exp_id}/raw/` 拷贝<br>3. RAG upload + `/workspace/agent/archives/{exp_id}/summary.md` 双写 |
| 通过判据 | container 内 `ls /workspace/agent/archives/{exp_id}/` 看到 `raw/` + `summary.md`；lab-db 行 status=finished；RAG 后端能搜到 |
| 修复验证 | 路径已从 `~/.openclaw/workspace-exec-labops/` 改成 `/workspace/agent/archives/`，**这是 container 内路径**（host 上看不到，要 docker exec 进 container 看）|

### Task 14b — 汇报张震

| 项 | 内容 |
|---|---|
| Trigger | （同会话）"并汇报给张震" |
| 期望路径 | frontdesk → feishu-comm-worker → `lark-im` skill → 发飞书消息给张震 |
| 期望输出 | 张震的飞书会话收到一条结构化消息（实验 id / 时间 / 结果 / 异常） |
| 通过判据 | 张震客户端确实收到 |
| 缺口（必填） | (a) 张震的 `open_id` / `user_id` — **用户需提供**；(b) 汇报消息模板 — 建议格式见下方 |

**建议汇报消息模板**（用户审）：
```
📊 实验汇报 / {exp_id}
━━━━━━━━━━━━━━━━━━
标题：{title}
路线：{route}
时间：{started_at} → {finished_at}
操作者：{operator}
状态：{ok ✅ / partial 🟡 / failed ❌}

关键结果：{从 summary.md 抽取 2-3 条 bullet}
异常：{有 → 列出；无 → "无异常"}
归档：{archives 路径}

—— FrontLane LabOps 自动汇报
```

---

## 2. 本轮修复回归测试

### Fix R1 — PPE webhook handler

| 检查项 | 命令 / 步骤 | 期望 |
|---|---|---|
| 启动 log | `grep "PPE webhook channel ready" logs/frontlane-*.log` | 出现一行，含 `path=/webhook/ppe-alert` |
| 200 POST | 上 Task 8 的 curl | 202 + JSON `{ok:true,id}` |
| 401 反例 | 同样 POST 去掉 `x-ppe-secret` | 401 Unauthorized |
| 400 反例 | POST body 不是 JSON | 400 Bad JSON |
| 413 反例 | POST body 超 64KB | 413 |
| 405 反例 | `curl GET /webhook/ppe-alert` | 405 |
| 未配 env | 不设 `PPE_WEBHOOK_TARGET_PLATFORM_ID` 启动 | log 不出现 "PPE webhook channel ready"，channel 静默跳过 |

### Fix R2 — analyze-result skill

| 检查项 | 步骤 | 期望 |
|---|---|---|
| skill 加载 | spawn labops-worker container 后看 system prompt | 含 `## When to trigger` 段（来自 instructions.md） |
| 触发词 | 用户发 "分析下这张图" + 附 jpg | dispatch 到 labops-worker，trace_spans 里 skill=analyze-result |
| 多张图 | 用户附 2 张图 | 输出 2 段独立分析 + 1 段综合结论 |
| 无图 | 用户发 "看看结果" 无附件 | worker 回 status=failed text 含"没看到附件" |

### Fix R3 — frontdesk 路由 + PPE OK

| 检查项 | 步骤 | 期望 |
|---|---|---|
| RAG 写入关键词 | "记录到 RAG" → | 派 knowledge-worker（不再被识别为搜索） |
| 实验路线关键词 | "给出 X 的实验路线" → | 派 knowledge-worker |
| 实验结果分析关键词 | "分析这张图" → | 派 labops-worker（不是 monitor-worker） |
| PPE OK 整匹配 | "PPE OK" → | 不派发，回固定回复 |
| PPE OK 部分匹配（反例） | "PPE OK，下一步" → | **不**命中固定回复，正常路由 |
| 不区分大小写 | "ppe ok" / " PPE  OK " | 均命中 |
| 复检 | "请重新检测 PPE" → | 派 monitor-worker，触发 ppe-recheck（**不**走 frontdesk 短回复） |

### Fix R4 — experiment-archive 路径

| 检查项 | 步骤 | 期望 |
|---|---|---|
| 全文 grep | `grep -r openclaw container/skills/experiment-archive/` | 0 hit |
| 容器内 mkdir | 跑一次 Task 14a，然后 `docker exec <labops-cid> ls /workspace/agent/archives/` | 看到 `{exp_id}/raw/` + `{exp_id}/summary.md` |
| 垃圾文件 | `ls container/skills/experiment-archive/` | 不再有 `SKILL.md.pre-quote-fix` |

### Fix R5 — remote-liquid-exec 路径

| 检查项 | 步骤 | 期望 |
|---|---|---|
| 全文 grep | `grep -n "/Users/realityloop" container/skills/remote-liquid-exec/` | 0 hit |
| 容器内自检 | `docker exec <robot-cid> ls /workspace/agent/skills/remote-liquid-exec/scripts/remote_liquid_exec.py` | 文件存在 |
| 实测 Task 11 | "开始采样" | exec 调用 `{baseDir}/scripts/remote_liquid_exec.py start --task-count 4` 成功（无 "complex interpreter invocation detected" 报错） |

### Fix R6 — chassis-move client_id

| 检查项 | 步骤 | 期望 |
|---|---|---|
| 全文 grep | `grep -rn "openclaw_pub" container/skills/chassis-move/` | 0 hit |
| 跑 Task 4 | broker `$SYS/sessions/...` topic 看 client id | `frontlane_chassis_pub_<hostname>_<pid>` |
| 不冲突 | 同时跑多次 publish | 每次 client id 都唯一（pid 不同） |

---

## 3. 推荐跑测顺序

按依赖关系排：

```
Phase 1（无外部依赖，5 分钟搞完）：
  Task 1 → 2 → 9（PPE OK）→ Fix R3（路由关键词）

Phase 2（有 LLM、无硬件，10 分钟）：
  Task 5（实验路线）→ Task 13（多模态分析，用本地 jpg 喂图）→ Fix R2

Phase 3（依赖 RAG / lab-db）：
  Task 3（查热点入 RAG）→ Task 6（实验卡片）→ Task 14a（数据存档）→ Fix R4

Phase 4（依赖硬件 / 远程后端）：
  Task 7b（health）→ Task 10（图像）→ Task 11（移液）→ Task 12a → Fix R5

Phase 5（高风险、完整流程）：
  Task 4（送包，MQTT 真发）→ Task 7a（开始实验，机械手实动）→ Task 12b（IC SOP，Windows B 实动）→ Fix R6

Phase 6（生产推送、外部 trigger）：
  Task 7c（voice MQTT）→ Task 8（PPE webhook）→ Fix R1 → Task 14b（飞书汇报）
```

每个 Phase 跑完先排查 log/数据再进下一阶段，避免后阶段失败回头查不出根因。

---

## 4. 已知风险

1. **`groups/` 目前在 `.gitignore`** — fresh checkout 上拓扑会丢。**修复前请先把 `groups/` 移出 gitignore 或 commit 一份 skeleton**，否则换台机器测就全空。
2. **migrations 023/024 source 文件未 track** — 同上，fresh checkout 跑 `pnpm dev` 会因为 import 不到而崩。
3. **labops-worker 的 provider model** 默认 `openai`，但要确认实际选的是 gpt-4o（多模态）。Task 13 依赖这一点。
4. **win-remote-control coords** 92% 校准，Step 21 + Step 25 待 demo 当天补 —— Task 12b 跑到这两步会 fail，预期内。
5. **MQTT host adapter 是 subscribe-only** — Task 4 发 publish 必须靠 container 内 paho-mqtt 直发，不走 host channel。
6. **PPE webhook 当前 bind `0.0.0.0`** — 见 review 报告 P0；上生产前要加 IP allowlist 或 bearer token，并把 `WEBHOOK_PORT` 暴露收敛。

---

## 5. 不在本测试方案覆盖范围内

- 并发 / 性能压测（见 `perf-benchmark-runbook.md`）
- 多用户 session 隔离（见 `docs/isolation-model.md`）
- ERP gateway HMAC / 审计（见 `docs/enterprise-erp-gateway.md`）
- 容器异常恢复（见 `perf-results-raw-v2-fault.json`）
- 长会话 F2 回归（见 `perf-results-raw-v2-long.json`）
