"""image-fetch bridge: GET /api/v1/cameras/{id}/snapshot, save jpg, print json."""
import argparse
import json
import sys
import time
from pathlib import Path

import requests

BASE = "http://192.168.66.31:8000/api/v1"
VALID_IDS = {"cam0", "cam1", "cam2", "usb0", "usb1"}
OUT_DIR = Path(__file__).parent / "output" / "snapshots"
TIMEOUT = 5

SESSION = requests.Session()
SESSION.trust_env = False


def snapshot(camera_id: str, quality: int = 95) -> dict:
    if camera_id not in VALID_IDS:
        return {
            "ok": False,
            "error": f"invalid camera_id: {camera_id}",
            "valid": sorted(VALID_IDS),
        }
    url = f"{BASE}/cameras/{camera_id}/snapshot"
    params = {"quality": quality, "save": "false"}
    last_err = None
    for attempt in range(2):
        try:
            r = SESSION.get(url, params=params, timeout=TIMEOUT)
            if r.status_code == 200:
                OUT_DIR.mkdir(parents=True, exist_ok=True)
                ts = time.strftime("%Y%m%d_%H%M%S")
                path = OUT_DIR / f"{camera_id}_{ts}.jpg"
                path.write_bytes(r.content)
                return {
                    "ok": True,
                    "path": str(path),
                    "camera_id": camera_id,
                    "bytes": len(r.content),
                }
            last_err = f"HTTP {r.status_code}: {r.text[:200]}"
            if 500 <= r.status_code < 600 and attempt == 0:
                time.sleep(1)
                continue
            return {"ok": False, "error": last_err, "camera_id": camera_id}
        except requests.exceptions.RequestException as e:
            last_err = str(e)
            if attempt == 0:
                time.sleep(1)
                continue
            return {"ok": False, "error": last_err, "camera_id": camera_id}
    return {"ok": False, "error": last_err or "unknown", "camera_id": camera_id}


def list_cameras() -> dict:
    try:
        r = SESSION.get(f"{BASE}/cameras", timeout=TIMEOUT)
        r.raise_for_status()
        return {"ok": True, "data": r.json()}
    except requests.exceptions.RequestException as e:
        return {"ok": False, "error": str(e)}


def main() -> int:
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    s1 = sub.add_parser("snapshot")
    s1.add_argument("--camera-id", required=True)
    s1.add_argument("--quality", type=int, default=95)
    sub.add_parser("list")
    args = p.parse_args()
    if args.cmd == "snapshot":
        out = snapshot(args.camera_id, args.quality)
    else:
        out = list_cameras()
    print(json.dumps(out, ensure_ascii=False))
    return 0 if out.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
