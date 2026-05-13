---
name: ppe-recheck
description: |
  PPE 复检:抓 PTZ 跟踪服务当前一帧(云台自动追人,源 = opencv:1 本机摄像头),让 LLM 多模态看图判断是否穿了实验服(白大褂)。
  触发词:
    - 已穿好 / 穿好了 / 已戴好 / 防护到位
    - 请重新检测 / 重新检测 / 重新检测 PPE / PPE OK
  仅判断实验服(白大褂),不判断手套/护目镜。后端 192.168.66.31:8000 PTZ snapshot 接口。
allowed_tools:
  - Bash
  - Read
---

# ppe-recheck

PPE 复检 skill。流程:抓 PTZ 跟踪服务当前帧 → LLM 自己看图判断是否穿了实验服 → 给出文字回复。

## 为什么用 PTZ snapshot

PTZ 跟踪服务的源是本机 OpenCV 摄像头(`source_id="opencv:1"`),云台会自动追踪到人 —— 不是 cam0/cam1/cam2 那些无线相机(那些覆盖实验台,不是对人的)。所以 PPE 检测**只能**走 `/ptz-tracker/snapshot`,不要直接调 `/cameras/<id>/snapshot`。

## 调用步骤

1. **抓图**:`python3 {baseDir}/bridge.py snapshot`
   - **必须**用 `{baseDir}` 绝对路径(由 OpenClaw 替换为本 skill 目录绝对路径)
   - **禁止** `cd <dir> && python ...` —— exec preflight 拒所有 shell-compound
   - 后端固定:`GET http://192.168.66.31:8000/api/v1/ptz-tracker/snapshot?auto_start=true&timeout_ms=3000`(PTZ 服务没起时自动起)
   - 输出 JSON: `{"ok": true, "path": "<abs path>", "source": "opencv:1", "bytes": N}` 或 `{"ok": false, "error": "<msg>"}`

2. **加载图到对话**:用 `read` 工具读取上一步返回的 `path`(图会作为多模态输入加载到对话上下文)

3. **看图判断**(LLM 多模态分析):
   - 画面里有人吗?
   - 这个人穿着**白色实验服 / lab coat / 白大褂**吗?
   - 注意:只判断有没有穿白大褂。不需要评估护目镜、手套、口罩。

4. **输出文字回复**(三选一):
   - 穿了 → `✅ 已检测到实验服,可以继续实验。`
   - 没穿/不确定 → `⚠️ 未检测到实验服,请穿戴后再确认。`(如果能看清缺什么可补充)
   - 画面没人 → `⚠️ 画面中没有人,云台可能未追到人,请站到摄像头前再确认。`

## 边界(明确不做的事)

- **只看实验服(白大褂),不评估手套/护目镜/口罩**(本任务范围)
- 不发飞书,不做录像,不做后端 PPE detect API 调用(那是旧 lab-monitor 的方案,本 skill 用 LLM 多模态自检)
- 后端 503 → 报错并提示「PTZ 跟踪服务未启动且 auto_start 失败,检查 192.168.66.31:8000 后端」,status=failed
- 后端不可达 → 报错并提示「检查 192.168.66.31:8000 是否启动」,status=failed
- **不要伪造检测结果**。看不清就如实说"画面看不清,请重新抓一张"。失败就是失败,不要假装通过让用户继续操作硬件
