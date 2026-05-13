---
name: standard-demo
description: "Fixed-response QA demo skill for pre-scripted demonstration sequences. Activate ONLY when explicitly in demo mode or when these specific triggers appear in a demo context: 先将董航老师的包送到, 检查送包状态, 模拟检测, PPE OK, 从烧杯中取样, 检查任务执行状态, 请帮我把两个离心管放到离心盘中, 检查实验进度并结束实验, 比对实验数据并分析, 对比实验数据并分析, 整理今日日志并生成飞书日报. Do NOT use for: 你好 (direct reply), 介绍自己 (direct reply from IDENTITY.md), 科研热点 (semantic-scholar), 实验路线 (task-planner), 实验卡片 (experiment-card). Always run bridge.py, never answer directly."
---

# Standard Demo

## Purpose

Return exact, pre-stored answers for known trigger phrases. Responses are deterministic and must not vary across runs.

## Critical rules

- **Always run the bridge script first**, regardless of what the user sends or what prior bridge calls returned.
- **Never answer from memory or generate content directly.** The bridge script is the only source of truth.
- If bridge returns the fallback message, send it verbatim and reply NO_REPLY — do not attempt to answer the question yourself.

## Execution workflow

### 1. Run the bridge script

```bash
python3 {baseDir}/bridge.py "<user_message>"
```

The script outputs:
- `TEXT:<answer>` — the full answer text to send
- `IMAGE:<absolute_path>` — zero or more local image file paths to send after the text, in order
- `SAVE:<absolute_path>` — save the TEXT content to this file path
- `FORWARD:<group_chat_id>` — also send the TEXT to this group chat
- `MENTION:<name>` — @mention this person in the forwarded message

### 2. Send the text

Use the `message` tool with `action=send` to send the TEXT value as a text message to the current user.

### 3. Send each image

For every `IMAGE:<path>` line returned, call the `message` tool with:
- `action`: `send`
- `media`: the absolute file path from the IMAGE line (e.g. `{baseDir}/assets/data1.jpg`)

The `media` parameter triggers automatic upload and inline image delivery.
Do NOT put the file path in the `message` field — use `media` only. Do NOT use `filename` parameter.

### 4. Save the text (if SAVE directive present)

If the bridge output includes `SAVE:<path>`, use the `write` tool to save the TEXT content to that file path.

### 5. Forward to group (if FORWARD directive present)

If the bridge output includes `FORWARD:<group_id>` and `MENTION:<name>`:
1. Use the `message` tool with:
   - `action`: `send`
   - `target`: `group:<group_id>` (e.g. `group:oc_cf27163bfe461ddb029585e778bd44ae`)
   - `message`: the same TEXT content, prefixed with `@<name> ` (e.g. `@张震 ` followed by the full text)

### 6. Reply NO_REPLY

**CRITICAL**: Your assistant text output must be ONLY `NO_REPLY`. Do NOT echo, repeat, or include any part of the text answer, image paths, or directives in your text output. The tool calls handle all delivery. Any text you output will be sent to the user as a separate message, causing duplicates.

## Fallback

If the bridge returns only `TEXT:` with no `IMAGE:` lines (trigger not matched or no images for this trigger), just send the text and reply NO_REPLY.

## Reference source

Trigger → answer mapping: `references/qa-mapping.md`
Image assets: `assets/`
Send log: `references/send-log.md`

## Quality bar

This skill is only correct if the response is stable across runs.
Do not generate answers dynamically — always go through the bridge script.
