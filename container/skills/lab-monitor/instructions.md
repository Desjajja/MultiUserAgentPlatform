---
name: lab-monitor
description: Handle Feishu camera-monitor requests for the lab multi-camera system on 192.168.43.233:8080. Use when the user asks for a lab camera screenshot in natural language, such as “1号摄像头”, “3号深度图”, “所有摄像头”, “拍一下 2 号相机”, or any request to fetch RGB/depth snapshots from the Orbbec monitoring system and send the resulting image(s) back into the same Feishu conversation.
---

# Lab Monitor

Use this skill for **Feishu message → camera API screenshot → Feishu image reply** workflows.

## What this skill must do

1. Parse the user message into:
   - `camera_id`: `1` to `5`, or `all`
   - `type`: `rgb` or `depth`
2. Call the camera HTTP API on `192.168.43.233:8080`
3. Fetch JPEG frames directly from `/api/frame/...`
4. Reply in the **same Feishu conversation** with image messages
5. Handle offline / no-frame / parse-failure cases with deterministic text replies

## Parsing rules

### Camera selection
- `1号摄像头` / `1号相机` / `camera 1` -> `camera_id=1`
- `2号摄像头` -> `camera_id=2`
- `3号摄像头` -> `camera_id=3`
- `4号摄像头` -> `camera_id=4`
- `5号摄像头` -> `camera_id=5`
- `所有摄像头` / `全部摄像头` / `all cameras` -> `camera_id=all`

### Image type
- Default: `rgb`
- If the user mentions `深度图` / `depth`, use `type=depth`

## Execution workflow

### 1. Parse first
If parsing fails, reply with exactly this help text:

```text
📷 Lab Monitor 用法：
· 发送"1号摄像头"获取1号RGB图
· 发送"3号深度图"获取3号深度图
· 发送"所有摄像头"获取全部截图
```

### 2. Fetch frames with the bundled script
Run:

```bash
python3 {baseDir}/scripts/fetch_frames.py --camera <camera_id> --type <rgb|depth>
# default output dir is inside the workspace so Feishu media sending is allowed
```

Notes:
- The script uses `GET /api/frame/{camera_id}?type={type}` for actual JPEG retrieval.
- If `camera_id=all`, the script first calls `GET /api/cameras` to resolve online cameras.
- The script prints JSON to stdout describing saved image paths, skipped cameras, and errors.

### 3. Send image replies in Feishu
For every successful image path returned by the script:
- use the `message` tool with `action=send`
- reply in the current conversation
- send the local image file path as media
- include a caption like `📷 摄像头 1 (RGB)` for multi-camera mode

### 4. Multi-image behavior
If `camera_id=all`:
- send one image message per camera, in order
- caption format:
  - `📷 摄像头 1 (RGB)`
  - `📷 摄像头 2 (DEPTH)`
  - etc.

### 5. Error handling

#### Camera system unreachable
Reply with:

```text
摄像头系统暂时无法访问 (192.168.43.233:8080)，请检查网络连接
```

#### 503 / no frame available
Skip that camera and tell the user which one was unavailable.
In `all` mode, continue with the other online cameras.

#### No successful images in all-mode
Reply with a short summary stating that no available frames were returned.

## Output policy

- Single image: send the image directly
- Multiple images: send multiple image replies in order
- Parse failure: send the usage block exactly
- Do not ask the user to manually call the API
- Do not read camera snapshot files from the remote host filesystem; use `/api/frame/...`

## Bundled resources

### scripts/fetch_frames.py
Deterministic helper for:
- querying online cameras
- downloading JPEG frames
- skipping 503 cameras
- saving images locally for Feishu replies

### references/api-notes.md
Read if you need the API contract or expected edge-case behavior.

## PPE Detection Mode

Activate this mode when the user says: `模拟检测`, `PPE 检测`, `安全检测`, `PPE OK`, `穿戴好了`, or any similar phrase requesting PPE verification.

### Workflow

#### 1. Capture frame

Run fetch_frames.py with camera 1 (lab entrance camera):

```bash
python3 {baseDir}/scripts/fetch_frames.py --camera 1 --type rgb
```

#### 2. Call PPE detection API on C machine

```bash
curl -s -X POST http://192.168.43.233:8080/detect/ppe \
  -H "Content-Type: application/json" \
  -d '{"image_path": "<absolute_path_to_frame>"}'
```

Expected response:

```json
{
  "ok": true,
  "violations": [],
  "detected": ["lab_coat", "safety_glasses", "gloves"]
}
```

#### 3. Act on result

**If `ok: true` (all PPE present):**
- Send Feishu message: `✅ PPE 检测通过，已检测到：{detected}，可继续实验。`
- Send the captured frame as image

**If `ok: false` (violations found):**
- Send Feishu **red alert card** with:
  - Title: `⚠️ PPE 违规告警`
  - Body: `未检测到以下防护用品：{violations}`
  - Action required: `请穿戴完整后发送「PPE OK」重新确认`
- Send the captured frame as image

#### 4. Re-check mode (`PPE OK` trigger)

When triggered by `PPE OK` or `穿戴好了`:
- Run the same detection flow (steps 1-3)
- If `ok: true`: reply `✅ PPE 已确认，恢复实验流程。`
- If `ok: false`: reply `⚠️ 仍未检测到完整 PPE（缺少：{violations}），请重新穿戴后再确认。`

#### Error handling

| 场景 | 处理 |
|---|---|
| C机检测API离线 | 回复「PPE 检测服务暂不可用 (192.168.43.233:8080)，请手动确认安全防护」|
| 无法获取摄像头帧 | 回复「无法拍摄摄像头画面，请检查1号摄像头连接状态」|

---

## Result Contract

- `contract_version`: `v1`
- `kind`: `answer` for text-only monitoring help or failures; `artifacts` when images are returned.
- `status=ok`: at least one requested frame is fetched and delivered, with any required text summary.
- `status=partial`: some cameras fail or return no frame, but at least one frame is delivered.
- `status=failed`: parse failure, camera API unreachable, or no usable frames.
- `required_outputs`:
  - `text` for every response
  - `images` when frames are available
- `optional_outputs`:
  - `errors` for skipped cameras or API failures
  - `summary` for a short human-readable result
- `execution_failure` means the camera API is unreachable, the fetch script errors, or no frame can be produced.
- `delivery_hints`:
  - Prefer text-first responses for status and failure cases.
  - Deliver each image independently when multiple frames are available.
  - In `all` mode, continue past per-camera failures and report them in `errors`.
