# 接入说明（手动操作清单）

> **⚠️ 本文件 Step 1 / 4 / 5 / 6 已废弃。**
>
> 原方案假设 `main` 通过 `exec` 调用本 skill 的 bridge.py，但 `main` 的 `exec` 工具在 openclaw.json 的 sandbox 里被 deny 了（dispatcher-only 安全模型），所以 main 永远无法触发本 skill。
>
> 当前 shadow 模式由 OpenClaw plugin 在 gateway 层 `before_dispatch` hook 处接管。**当前正确的接入流程见 `semantic_router/OBSERVER_PLAN.md`**。
>
> 下面 Step 0 / 2 / 3（前置检查、启动服务、模式与环境变量）依旧适用——服务本身的运行方式没变，变的只是"谁来调它"。

本文件给 Chris 看 — 不是 main 的 prompt 一部分。讲清楚启用 semantic-route 需要手动改哪几个地方、按什么顺序改、改完怎么验证。

---

## 0. 启用前的前置检查

```bash
openclaw skills list | grep semantic_route
```

如果看不到 `semantic_route`（注意是下划线，匹配 SKILL.md 的 `name` 字段），说明 skill 还没被注册到 `main` 的白名单，先做第 1 步。

---

## ~~1. 在 openclaw.json 把 skill 加到 main~~（已废弃）

> 本步骤基于"main 通过 exec 调用 bridge.py"的错误假设。main 的 sandbox deny 了 exec，加 skill 也无效。**请跳过到 OBSERVER_PLAN.md。**

---

## 2. 启动微服务

```bash
~/.openclaw/bin/semantic-router-serve
```

第一次会创建 venv、装依赖、下 BAAI/bge-small-zh-v1.5（约 100MB 到 `~/.cache/huggingface/`），耗时几分钟。后续启动是秒级。

**留它在前台跑**，或用下面的 launchd plist 后台化。

```xml
<!-- ~/Library/LaunchAgents/com.openclaw.semantic-router.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.openclaw.semantic-router</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/realityloop/.openclaw/bin/semantic-router-serve</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>SEMANTIC_ROUTER_MODE</key><string>shadow</string>
    <key>SEMANTIC_ROUTER_THRESHOLD</key><string>0.85</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/realityloop/.openclaw/logs/semantic-router.out.log</string>
  <key>StandardErrorPath</key><string>/Users/realityloop/.openclaw/logs/semantic-router.err.log</string>
</dict>
</plist>
```

加载：`launchctl load ~/Library/LaunchAgents/com.openclaw.semantic-router.plist`

> **注意 launchd + 局域网代理坑**（参见 memory `project_openclaw_launchagent_proxy_lan_block.md`）：如果以后服务要请求其他局域网 IP，需要在 plist 加 `NO_PROXY` 含 `192.168.*` 等。本服务只监听 127.0.0.1，本身不出网，但**模型首次下载需要外网**，所以首次启动建议用前台 shell 跑，等模型缓存好了再切 launchd。

验证：

```bash
curl http://127.0.0.1:7102/health
```

返回 `{"ok": true, ...}` 即可。

---

## 3. 选模式（环境变量）

| 变量 | 默认 | 含义 |
|------|------|------|
| `SEMANTIC_ROUTER_MODE` | `off` | `off` / `shadow` / `active` |
| `SEMANTIC_ROUTER_THRESHOLD` | `0.85` | active 模式下 fast-path 的最低 confidence |
| `SEMANTIC_ROUTER_AMBIGUITY_GAP` | `0.05` | top1 - top2 < 这个值就判为模糊 |

模式定义：

- **off**：服务可以查（用于人肉调试），但 main 完全不用，等于没装
- **shadow**：每条用户消息都会调一次，结果**只写日志不影响调度**，main 仍按原 DISPATCH.md 流程走
- **active**：confidence 够高且不模糊时直接 spawn，否则回退给 DISPATCH.md

改完重启服务：`launchctl unload ... && launchctl load ...` 或者前台 ctrl-C 重跑。

---

## ~~4. 改 main 的 prompt~~（已废弃）

> main 不能调 exec，改 prompt 也无用。**正确接入路径见 `semantic_router/OBSERVER_PLAN.md`** —— 通过 OpenClaw plugin 在 gateway 的 `before_dispatch` hook 处采集，跟 main 完全无关。

---

## ~~5. 验证 shadow 是否在采数据~~（已废弃）

> 验证步骤还是 `tail logs/semantic_router_shadow.jsonl`，但写入方是 plugin 而非 main 调 bridge。等 plugin 跑起来后这一节会迁到 OBSERVER_PLAN.md。

---

## ~~6. 灾难回滚~~（部分废弃）

服务级回滚仍然有效：把 launchd plist 里的 `SEMANTIC_ROUTER_MODE` 改成 `off` 后 reload，服务继续在线但 plugin 调它会拿到 `decision=off`，等于不影响。

未来 active 模式如果 plugin 通过 `before_dispatch` 短路 main，灾难回滚就是把 plugin 自己 disable —— 在 openclaw.json 的 `plugins.entries.semantic-router-observer.enabled` 改 `false` 然后重启 gateway。具体见 OBSERVER_PLAN.md。
