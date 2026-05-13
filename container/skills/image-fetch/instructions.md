---
name: image-fetch
description: |
  从远程图像后端(192.168.66.31:8000)获取指定实验台的当前画面,返回单帧 JPEG 文件路径。
  触发词:
    - 发送 N 号台的图像给我
    - 把 N 号台拍一张 / 看看 N 号台
    - 取 cam0 / cam1 / cam2 / usb0 / usb1 的快照
    - snapshot / 抓图
  注意:本 skill 与旧 lab-monitor 服务于不同后端(66.31 vs 43.233),不冲突。
allowed_tools:
  - Bash
  - Read
---

# image-fetch

调用图像后端拿单帧 JPEG,落盘后把路径返回给上层。

## 后端

- 基址:`http://192.168.66.31:8000/api/v1`
- 单帧:`GET /cameras/{camera_id}/snapshot?quality=95&save=false` → `image/jpeg`
- 列表:`GET /cameras` → JSON

## 台号映射(强制,不要让 LLM 猜)

| 用户说法 | camera_id |
|---|---|
| 一号台 / 1号台 / 台1 | cam0 |
| 二号台 / 2号台 / 台2 | cam1 |
| 三号台 / 3号台 / 台3 | cam2 |
| usb0 / USB一 / USB1 | usb0 |
| usb1 / USB二 / USB2 | usb1 |

用户直接说 `cam0/cam1/cam2/usb0/usb1` 时透传不映射。映射表外的台号一律拒绝。

## 调用步骤

1. 从用户消息解析出 `camera_id`(套上表)。
2. 执行:`python3 {baseDir}/bridge.py snapshot --camera-id <id>`
   - **必须**用绝对路径(`{baseDir}` 由 OpenClaw 在调用时替换为本 skill 目录的绝对路径)
   - **禁止** `cd <dir> && python ...` —— OpenClaw exec preflight 拒所有 shell-compound(`cd && `、`;`、`|`、`&&`、`$(…)`、重定向、env 前缀等)。详见 CLAUDE.md「exec 工具约束」
3. bridge 输出 JSON,字段:`ok`、`path`、`camera_id`、`bytes` 或 `error`。
4. 成功 → 回报「已抓取 <camera_id>,保存于 <path>,大小 <bytes>B」。
5. 失败 → 原样回报 error,不重试更多次(bridge 已自带 1 次重试)。

## 边界(明确不做的事)

- 不发飞书,不做批量,不做录像,不做标定。
- camera_id 不在白名单 → 拒绝并提示合法值。
- 后端不可达 → 报错并提示「检查 192.168.66.31:8000 是否启动」。
