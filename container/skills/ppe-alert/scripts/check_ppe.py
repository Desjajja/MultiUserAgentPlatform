#!/usr/bin/env python3
"""
PPE Alert Script
Fetches a lab camera snapshot and sends a Feishu RED ALERT card
when no lab coat is detected.

Usage:
    python3 check_ppe.py [--camera-host HOST] [--camera-id ID] [--dry-run]
"""

import argparse
import sys
import json
import urllib.request
import urllib.error


CAMERA_HOST_DEFAULT = "192.168.100.104:8080"
CAMERA_ID_DEFAULT = 1


def fetch_frame(host: str, camera_id: int) -> bytes | None:
    url = f"http://{host}/api/frame/{camera_id}?type=rgb"
    try:
        with urllib.request.urlopen(url, timeout=5) as resp:
            if resp.status == 200:
                return resp.read()
    except Exception as e:
        print(json.dumps({"ok": False, "stage": "fetch", "error": str(e)}))
    return None


def save_frame(data: bytes, exp_id: str) -> str:
    import os
    from datetime import datetime
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    path = f"/tmp/ppe_snapshot_{ts}.jpg"
    with open(path, "wb") as f:
        f.write(data)
    return path


def get_feishu_token() -> str:
    import os, json as _json
    config_path = os.path.expanduser("~/.openclaw/openclaw.json")
    with open(config_path) as f:
        d = _json.load(f)
    feishu = d["channels"]["feishu"]["accounts"]["main"]
    req = urllib.request.Request(
        "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
        data=_json.dumps({"app_id": feishu["appId"], "app_secret": feishu["appSecret"]}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        data = _json.loads(resp.read())
    return data["tenant_access_token"]


def upload_image_to_feishu(image_path: str) -> str | None:
    """Upload local image to Feishu, return feishu://img_key or None on failure."""
    try:
        import os, json as _json
        token = get_feishu_token()
        boundary = "----FeishuUploadBoundary7a3f9b"
        filename = os.path.basename(image_path)
        with open(image_path, "rb") as f:
            file_data = f.read()
        body = (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="image_type"\r\n\r\nmessage\r\n'
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="image"; filename="{filename}"\r\n'
            f"Content-Type: image/jpeg\r\n\r\n"
        ).encode() + file_data + f"\r\n--{boundary}--\r\n".encode()
        req = urllib.request.Request(
            "https://open.feishu.cn/open-apis/im/v1/images",
            data=body,
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": f"multipart/form-data; boundary={boundary}",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            result = _json.loads(resp.read())
        image_key = result.get("data", {}).get("image_key") or result.get("image_key")
        return f"feishu://{image_key}" if image_key else None
    except Exception as e:
        print(json.dumps({"ok": False, "stage": "upload", "error": str(e)}), file=sys.stderr)
        return None


def build_alert_payload(snapshot_path: str, camera_id: int, exp_id: str) -> dict:
    return {
        "alert_type": "PPE_MISSING",
        "severity": "RED",
        "message": "⛔ 检测到操作人员未穿实验服！实验操作已暂停，请立即穿戴PPE后回复「PPE OK」",
        "details": {
            "camera_id": camera_id,
            "snapshot_path": snapshot_path,
            "experiment_id": exp_id,
            "required_ppe": ["实验服/Lab Coat"],
            "next_action": "回复「PPE OK」后系统自动解除暂停，SOP继续推进"
        }
    }


def main():
    parser = argparse.ArgumentParser(description="PPE Alert Checker")
    parser.add_argument("--camera-host", default=CAMERA_HOST_DEFAULT)
    parser.add_argument("--camera-id", type=int, default=CAMERA_ID_DEFAULT)
    parser.add_argument("--exp-id", default="EXP-UNKNOWN")
    parser.add_argument("--dry-run", action="store_true",
                        help="Skip camera fetch, use placeholder snapshot path")
    args = parser.parse_args()

    if args.dry_run:
        # Use the last saved snapshot if available, else placeholder
        import os
        saved = f"/home/realityloop888/.openclaw/workspace/doc/{args.exp_id}/ppe_snapshot_user.jpg"
        snapshot_path = saved if os.path.isfile(saved) else "/tmp/ppe_snapshot_dry_run.jpg"
        print(f"[DRY-RUN] snapshot: {snapshot_path}", file=sys.stderr)
    else:
        frame = fetch_frame(args.camera_host, args.camera_id)
        if frame is None:
            print(json.dumps({
                "ok": False,
                "stage": "camera",
                "error": f"摄像头 {args.camera_id} 无响应 ({args.camera_host})"
            }))
            sys.exit(1)
        snapshot_path = save_frame(frame, args.exp_id)

    payload = build_alert_payload(snapshot_path, args.camera_id, args.exp_id)

    # Try to upload the snapshot and embed feishu image key
    feishu_key = upload_image_to_feishu(snapshot_path)
    if feishu_key:
        payload["feishu_image_key"] = feishu_key

    print(json.dumps(payload, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
