---
name: orbbec-tracking-control
description: Control the LAN Orbbec tracking system from Feishu natural-language messages. Use when the user asks to start/stop tracking, query status, lock onto a described person, unlock, center the gimbal, or reset the tracking system, using the HTTP control API at http://${TRACKING_HOST}:5002.
---

# Orbbec Tracking Control

Use this skill for **Feishu message → tracking intent parsing → HTTP control API → Chinese status reply** workflows.

## Configuration

Read the target host from environment, never hardcode it:

- `TRACKING_HOST=<LAN IP>`

Base URL:

- `http://${TRACKING_HOST}:5002`

## Supported user intents

### Status
Examples:
- `状态`
- `status`
- `当前状态`

Run:

```bash
python3 {baseDir}/scripts/tracking_api.py status
```

### Start tracking
Examples:
- `开始跟踪`
- `打开跟踪`
- `跟踪开`

Run:

```bash
python3 {baseDir}/scripts/tracking_api.py start
```

### Stop tracking
Examples:
- `停止跟踪`
- `关闭跟踪`
- `跟踪关`

Run:

```bash
python3 {baseDir}/scripts/tracking_api.py stop
```

### Lock/select target
Examples:
- `锁定 穿红衣服的人`
- `跟踪 左边站着的人`
- `找 戴帽子的人`

Run:

```bash
python3 {baseDir}/scripts/tracking_api.py select "<描述>"
```

The script submits `/select`, then polls `/status` every 3 seconds for up to 20 seconds.

### Unlock / return to auto tracking
Examples:
- `解锁`
- `取消锁定`
- `自动跟踪`

Run:

```bash
python3 {baseDir}/scripts/tracking_api.py unlock
```

### Center gimbal
Examples:
- `回中`
- `归位`
- `舵机回中`

Run:

```bash
python3 {baseDir}/scripts/tracking_api.py center
```

### Reset system
Examples:
- `重置`
- `reset`

Run:

```bash
python3 {baseDir}/scripts/tracking_api.py reset
```

## Mandatory behavior

1. Check `/health` before every operational call.
2. For `start` / `stop`, query `/status` first so toggle is interpreted correctly.
3. Treat `/select` as asynchronous:
   - accept the request immediately
   - then poll `/status`
   - success when `locked=true`
4. HTTP timeout: 5 seconds.
5. Poll window for select: up to 20 seconds, every 3 seconds.
6. Prefer exact trigger matching first; if the message is ambiguous, ask a short clarification question.

## Reply rules

### Status reply
Return the script's natural-language status block, for example:

```text
📷 跟踪系统状态
• 自动跟踪：开启
• 目标锁定：否
• 识别中：否
• 画面人数：3 人（编号 1、2、3）
• 云台指令：stop
```

### Select reply
- While the async lock is pending, communicate that recognition is in progress.
- If lock succeeds, reply:
  - `✅ 已锁定目标，云台开始跟踪`
- If polling times out, reply:
  - `⚠️ 未找到匹配目标，请换个描述重试`

### Error replies
- Network / timeout:
  - `❌ 无法连接跟踪系统，请确认设备在线（${TRACKING_HOST}:5002）`
- 400 no persons detected:
  - `⚠️ 当前画面中未检测到人员`
- Unknown intent:
  - reply with a short help list or ask what the user wants to do

## Bundled resources

### scripts/tracking_api.py
Deterministic wrapper for `/health`, `/status`, `/action`, and `/select`, including toggle pre-check and select polling.

### references/orbbec-tracking-notes.md
Read when you need the API contract, trigger mapping, or troubleshooting notes.
