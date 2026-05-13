#!/usr/bin/env python3
"""一次性探针：只发一次 down 方向键。"""
import json
import logging
import os
import sys

logging.basicConfig(
    level=logging.WARNING,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import bridge  # noqa: E402

print("-" * 60)
print(f"URL = {bridge.TARGET_HOST}/key?key=down")
print("-" * 60)
result = bridge.send_request("key", {"key": "down"})
print(json.dumps(result, indent=2, ensure_ascii=False))
print("-" * 60)
