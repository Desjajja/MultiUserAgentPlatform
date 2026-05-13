# Remote Liquid Exec API Reference

封装 `detect_move_vision_realtime.py` 的 HTTP 服务（`detect_move_vision_realtime_api.py`），机械臂控制机本地起，局域网内调用。

Base URL:
- `http://192.168.66.154:8008`

机械臂控制口 `29999` 是 Dobot Dashboard 私有协议口，**禁止业务端直连**，全部通过本 HTTP API。

可选环境变量覆盖：
- `OPENCLAW_API_BASE_URL`
- `OPENCLAW_API_TOKEN`（如服务启用了 Bearer 鉴权）

## 资源独占约束

- 同一时刻只能有一个移液任务在跑（RealSense 相机 + Dobot 控制口都是独占）
- start 时如已有 running 任务，需先 stop 才能重启

## 端点

### GET /health
存活检查。

```bash
curl http://192.168.66.154:8008/health
```
返回：
```json
{"ok": true, "message": "service alive"}
```

### POST /api/pipette/start
启动一次实时视觉移液流程（去 beaker → 依次执行 pipette#1..#N → 返回观察位）。

最简：
```json
{}
```

推荐参数集：
```json
{
  "skip_home_before_vision": true,
  "no_show": true,
  "task_count": 4,
  "pipette_x_offset_mm": -25,
  "pipette_y_offset_mm": -10,
  "pipette_plan_association_mm": 170,
  "callback_url": "http://<业务后端>:<port>/<path>"
}
```

返回：
```json
{
  "ok": true,
  "message": "任务已启动",
  "task": {
    "task_id": "task_YYYYMMDD_HHMMSS_xxxxxxxx",
    "status": "running",
    "message": "任务已启动",
    "pid": 1234567
  }
}
```

支持的 body 字段（全部可选）：
- `skip_home_before_vision` (bool)
- `no_show` (bool)
- `dry_run` (bool)
- `model` / `roi_config` / `realsense_serial`
- `ip` / `port` — 机械臂连接覆盖
- `task_count` (int) — 计划执行的 pipette 数
- `pipette_x_offset_mm` / `pipette_y_offset_mm`
- `beaker_x_offset_mm` / `beaker_y_offset_mm`
- `pipette_plan_association_mm`
- `pipette_stable_frames` / `stable_frames`
- `beaker_lift_mm`
- `return_observe_vel`
- `callback_url`

### GET /api/pipette/status
查询当前任务（最近一次 start 的）。

返回示例：
```json
{
  "ok": true,
  "running": true,
  "task": {
    "task_id": "task_...",
    "status": "running",
    "message": "...",
    "result_message": null,
    "process_state": {
      "phase": "pipette",
      "target_index": 3,
      "planned_pipette_count": 4,
      "target_locked": true,
      "selected_pose_mm": {"x": ..., "y": ..., "z": ..., "roll": ..., "pitch": ..., "yaw": ...}
    }
  }
}
```

终态：
- `success` —— `result_message="移液完成"`
- `failed` —— `result_message="移液失败"` 或最近错误日志
- `stopped` —— `result_message="任务已停止"`

`process_state.phase`: `beaker` / `pipette`

### GET /api/pipette/tasks/{task_id}
按任务 ID 查询，返回状态 + 最近日志尾部 + process_state。

### POST /api/pipette/stop
停止当前任务。

```json
{
  "ok": true,
  "message": "任务已停止",
  "task": {"status": "stopped", "result_message": "任务已停止"}
}
```

## 回调

start 时传 `callback_url`，任务结束后服务端 `POST` 回业务后端：
```json
{
  "task_id": "task_...",
  "status": "success",
  "message": "移液完成",
  "return_code": 0,
  "finished_at": 1777250000.123,
  "process_state": {"phase": "pipette", "target_index": 5, "planned_pipette_count": 4, "target_locked": true}
}
```

OpenClaw 当前没有暴露的回调 endpoint，因此 skill 默认走轮询；`callback_url` 留口供后续接入。
