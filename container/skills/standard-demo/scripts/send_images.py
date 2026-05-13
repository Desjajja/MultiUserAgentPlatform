#!/usr/bin/env python3
"""
Upload one or more local images to Feishu and print their feishu:// keys.

Usage:
    python3 send_images.py assets/data1.jpg assets/data2.jpg
    # Prints one feishu://img_v3_xxxx per line, in order.

Reuses upload logic from ppe-alert/scripts/upload_image.py.
"""

import argparse
import sys
import json
import urllib.request
import os

SKILL_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def get_token(app_id: str, app_secret: str) -> str:
    req = urllib.request.Request(
        "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
        data=json.dumps({"app_id": app_id, "app_secret": app_secret}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        data = json.loads(resp.read())
    if data.get("code") != 0:
        raise RuntimeError(f"Token error: {data}")
    return data["tenant_access_token"]


def upload_image(token: str, image_path: str) -> str:
    boundary = "----FeishuUploadBoundary7a3f9b"
    filename = os.path.basename(image_path)
    with open(image_path, "rb") as f:
        file_data = f.read()
    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="image_type"\r\n\r\n'
        f"message\r\n"
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
        result = json.loads(resp.read())
    if result.get("code") != 0:
        raise RuntimeError(f"Upload error: {result}")
    image_key = result.get("data", {}).get("image_key") or result.get("image_key")
    if not image_key:
        raise RuntimeError(f"No image_key in response: {result}")
    return image_key


def load_feishu_config() -> tuple[str, str]:
    config_path = os.path.expanduser("~/.openclaw/openclaw.json")
    with open(config_path) as f:
        d = json.load(f)
    feishu = d["channels"]["feishu"]["accounts"]["main"]
    return feishu["appId"], feishu["appSecret"]


def resolve_path(p: str) -> str:
    """Accept relative (to skill root) or absolute paths."""
    if os.path.isabs(p):
        return p
    return os.path.join(SKILL_ROOT, p)


def main():
    parser = argparse.ArgumentParser(description="Upload images to Feishu")
    parser.add_argument("images", nargs="+", help="Image paths (relative to skill root or absolute)")
    args = parser.parse_args()

    try:
        app_id, app_secret = load_feishu_config()
        token = get_token(app_id, app_secret)
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"Auth failed: {e}"}))
        sys.exit(1)

    keys = []
    for img in args.images:
        path = resolve_path(img)
        if not os.path.isfile(path):
            print(json.dumps({"ok": False, "error": f"File not found: {path}"}))
            sys.exit(1)
        try:
            key = upload_image(token, path)
            keys.append(f"feishu://{key}")
            print(f"feishu://{key}")
        except Exception as e:
            print(json.dumps({"ok": False, "error": f"Upload failed for {img}: {e}"}))
            sys.exit(1)


if __name__ == "__main__":
    main()
