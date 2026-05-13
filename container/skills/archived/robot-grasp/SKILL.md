---
name: robot-grasp
description: Execute the dedicated OpenClaw task API for grasp execution when a current request explicitly includes grasp / 抓取 / 开始抓取 / pick intent. Use this only inside real execution flows; do not use it for planning, decomposition, previews, or non-grasp robot actions.
---

# Robot Grasp

## Overview

Use this skill as a focused supplement to robot execution. Trigger it only when the current execution request contains a concrete grasp action. Keep non-grasp movement, planning, and task decomposition outside this skill.

Read `references/api-contract.md` when you need the startup path, endpoint details, or response contract.

## Required behavior

1. Confirm the current request is an execution request, not a plan preview.
2. Confirm the requested action includes a grasp intent.
3. Call the bundled script:

```bash
python3 /Users/realityloop/.openclaw/workspace/skills/robot-grasp/scripts/run_grasp.py \
  --base-url "<openclaw_api_base_url>" \
  --check-status
```

4. If the user or workflow provides a config path, pass it with `--config`.
5. Do not call this skill for generic robot-execution requests that do not mention grasping.

## Output rules

### Success reply
State that the task API has been invoked and include the returned task_id / message.

### Failure reply
State the failing stage clearly:
- missing `OPENCLAW_API_BASE_URL`
- `/health` check failure
- `/tasks` request failure
- API returned failure

If the service appears offline, include the startup hint from the script result:

```bash
cd /home/x1/openclaw_api
bash start_openclaw_api.sh
```

## Execution notes

- Prefer `--check-status` before task submission.
- Keep the request body empty unless a concrete config path is provided.
- For grasp requests, default pipeline is `realman_grasp`.
- Use `dobot_detect_move` only when explicitly requested.
- If the request mixes grasping with other robot actions, use this skill for the grasp step only.
