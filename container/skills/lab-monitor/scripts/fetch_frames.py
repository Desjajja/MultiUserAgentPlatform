#!/usr/bin/env python3
import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime

BASE_URL = "http://192.168.43.233:8080"


def http_get_json(url: str, timeout: int = 10):
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8", "ignore"))


def http_get_binary(url: str, timeout: int = 15):
    req = urllib.request.Request(url, headers={"Accept": "image/jpeg,*/*"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.status, resp.read(), dict(resp.headers)


def normalize_camera_list(payload):
    """Accept a few likely schemas and return a list of camera_id strings."""
    if isinstance(payload, list):
        out = []
        for item in payload:
            if isinstance(item, dict):
                cid = item.get("camera_id") or item.get("id") or item.get("cameraId")
                if cid is not None:
                    out.append(str(cid))
            elif item is not None:
                out.append(str(item))
        return out
    if isinstance(payload, dict):
        for key in ("cameras", "data", "items", "online_cameras", "online"):
            if key in payload:
                return normalize_camera_list(payload[key])
    return []


def fetch_online_cameras(base_url: str):
    payload = http_get_json(f"{base_url}/api/cameras")
    cams = normalize_camera_list(payload)
    # preserve order, dedupe
    seen = set()
    ordered = []
    for cam in cams:
        if cam not in seen:
            seen.add(cam)
            ordered.append(cam)
    return ordered


def save_bytes(path: str, data: bytes):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)


def fetch_frame(base_url: str, camera_id: str, image_type: str, output_dir: str):
    ts = datetime.now().strftime("%Y%m%d_%H%M%S_%f")[:-3]
    url = f"{base_url}/api/frame/{urllib.parse.quote(str(camera_id))}?type={urllib.parse.quote(image_type)}"
    filename = f"cam{camera_id}_{image_type}_{ts}.jpg"
    path = os.path.join(output_dir, filename)
    try:
        status, data, headers = http_get_binary(url)
        if status != 200 or not data:
            return {"ok": False, "camera_id": str(camera_id), "type": image_type, "error": f"unexpected status {status}"}
        save_bytes(path, data)
        return {
            "ok": True,
            "camera_id": str(camera_id),
            "type": image_type,
            "path": path,
            "label": f"📷 摄像头 {camera_id} ({image_type.upper()})",
            "content_type": headers.get("Content-Type", "image/jpeg"),
        }
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "ignore") if hasattr(e, "read") else ""
        if e.code == 503:
            return {
                "ok": False,
                "camera_id": str(camera_id),
                "type": image_type,
                "skipped": True,
                "error": "no frame available (503)",
                "body": body,
            }
        return {"ok": False, "camera_id": str(camera_id), "type": image_type, "error": f"http {e.code}", "body": body}
    except Exception as e:
        return {"ok": False, "camera_id": str(camera_id), "type": image_type, "error": str(e)}


def main():
    ap = argparse.ArgumentParser(description="Fetch lab-monitor camera frames and save them locally.")
    ap.add_argument("--camera", required=True, help="1-5 or all")
    ap.add_argument("--type", default="rgb", choices=["rgb", "depth"])
    ap.add_argument("--base-url", default=BASE_URL)
    ap.add_argument("--output-dir", default="/tmp/openclaw/screenshots")
    args = ap.parse_args()

    camera = str(args.camera).strip().lower()
    image_type = args.type.strip().lower()
    base_url = args.base_url.rstrip("/")

    result = {
        "ok": True,
        "base_url": base_url,
        "camera": camera,
        "type": image_type,
        "items": [],
        "skipped": [],
        "errors": [],
    }

    try:
        if camera == "all":
            cameras = fetch_online_cameras(base_url)
            result["resolved_cameras"] = cameras
            if not cameras:
                result["ok"] = False
                result["errors"].append("no online cameras found")
                print(json.dumps(result, ensure_ascii=False))
                return 1
        else:
            cameras = [camera]

        for cam in cameras:
            item = fetch_frame(base_url, cam, image_type, args.output_dir)
            if item.get("ok"):
                result["items"].append(item)
            elif item.get("skipped"):
                result["skipped"].append(item)
            else:
                result["errors"].append(item)

        if not result["items"] and result["errors"]:
            result["ok"] = False

        print(json.dumps(result, ensure_ascii=False))
        return 0 if result["ok"] else 1
    except urllib.error.URLError:
        result["ok"] = False
        result["errors"].append(f"摄像头系统暂时无法访问 ({base_url})，请检查网络连接")
        print(json.dumps(result, ensure_ascii=False))
        return 2
    except Exception as e:
        result["ok"] = False
        result["errors"].append(str(e))
        print(json.dumps(result, ensure_ascii=False))
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
