#!/usr/bin/env python3
"""一次性探针：发 down / up 方向键验证远端是否真的接收。

没有硬件指示灯，观察方式：Windows B 机上当前前台窗口若有可滚动内容、
列表选中、光标位置变化，应当能看到光标/选中项移动。
"""
import json
import logging
import os
import sys
import time

logging.basicConfig(
    level=logging.WARNING,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import bridge  # noqa: E402

for k in ("down", "up"):
    print("-" * 60)
    print(f"URL = {bridge.TARGET_HOST}/key?key={k}")
    print("-" * 60)
    result = bridge.send_request("key", {"key": k})
    print(json.dumps(result, indent=2, ensure_ascii=False))
    time.sleep(1.0)
print("-" * 60)
