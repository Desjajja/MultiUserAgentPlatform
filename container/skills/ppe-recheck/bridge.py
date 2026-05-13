"""ppe-recheck bridge: snapshot PTZ tracker frame, return jpg path for LLM multimodal review."""
import argparse
import json
import sys
import time
from pathlib import Path

import requests

BASE = "http://192.168.66.31:8000/api/v1"
ENDPOINT = "/ptz-tracker/snapshot"
OUT_DIR = Path(__file__).parent / "output" / "ppe"
TIMEOUT = 8

SESSION = requests.Session()
SESSION.trust_env = False


def snapshot() -> dict:
    url = f"{BASE}{ENDPOINT}"
    params = {"auto_start": "true", "timeout_ms": "3000"}
    last_err = None
    for attempt in range(2):
        try:
            r = SESSION.get(url, params=params, timeout=TIMEOUT)
            if r.status_code == 200:
                OUT_DIR.mkdir(parents=True, exist_ok=True)
                ts = time.strftime("%Y%m%d_%H%M%S")
                source = r.headers.get("X-PTZ-Video-Source", "ptz")
                source_safe = source.replace(":", "_").replace("/", "_")
                path = OUT_DIR / f"{source_safe}_{ts}.jpg"
                path.write_bytes(r.content)
                return {
                    "ok": True,
                    "path": str(path),
                    "source": source,
                    "bytes": len(r.content),
                }
            last_err = f"HTTP {r.status_code}: {r.text[:200]}"
            if r.status_code == 503:
                last_err += " (PTZ tracker service unavailable; auto_start failed)"
            if 500 <= r.status_code < 600 and attempt == 0:
                time.sleep(1)
                continue
            return {"ok": False, "error": last_err}
        except requests.exceptions.RequestException as e:
            last_err = str(e)
            if attempt == 0:
                time.sleep(1)
                continue
            return {"ok": False, "error": last_err}
    return {"ok": False, "error": last_err or "unknown"}


def main() -> int:
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("snapshot")
    args = p.parse_args()
    if args.cmd == "snapshot":
        out = snapshot()
    else:
        out = {"ok": False, "error": f"unknown cmd {args.cmd}"}
    print(json.dumps(out, ensure_ascii=False))
    return 0 if out.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
