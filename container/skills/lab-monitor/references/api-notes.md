# Lab Monitor API Notes

## Base URL
- `http://192.168.43.233:8080`

## APIs

### 1. Query online cameras
- `GET /api/cameras`
- Use this first in `all` mode

### 2. Direct frame fetch
- `GET /api/frame/{camera_id}?type=rgb`
- `GET /api/frame/{camera_id}?type=depth`
- Returns JPEG binary directly
- Preferred for Feishu image replies because it avoids remote file-path handling

### 3. Snapshot creation API
- `POST /api/snapshot`
- Supported, but not the preferred path for this skill
- Use `/api/frame/...` instead of relying on remote snapshot files

## Expected behavior

### Single-camera request
- Fetch one JPEG frame
- Save locally
- Reply with one image message

### All-camera request
- Resolve online cameras first
- Fetch one frame per online camera
- Continue if a subset fails
- Reply with multiple image messages in order

### 503 handling
- `503 no frame available` means that camera has no current frame ready
- Skip it, do not fail the entire `all` request because of one unavailable camera

## Feishu reply behavior

Within OpenClaw, prefer sending the local image path through the `message` tool in the current conversation. OpenClaw handles the provider-specific image upload path internally.
