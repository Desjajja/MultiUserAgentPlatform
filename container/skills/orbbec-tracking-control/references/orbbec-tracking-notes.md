# Orbbec Tracking Control Notes

## API summary

Base URL:
- `http://${TRACKING_HOST}:5002`

Endpoints used by this skill:
- `GET /health`
- `GET /status`
- `POST /action`
- `POST /select`

## `/status` shape

Example:

```json
{
  "tracking": true,
  "locked": false,
  "selecting": false,
  "gimbal": "stop",
  "persons": 3,
  "ids": [1, 2, 3]
}
```

## `/action` payloads

```json
{"action":"toggle"}
{"action":"unlock"}
{"action":"center"}
{"action":"reset"}
```

## `/select` payload

```json
{"description":"穿红衣服的人"}
```

`/select` is asynchronous. A successful POST means the request was accepted, not that the target is already locked.

## Trigger mapping

- `开始跟踪` / `打开跟踪` / `跟踪开` -> start
- `停止跟踪` / `关闭跟踪` / `跟踪关` -> stop
- `锁定 <描述>` / `跟踪 <描述>` / `找 <描述>` -> select
- `解锁` / `取消锁定` / `自动跟踪` -> unlock
- `回中` / `归位` / `舵机回中` -> center
- `重置` / `reset` -> reset
- `状态` / `status` / `当前状态` -> status

## Important implementation notes

1. Always health-check first.
2. `toggle` cannot be called blindly; read `tracking` from `/status` first.
3. Poll `/status` after `/select`.
4. A timeout during polling should return a user-facing warning, not a silent failure.
5. Keep replies short and explicit because this is an operator control surface.
