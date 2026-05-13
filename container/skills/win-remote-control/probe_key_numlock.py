#!/usr/bin/env python3
"""一次性探针：发 numlock 按键验证远端是否真的接收。

numlock 有硬件指示灯，便于人工肉眼观察。
"""
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
print(f"URL = {bridge.TARGET_HOST}/key?key=numlock")
print("-" * 60)

result = bridge.send_request("key", {"key": "numlock"})
print(json.dumps(result, indent=2, ensure_ascii=False))
print("-" * 60)
