---
name: semantic_route
description: "Step-0 路由预判。在用户消息进入 dispatcher 决策之前调用：把用户输入做向量检索，返回最匹配的 sub-agent + 置信度。触发条件：每条新进的用户消息都先问一次，再决定走 fast-path 还是回退到原 DISPATCH.md 流程。失败时会优雅降级（confidence=0），可以无缝回退。"
metadata:
  openclaw:
    emoji: "🧭"
---

> **当前状态：未启用，保留作为未来 active mode 的储备。**
>
> 原设计假设 `main` 通过 `exec` 调用本 skill 的 `bridge.py`，但 OpenClaw 出于安全模型把 `main` 的 `exec/process/browser/web_fetch/curl` 全部 deny 了（参见 `~/.openclaw/openclaw.json` 中 `agents.list[0].tools.sandbox.tools.deny`）。所以本 skill 现阶段无法被 `main` 调用。
>
> shadow 模式现在由 OpenClaw plugin 在 gateway 层接管：plugin 监听 `before_dispatch` 事件，HTTP POST 到 127.0.0.1:7102/route，把决策写入 `logs/semantic_router_shadow.jsonl`。详见 `semantic_router/OBSERVER_PLAN.md`。
>
> active mode（直接短路 `main` 的 LLM 决策）将来如果要做，可走以下两条路任一：
>   1. 同一 plugin 在 `before_dispatch` 处返回 `{handled: true, text: ...}`（plugin SDK 支持，见 OBSERVER_PLAN.md 6 节修订）；
>   2. 把本 skill 接到 `exec-router` 这种 exec-capable 的小 agent，由 `main` 通过 `sessions_spawn` 调用——这条路目前不需要做。
>
> 文件保留是因为 bridge.py 的 graceful-degrade 行为已经测过，未来若选第二条路它仍然有效；当前 shadow 阶段不会被触发。

# Semantic Route — 调度前置语义路由

向 `127.0.0.1:7102` 上的 semantic-router 微服务做一次向量检索，返回 top-1 / top-3 sub-agent 候选 + 置信度。**只做检索，不替换 dispatcher 决策。** 决策由 `main` 自己根据返回的 confidence + is_unambiguous + 当前模式做出。

## 启动服务

服务必须先用 `bin/semantic-router-serve` 启起来，监听 127.0.0.1:7102。如果服务未启动，本 skill 会返回 `confidence=0` 让 `main` 直接走原 DISPATCH.md 流程，**不会阻塞调度**。

## 使用方法

```bash
python3 {baseDir}/bridge.py route --message "底盘走到 station 2"
```

返回 JSON（写到 stdout）：

```json
{
  "matched_skill": "exec-robot.move_chassis",
  "confidence": 0.91,
  "top_3": [["exec-robot.move_chassis", 0.91], ["exec-robot.run_pipette", 0.62], ["exec-labops.experiment_lifecycle", 0.48]],
  "is_unambiguous": true,
  "latency_ms": 18.4,
  "mode": "shadow",
  "threshold": 0.85,
  "decision": "fast_path",
  "trace_id": "a3f2b9c8d1e4f5a6"
}
```

字段说明：

| 字段             | 含义                                                                 |
|------------------|----------------------------------------------------------------------|
| `matched_skill`  | top-1 命中。形如 `<sub-agent>.<action>`，前缀就是要 spawn 的 agent。 |
| `confidence`     | top-1 余弦相似度，范围 [0, 1]                                        |
| `top_3`          | 前三个候选，按分降序                                                 |
| `is_unambiguous` | top-1 与 top-2 分差是否 ≥ ambiguity_gap（默认 0.05）                 |
| `decision`       | 服务端建议：`off` / `shadow_only` / `fast_path` / `fallback_to_llm`  |
| `mode`           | 当前服务模式（off/shadow/active）                                    |
| `trace_id`       | 本次决策 ID，已写入 shadow JSONL                                     |

## 子命令

| 子命令          | 用途                                  |
|-----------------|---------------------------------------|
| `route`         | 主入口，必须传 `--message`            |
| `health`        | 探活，返回服务状态                    |

## 错误处理

服务不可达时，bridge.py 会返回：

```json
{
  "matched_skill": null,
  "confidence": 0.0,
  "is_unambiguous": false,
  "decision": "fallback_to_llm",
  "error": "service_unreachable"
}
```

main 收到这个就当 semantic router 没意见，走原流程即可。

## 接入 main 的 prompt

参见同目录下 `INTEGRATION.md`，里面有 shadow / active 两段可粘贴的 prompt 模板。
