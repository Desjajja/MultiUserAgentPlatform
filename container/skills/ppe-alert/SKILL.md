---
name: ppe-alert
description: Trigger a RED ALERT Feishu card when an operator is detected without lab coat / PPE during an experiment SOP. Use when the SOP monitor detects missing PPE (no lab coat, gloves, or goggles), when the user reports a safety concern, or when a pre-execution PPE gate check is needed before robot operations begin. Sends a blocking red alert to the Feishu conversation with a camera snapshot, a required-PPE checklist, and a resume instruction ("PPE OK").
metadata:
  openclaw:
    requires:
      bins: ["lark-cli"]
---

# PPE Alert

Emit a **red blocking alert** to the current Feishu conversation when an operator is observed without lab coat or other required PPE.

## When to trigger

1. SOP step gate (before any robot execution step): always run a PPE check if `ppe_confirmed=false` in the active checklist.
2. Manual trigger: user says something like "有人没穿实验服" / "PPE检查" / "安全告警".
3. Anomaly signal: lab-monitor camera returns a frame where PPE is absent (visual review).

## Execution workflow

### 1. Capture snapshot

```bash
python3 {baseDir}/scripts/check_ppe.py \
  --exp-id <EXP_ID> \
  --camera-host 192.168.100.104:8080 \
  --camera-id 1
```

For testing without a live camera:
```bash
python3 ... --dry-run --exp-id <EXP_ID>
```

Script outputs JSON to stdout:
- `alert_type`, `severity`, `message`, `details.snapshot_path`, `details.required_ppe`, `details.next_action`
- On camera failure: `{"ok": false, "stage": "camera", "error": "..."}`

### 1b. Upload snapshot to Feishu (required before sending image)

使用 `lark-cli` 上传图片，替代旧的 `upload_image.py` 脚本：

```bash
lark-cli im images create --path <snapshot_path>
# 返回 image_key: img_v3_xxxx
```

如果摄像头离线或截图不可用，跳过此步骤，告警卡片中省略图片。

### 2. Send red alert card to Feishu

使用 `lark-cli` 发送告警消息：

```bash
lark-cli im +messages-send --chat-id <LAB_CHAT_ID> --text "⛔ 【安全警告·爆红】未检测到实验服穿戴

━━━━━━━━━━━━━━━━━━━━━━━━
🔴 严重级别：RED — 实验操作已自动暂停
📷 证据截图：见下图
📋 实验编号：<EXP_ID>
━━━━━━━━━━━━━━━━━━━━━━━━

必须穿戴：
  🥼 实验服 / Lab Coat

操作已暂停。穿戴完毕后回复：
👉 「PPE OK」  ← 系统自动解除暂停，SOP继续推进
━━━━━━━━━━━━━━━━━━━━━━━━"
```

之后单独发送截图（使用上一步的 image_key）：

```bash
lark-cli im +messages-send --chat-id <LAB_CHAT_ID> --image <image_key>
```

### 3. Wait for "PPE OK" reply

- When the user replies `PPE OK` (case-insensitive, with or without spaces), set `ppe_confirmed=true` in the active SOP checklist and resume the SOP from where it was paused.
- Do NOT proceed with any robot execution step until `ppe_confirmed=true`.

### 4. Update checklist

After PPE is confirmed, log the confirmation:
```json
{
  "ppe_confirmed": true,
  "ppe_confirmed_at": "<ISO timestamp>",
  "ppe_confirmed_by": "operator reply"
}
```

## Failure handling

| Failure | Action |
|---------|--------|
| Camera unreachable | Still send the red alert card (text only), note "摄像头离线，请自行确认PPE" |
| Operator ignores alert | Re-send once after 60 s; if still no reply, escalate via `message` to the lab group chat |
| Operator replies before alert | Still confirm and mark `ppe_confirmed=true`, no need to re-alert |

## Severity levels

This skill always emits **RED** severity. Do not downgrade to yellow/orange — PPE non-compliance is a hard stop.

## References

- See `references/ppe-checklist.md` for the full required-PPE list per experiment type.
