# robot-grasp API contract

## Trigger intent
Use only when the current task is in real robot-execution context and the requested action explicitly includes grasp / 抓取 / 开始抓取 / execute grasp. Do not use for task decomposition, previews, or abstract planning.

## Service startup
If the OpenClaw task API is unavailable, the expected service location is:

```bash
cd /home/x1/openclaw_api
bash start_openclaw_api.sh
```

Background form:

```bash
nohup bash start_openclaw_api.sh > logs/openclaw_api.log 2>&1 &
```

## HTTP endpoints
- `GET /health`
- `POST /tasks`
- `GET /tasks/{task_id}`
- `GET /tasks/{task_id}/log`
- `POST /tasks/{task_id}/cancel`

Default API host is not hardcoded. Supply it via `OPENCLAW_API_BASE_URL` or `--base-url`.
Default port: `8008`

### POST /tasks
Request body:

```json
{
  "pipeline": "realman_grasp",
  "args": []
}
```

Optional Dobot payload:

```json
{
  "pipeline": "dobot_detect_move",
  "args": ["--task-count", "6"]
}
```

Expected response fields:
- `task_id`
- `status`

## Local reply rule
- Success: summarize that the task API was called and include the returned task_id/message.
- Failure: state whether the problem is health check failure, task submission failure, or missing configuration.
