#!/usr/bin/env python3
"""远程控制局域网内 Windows 电脑的 HTTP 桥接脚本。"""

import argparse
import base64
import json
import os
import sys

# Auto re-exec under local .venv python if present and not already inside it.
_VENV_PY = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".venv", "bin", "python")
if os.path.isfile(_VENV_PY) and os.path.abspath(sys.executable) != os.path.abspath(_VENV_PY):
    os.execv(_VENV_PY, [_VENV_PY] + sys.argv)
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Dict, Tuple

try:
    from PIL import Image
    PIL_AVAILABLE = True
except ImportError:
    PIL_AVAILABLE = False

try:
    from rapidocr_onnxruntime import RapidOCR
    _OCR_ENGINE = None
    OCR_AVAILABLE = True
except ImportError:
    OCR_AVAILABLE = False

from difflib import SequenceMatcher

# 2026-04-23 默认主机从 Tailscale(100.96.24.39) 切到 LAN(10.13.0.84):
# Tailscale 通路有坏节点，对 /key /hotkey /right_click /scroll 返回假 404（FastAPI 默认模板），
# 实际远端完整实现全部 14 端点，LAN 直连已验证 /key 返回 200 + Caps Lock 灯跟随触发。
# 如需走 Tailscale 可设环境变量 WIN_REMOTE_CONTROL_HOST。
TARGET_HOST = os.environ.get("WIN_REMOTE_CONTROL_HOST", "http://192.168.66.246:8000")
SCREENSHOT_PATH = os.environ.get(
    "WIN_REMOTE_CONTROL_SCREENSHOT",
    os.path.join(os.path.expanduser("~"), ".openclaw", "workspace", "win_screenshot.png")
)
CROP_PATH = os.environ.get("WIN_REMOTE_CONTROL_CROP", "/tmp/crop_patch.png")
MAX_RETRIES = 3
RETRY_DELAY = 2
PATCH_SIZE = 300
PATCH_PADDING = 100

ENDPOINTS = {
    "run_exe": "/run_exe",
    "click": "/click",
    "double_click": "/double_click",
    "right_click": "/right_click",
    "move_mouse": "/move_mouse",
    "scroll": "/scroll",
    "key": "/key",
    "hotkey": "/hotkey",
    "type": "/type",
    "screenshot": "/screenshot",
    "screen_size": "/screen_size",
    "health": "/health",
    "a11y_tree": "/a11y_tree",
    "a11y_element": "/a11y_element",
}


def _decode_json_bytes(raw: bytes) -> Dict:
    return json.loads(raw.decode("utf-8"))


def check_health() -> bool:
    try:
        result = send_request("health", {}, retry=False)
        return result.get("success", False)
    except Exception:
        return False


def send_request(action: str, params: Dict, retry: bool = True) -> Dict:
    if action not in ENDPOINTS:
        return {"success": False, "error": f"不支持的 action '{action}'，可选值为 {list(ENDPOINTS.keys())}"}

    endpoint = TARGET_HOST.rstrip("/") + ENDPOINTS[action]
    query_string = urllib.parse.urlencode(params) if params else ""
    url = f"{endpoint}?{query_string}" if query_string else endpoint

    attempts = 0
    max_attempts = MAX_RETRIES if retry else 1

    # Bypass system proxy for direct LAN/Tailscale connections
    proxy_handler = urllib.request.ProxyHandler({})
    opener = urllib.request.build_opener(proxy_handler)

    timeout = 60 if action == "screenshot" else 15
    while attempts < max_attempts:
        try:
            with opener.open(url, timeout=timeout) as resp:
                raw = resp.read()

            if action == "screenshot":
                if raw[:4] == b"\x89PNG":
                    img_bytes = raw
                    data = {}
                else:
                    data = _decode_json_bytes(raw)
                    b64 = data.get("image_base64", "")
                    if not b64:
                        return {"success": False, "error": "服务端未返回 image_base64", "url": url}
                    img_bytes = base64.b64decode(b64)

                with open(SCREENSHOT_PATH, "wb") as f:
                    f.write(img_bytes)

                # 优先从 JSON metadata 取尺寸；新服务端返回裸 PNG 时从文件读取
                image_w_meta = data.get("image_width")
                image_h_meta = data.get("image_height")
                if not isinstance(image_w_meta, int) and PIL_AVAILABLE:
                    try:
                        with Image.open(SCREENSHOT_PATH) as _img:
                            image_w_meta, image_h_meta = _img.size
                    except Exception:
                        pass

                image_size = (image_w_meta or "?", image_h_meta or "?")
                screen_size = tuple(data.get(k, "?") for k in ("screen_width", "screen_height"))

                return {
                    "success": True,
                    "action": action,
                    "path": SCREENSHOT_PATH,
                    "image_size": image_size,
                    "screen_size": screen_size,
                    "url": url,
                    "data": data,
                }

            data = _decode_json_bytes(raw)
            return {
                "success": bool(data.get("success", True)),
                "action": action,
                "params": params,
                "response": data.get("message") or data,
                "data": data,
                "url": url,
            }

        except urllib.error.HTTPError as e:
            error_body = ""
            try:
                error_body = e.read().decode("utf-8", errors="replace")
            except Exception:
                pass
            # 客户端/服务端明确错误，无需重试
            if e.code in (400, 403, 404, 405, 500, 501):
                return {
                    "success": False,
                    "error": f"HTTP {e.code} - {e.reason}",
                    "details": error_body,
                    "url": url,
                }
            attempts += 1
            if attempts < max_attempts:
                time.sleep(RETRY_DELAY * attempts)
                continue
            return {
                "success": False,
                "error": f"HTTP {e.code} - {e.reason}",
                "details": error_body,
                "url": url,
            }
        except urllib.error.URLError as e:
            attempts += 1
            if attempts < max_attempts:
                time.sleep(RETRY_DELAY * attempts)
                continue
            return {"success": False, "error": f"无法连接到 {TARGET_HOST} - {e.reason}", "url": url}
        except Exception as e:
            return {"success": False, "error": str(e), "url": url}

    return {"success": False, "error": "未知错误", "url": url}


def crop_patch(x_center: int, y_center: int, size: int = PATCH_SIZE, padding: int = PATCH_PADDING) -> Tuple[int, int, int, int]:
    if not PIL_AVAILABLE:
        # 降级：不裁剪，直接返回屏幕逻辑坐标范围
        half = size // 2 + padding
        x1 = max(0, x_center - half)
        y1 = max(0, y_center - half)
        w = min(size + padding * 2, 1920 - x1)
        h = min(size + padding * 2, 1080 - y1)
        return x1, y1, w, h
    if not os.path.exists(SCREENSHOT_PATH):
        raise FileNotFoundError(f"截图不存在: {SCREENSHOT_PATH}")

    img = Image.open(SCREENSHOT_PATH)
    img_w, img_h = img.size

    half = size // 2 + padding
    x1 = max(0, x_center - half)
    y1 = max(0, y_center - half)
    x2 = min(img_w, x_center + half)
    y2 = min(img_h, y_center + half)

    cropped = img.crop((x1, y1, x2, y2))
    cropped.save(CROP_PATH)
    return x1, y1, cropped.size[0], cropped.size[1]


def click_with_patch(target_name: str, rough_x_pct: int, rough_y_pct: int, screen_w: int, screen_h: int, image_w: int = None, image_h: int = None) -> Dict:
    # Compute DPI scale: screenshot pixels vs logical screen coords
    scale_x = (image_w / screen_w) if (image_w and image_h) else 1.0
    scale_y = (image_h / screen_h) if (image_w and image_h) else 1.0

    rough_x_screen = int(rough_x_pct / 1000 * screen_w)
    rough_y_screen = int(rough_y_pct / 1000 * screen_h)

    # Convert to image pixel space for cropping
    rough_x_img = int(rough_x_screen * scale_x)
    rough_y_img = int(rough_y_screen * scale_y)

    # Adaptive patch size: larger on high-res screens
    adaptive_size = max(300, min(600, (image_w or screen_w) // 6))

    offset_x, offset_y, crop_w, crop_h = crop_patch(rough_x_img, rough_y_img, size=adaptive_size)
    return {
        "success": True,
        "target": target_name,
        "screenshot_path": SCREENSHOT_PATH,
        "crop_path": CROP_PATH,
        "rough_coords": [rough_x_screen, rough_y_screen],
        "offset": [offset_x, offset_y],
        "crop_size": [crop_w, crop_h],
        "scale": [scale_x, scale_y],
        "pil_available": PIL_AVAILABLE,
        "next_step": (
            f"【无裁剪图模式 / PIL 不可用】目标：「{target_name}」\n"
            f"目标区域（屏幕逻辑坐标）：({offset_x},{offset_y}) - ({offset_x+crop_w},{offset_y+crop_h})\n"
            f"粗略中心：({rough_x_screen}, {rough_y_screen})\n"
            "\n"
            "请先执行 screenshot 查看全屏，在上述坐标范围内找到目标后，直接调用：\n"
            f"  python3 {{baseDir}}/bridge.py finalize --local-x <X> --local-y <Y> "
            f"--offset-x 0 --offset-y 0 --scale-x 1.0 --scale-y 1.0\n"
            "（此模式 local-x/local-y 直接填屏幕逻辑坐标；双击追加 --double）"
        ) if not PIL_AVAILABLE else (
            f"【视觉定位任务】目标：「{target_name}」\n"
            f"裁剪图路径：{CROP_PATH}（尺寸 {crop_w}×{crop_h}px，原点为图像左上角）\n"
            f"\n"
            f"请按以下步骤完成定位：\n"
            f"1. 查看裁剪图，在图中找到目标「{target_name}」\n"
            f"2. 描述你看到的目标：外观特征、文字标签（如有）、与周边元素的位置关系\n"
            f"3. 给出目标**中心点**的像素坐标 (local_x, local_y)，以图像左上角为原点\n"
            f"4. 同时给出目标的边界框：left, top, right, bottom（用于验证）\n"
            f"5. 给出置信度（0–100）：\n"
            f"   - ≥85：目标清晰可辨，直接执行\n"
            f"   - 60–84：目标基本可辨，执行但需额外注意验证截图\n"
            f"   - <60：目标模糊，**不要执行**，改为重新截图并缩小 patch 范围后再次尝试\n"
            f"\n"
            f"完成定位后，调用：\n"
            f"  python3 bridge.py finalize --local-x <x> --local-y <y> "
            f"--offset-x {offset_x} --offset-y {offset_y} "
            f"--scale-x {scale_x:.4f} --scale-y {scale_y:.4f}\n"
            f"（双击目标时追加 --double）\n"
            f"\n"
            f"⚠️ 禁止在置信度 <60 时执行 finalize；禁止仅凭形状猜测，必须同时核对文字标签。"
        ),
    }


def focus_window(title: str, scope: str = "desktop") -> Dict:
    """通过标题模糊匹配找到窗口，点击其标题栏使其成为前台焦点窗口。"""
    result = send_request("a11y_element", {
        "name": title,
        "control_type": "WindowControl",
        "scope": scope,
        "depth": 1,
    })
    if not result.get("success"):
        return result
    root = result.get("data", {}).get("root")
    if not root:
        return {"success": False, "error": f"窗口 '{title}' 未找到", "hint": "检查标题关键字是否正确"}
    rect = root.get("rect", {})
    if not rect or rect.get("width", 0) == 0:
        return {"success": False, "error": "窗口 rect 无效", "rect": rect}
    cx = rect["left"] + rect["width"] // 2
    cy = rect["top"] + 20
    click_result = send_request("click", {"x": cx, "y": cy})
    click_result["focused_window"] = root.get("name")
    click_result["focus_coords"] = [cx, cy]
    return click_result


def a11y_click(name: str = "", control_type: str = "", depth: int = 4, double: bool = False,
               verify: bool = False, scope: str = "foreground", automation_id: str = "") -> Dict:
    """通过 a11y 树定位 UI 元素并点击其中心坐标。无需截图，精度由 UIAutomation 保证。"""
    params: Dict = {"depth": depth}
    if name:
        params["name"] = name
    if control_type:
        params["control_type"] = control_type
    if scope and scope != "foreground":
        params["scope"] = scope
    if automation_id:
        params["automationId"] = automation_id

    result = send_request("a11y_element", params)
    if not result.get("success"):
        return result

    root = result.get("data", {}).get("root")
    if not root:
        return {"success": False, "error": "a11y_element 未找到匹配元素", "params": params,
                "hint": "尝试用 a11y_tree 查看当前窗口结构，确认元素名称和 controlType"}

    if root.get("isOffScreen"):
        return {"success": False, "error": f"元素 '{name}' 存在但不在屏幕可见区域内（isOffScreen=true）", "root": root}

    rect = root.get("rect")
    if not rect or rect.get("width", 0) == 0 or rect.get("height", 0) == 0:
        return {"success": False, "error": f"元素 '{name}' 的 rect 无效（width/height 为 0）", "rect": rect}

    cx = rect["left"] + rect["width"] // 2
    cy = rect["top"] + rect["height"] // 2
    action = "double_click" if double else "click"
    click_result = send_request(action, {"x": cx, "y": cy})
    click_result["a11y_name"] = root.get("name")
    click_result["a11y_controlType"] = root.get("controlType")
    click_result["a11y_automationId"] = root.get("automationId")
    click_result["click_coords"] = [cx, cy]
    click_result["rect"] = rect

    if verify and click_result.get("success"):
        time.sleep(0.5)
        verify_result = send_request("screenshot", {}, retry=False)
        click_result["verify_screenshot"] = verify_result.get("path") if verify_result.get("success") else None

    return click_result


def _get_ocr():
    global _OCR_ENGINE
    if _OCR_ENGINE is None:
        _OCR_ENGINE = RapidOCR()
    return _OCR_ENGINE


def ocr_find(query: str, screenshot_path: str = None, x_range: Tuple = None,
             y_range: Tuple = None, min_ratio: float = 0.55) -> Dict:
    """OCR the screenshot and fuzzy-find the best match for `query`.
    x_range/y_range: optional (min, max) pixel constraints to restrict search region."""
    if not OCR_AVAILABLE:
        return {"success": False, "error": "rapidocr-onnxruntime 未安装"}

    img_path = screenshot_path or SCREENSHOT_PATH
    if not os.path.exists(img_path):
        return {"success": False, "error": f"截图不存在: {img_path}"}

    ocr = _get_ocr()
    result, elapse = ocr(img_path)
    if not result:
        return {"success": False, "error": "OCR 未检测到任何文本", "elapse": elapse}

    candidates = []
    for poly, text, score in result:
        xs = [p[0] for p in poly]
        ys = [p[1] for p in poly]
        x0, y0 = min(xs), min(ys)
        x1, y1 = max(xs), max(ys)
        if x_range and not (x_range[0] <= x0 <= x_range[1]):
            continue
        if y_range and not (y_range[0] <= y0 <= y_range[1]):
            continue
        clean = text.strip()
        ratio = SequenceMatcher(None, query.lower(), clean.lower()).ratio()
        if ratio >= min_ratio:
            cx = int((x0 + x1) / 2)
            cy = int((y0 + y1) / 2)
            candidates.append({
                "text": clean, "score": round(float(score), 3),
                "match_ratio": round(ratio, 3),
                "center": [cx, cy],
                "rect": {"left": int(x0), "top": int(y0),
                         "right": int(x1), "bottom": int(y1),
                         "width": int(x1 - x0), "height": int(y1 - y0)},
            })

    candidates.sort(key=lambda c: c["match_ratio"], reverse=True)

    if not candidates:
        return {"success": False, "error": f"OCR 未找到与 '{query}' 匹配的元素 (min_ratio={min_ratio})",
                "total_elements": len(result), "elapse": elapse}

    return {
        "success": True, "method": "ocr",
        "best": candidates[0], "all_matches": candidates,
        "total_elements": len(result), "elapse": elapse,
    }


def ocr_click(query: str, screenshot_path: str = None, x_range: Tuple = None,
              y_range: Tuple = None, min_ratio: float = 0.55,
              double: bool = False, verify: bool = False) -> Dict:
    """OCR 定位文本元素并点击其中心。"""
    find_result = ocr_find(query, screenshot_path, x_range, y_range, min_ratio)
    if not find_result.get("success"):
        return find_result

    best = find_result["best"]
    cx, cy = best["center"]
    action = "double_click" if double else "click"
    click_result = send_request(action, {"x": cx, "y": cy})
    click_result["method"] = "ocr"
    click_result["ocr_text"] = best["text"]
    click_result["ocr_match_ratio"] = best["match_ratio"]
    click_result["ocr_score"] = best["score"]
    click_result["click_coords"] = [cx, cy]
    click_result["rect"] = best["rect"]

    if verify and click_result.get("success"):
        time.sleep(0.5)
        verify_result = send_request("screenshot", {}, retry=False)
        click_result["verify_screenshot"] = verify_result.get("path") if verify_result.get("success") else None

    return click_result


def smart_click(name: str, control_type: str = "", automation_id: str = "",
                depth: int = 6, scope: str = "foreground",
                x_range: Tuple = None, y_range: Tuple = None,
                min_ratio: float = 0.55, double: bool = False,
                verify: bool = False) -> Dict:
    """三级降级定位点击：a11y → OCR → 返回提示走 patch_click。
    优先 a11y（精确 handle），miss 了降级 OCR（模糊匹配），再 miss 返回失败让上层走视觉流程。"""

    # --- Level 1: a11y ---
    a11y_result = a11y_click(
        name=name, control_type=control_type, depth=depth,
        double=double, verify=verify, scope=scope, automation_id=automation_id,
    )
    if a11y_result.get("success"):
        a11y_result["method"] = "a11y"
        return a11y_result

    # --- Level 2: OCR ---
    if OCR_AVAILABLE:
        if not os.path.exists(SCREENSHOT_PATH):
            send_request("screenshot", {})
        ocr_result = ocr_click(
            query=name, x_range=x_range, y_range=y_range,
            min_ratio=min_ratio, double=double, verify=verify,
        )
        if ocr_result.get("success"):
            return ocr_result

    # --- Level 3: fallback hint ---
    return {
        "success": False,
        "method": "fallback",
        "error": f"a11y 和 OCR 均未找到 '{name}'，请使用 patch_click 视觉定位",
        "a11y_error": a11y_result.get("error", ""),
        "ocr_available": OCR_AVAILABLE,
        "hint": f"python3 bridge.py patch_click --target \"{name}\" --rough-x <X> --rough-y <Y>",
    }


def finalize_click(local_x: int, local_y: int, offset_x: int, offset_y: int, action: str = "click", verify: bool = False, scale_x: float = 1.0, scale_y: float = 1.0) -> Dict:
    # Convert from image pixel space back to screen logical coords
    final_x = int((offset_x + local_x) / scale_x)
    final_y = int((offset_y + local_y) / scale_y)
    result = send_request(action, {"x": final_x, "y": final_y})
    result["final_coords"] = [final_x, final_y]
    result["local_coords"] = [local_x, local_y]
    result["offset"] = [offset_x, offset_y]

    if verify and result.get("success"):
        time.sleep(1)
        verify_result = send_request("screenshot", {}, retry=False)
        result["verify_screenshot"] = verify_result.get("path") if verify_result.get("success") else None

    return result


def print_result(result: Dict) -> None:
    print(json.dumps(result, ensure_ascii=False, indent=2))


def main() -> None:
    parser = argparse.ArgumentParser(description="远程控制 Windows 电脑")
    parser.add_argument("action", choices=list(ENDPOINTS.keys()) + ["patch_click", "finalize", "a11y_click", "focus_window", "ocr_find", "ocr_click", "smart_click"], help="操作类型")
    parser.add_argument("--path", help="exe 文件路径或 URL")
    parser.add_argument("--x", type=int, help="X 坐标")
    parser.add_argument("--y", type=int, help="Y 坐标")
    parser.add_argument("--local-x", type=int, help="局部图内 X 坐标")
    parser.add_argument("--local-y", type=int, help="局部图内 Y 坐标")
    parser.add_argument("--offset-x", type=int, help="裁剪区域 X 偏移")
    parser.add_argument("--offset-y", type=int, help="裁剪区域 Y 偏移")
    parser.add_argument("--clicks", type=int, help="滚轮格数")
    parser.add_argument("--key", help="按键名称")
    parser.add_argument("--keys", help="组合键，逗号分隔")
    parser.add_argument("--text", help="输入文字")
    parser.add_argument("--target", help="目标名称")
    parser.add_argument("--rough-x", type=int, help="粗略 X 千分位 0-1000")
    parser.add_argument("--rough-y", type=int, help="粗略 Y 千分位 0-1000")
    parser.add_argument("--double", action="store_true", help="finalize 时执行双击")
    parser.add_argument("--scale-x", type=float, default=1.0, help="DPI 缩放比 X（来自 patch_click 输出的 scale[0]）")
    parser.add_argument("--scale-y", type=float, default=1.0, help="DPI 缩放比 Y（来自 patch_click 输出的 scale[1]）")
    parser.add_argument("--verify", action="store_true", help="点击后截图验证结果（默认关闭）")
    parser.add_argument("--no-retry", action="store_true", help="禁用请求重试")
    # a11y 相关
    parser.add_argument("--name", help="a11y 元素名称（模糊匹配）")
    parser.add_argument("--control-type", help="a11y 控件类型，如 ButtonControl、EditControl")
    parser.add_argument("--depth", type=int, default=4, help="a11y 树深度（默认 4）")
    parser.add_argument("--scope", default="foreground", choices=["foreground", "desktop"], help="a11y 搜索范围")
    parser.add_argument("--max-depth", type=int, default=6, help="a11y_tree 最大深度")
    parser.add_argument("--automation-id", dest="automation_id", default="",
                        help="通过 automationId 精确定位元素（适用于 GUID 名称的 Tab 等）")
    parser.add_argument("--focus-window", dest="focus_window_title", metavar="TITLE", default="",
                        help="a11y_click 前先激活指定窗口（模糊匹配标题）")
    args = parser.parse_args()

    verify = args.verify
    retry = not args.no_retry

    if args.action == "health":
        ok = check_health()
        if ok:
            print(f"STATUS: OK\nTARGET_HOST: {TARGET_HOST}")
            return
        print(f"STATUS: FAIL\nTARGET_HOST: {TARGET_HOST}")
        sys.exit(1)

    if args.action == "patch_click":
        if not args.target or args.rough_x is None or args.rough_y is None:
            print("STATUS: FAIL\nREASON: patch_click 需要 --target, --rough-x, --rough-y 参数")
            sys.exit(1)
        scr_result = send_request("screenshot", {}, retry=retry)
        if not scr_result.get("success"):
            print_result(scr_result)
            sys.exit(1)
        screen_w, screen_h = scr_result.get("screen_size", (None, None))
        if not isinstance(screen_w, int) or not isinstance(screen_h, int):
            size_result = send_request("screen_size", {}, retry=retry)
            if size_result.get("success"):
                size_data = size_result.get("data", {})
                screen_w = size_data.get("width")
                screen_h = size_data.get("height")
        if not isinstance(screen_w, int) or not isinstance(screen_h, int):
            print_result({
                "success": False,
                "error": "无法获取 screen_size（screenshot 与 screen_size 回退均失败）",
                "raw": scr_result,
            })
            sys.exit(1)
        image_size = scr_result.get("image_size", (None, None))
        image_w = image_size[0] if isinstance(image_size[0], int) else None
        image_h = image_size[1] if isinstance(image_size[1], int) else None
        result = click_with_patch(args.target, args.rough_x, args.rough_y, screen_w, screen_h, image_w, image_h)
        print_result(result)
        return

    if args.action == "finalize":
        if None in (args.local_x, args.local_y, args.offset_x, args.offset_y):
            print("STATUS: FAIL\nREASON: finalize 需要 --local-x --local-y --offset-x --offset-y 参数")
            sys.exit(1)
        action = "double_click" if args.double else "click"
        result = finalize_click(args.local_x, args.local_y, args.offset_x, args.offset_y, action=action, verify=verify, scale_x=args.scale_x, scale_y=args.scale_y)
        print_result(result)
        if not result.get("success"):
            sys.exit(1)
        return

    if args.action == "focus_window":
        if not args.name:
            print("STATUS: FAIL\nREASON: focus_window 需要 --name 参数（窗口标题关键字）")
            sys.exit(1)
        result = focus_window(title=args.name, scope=args.scope)
        print_result(result)
        if not result.get("success"):
            sys.exit(1)
        return

    if args.action == "a11y_click":
        if not args.name and not args.control_type and not args.automation_id:
            print("STATUS: FAIL\nREASON: a11y_click 需要 --name、--control-type 或 --automation-id 参数")
            sys.exit(1)
        if args.focus_window_title:
            focus_result = focus_window(title=args.focus_window_title, scope="desktop")
            if not focus_result.get("success"):
                print_result(focus_result)
                sys.exit(1)
            time.sleep(0.3)
        result = a11y_click(
            name=args.name or "",
            control_type=args.control_type or "",
            depth=args.depth,
            double=args.double,
            verify=verify,
            scope=args.scope,
            automation_id=args.automation_id,
        )
        print_result(result)
        if not result.get("success"):
            sys.exit(1)
        return

    if args.action == "ocr_find":
        if not args.name:
            print("STATUS: FAIL\nREASON: ocr_find 需要 --name 参数")
            sys.exit(1)
        if not os.path.exists(SCREENSHOT_PATH):
            send_request("screenshot", {}, retry=retry)
        x_range = (0, int(args.x)) if args.x is not None else None
        y_range = (0, int(args.y)) if args.y is not None else None
        result = ocr_find(args.name, x_range=x_range, y_range=y_range)
        print_result(result)
        if not result.get("success"):
            sys.exit(1)
        return

    if args.action == "ocr_click":
        if not args.name:
            print("STATUS: FAIL\nREASON: ocr_click 需要 --name 参数")
            sys.exit(1)
        if not os.path.exists(SCREENSHOT_PATH):
            send_request("screenshot", {}, retry=retry)
        x_range = (0, int(args.x)) if args.x is not None else None
        y_range = (0, int(args.y)) if args.y is not None else None
        result = ocr_click(
            args.name, x_range=x_range, y_range=y_range,
            double=args.double, verify=verify,
        )
        print_result(result)
        if not result.get("success"):
            sys.exit(1)
        return

    if args.action == "smart_click":
        if not args.name and not args.control_type and not args.automation_id:
            print("STATUS: FAIL\nREASON: smart_click 需要 --name、--control-type 或 --automation-id 参数")
            sys.exit(1)
        if args.focus_window_title:
            focus_result = focus_window(title=args.focus_window_title, scope="desktop")
            if not focus_result.get("success"):
                print_result(focus_result)
                sys.exit(1)
            time.sleep(0.3)
        x_range = (0, int(args.x)) if args.x is not None else None
        y_range = (0, int(args.y)) if args.y is not None else None
        result = smart_click(
            name=args.name or "",
            control_type=args.control_type or "",
            automation_id=args.automation_id,
            depth=args.depth,
            scope=args.scope,
            x_range=x_range, y_range=y_range,
            double=args.double,
            verify=verify,
        )
        print_result(result)
        if not result.get("success"):
            sys.exit(1)
        return

    params = {}
    if args.action == "run_exe":
        if not args.path:
            print("STATUS: FAIL\nREASON: run_exe 需要 --path 参数")
            sys.exit(1)
        params = {"path": args.path}
    elif args.action in {"click", "double_click", "right_click", "move_mouse"}:
        if None in (args.x, args.y):
            print(f"STATUS: FAIL\nREASON: {args.action} 需要 --x 和 --y 参数")
            sys.exit(1)
        params = {"x": args.x, "y": args.y}
    elif args.action == "scroll":
        if None in (args.x, args.y, args.clicks):
            print("STATUS: FAIL\nREASON: scroll 需要 --x --y --clicks 参数")
            sys.exit(1)
        params = {"x": args.x, "y": args.y, "clicks": args.clicks}
    elif args.action == "key":
        if not args.key:
            print("STATUS: FAIL\nREASON: key 需要 --key 参数")
            sys.exit(1)
        params = {"key": args.key}
    elif args.action == "hotkey":
        if not args.keys:
            print("STATUS: FAIL\nREASON: hotkey 需要 --keys 参数")
            sys.exit(1)
        params = {"keys": args.keys}
    elif args.action == "type":
        if not args.text:
            print("STATUS: FAIL\nREASON: type 需要 --text 参数")
            sys.exit(1)
        params = {"text": args.text}
    elif args.action == "a11y_tree":
        params = {"scope": args.scope, "max_depth": args.max_depth}
    elif args.action == "a11y_element":
        if not args.name and not args.control_type and not args.automation_id:
            print("STATUS: FAIL\nREASON: a11y_element 需要 --name、--control-type 或 --automation-id 参数")
            sys.exit(1)
        params = {"depth": args.depth}
        if args.name:
            params["name"] = args.name
        if args.control_type:
            params["control_type"] = args.control_type
        if args.scope and args.scope != "foreground":
            params["scope"] = args.scope
        if args.automation_id:
            params["automationId"] = args.automation_id

    result = send_request(args.action, params, retry=retry)
    print_result(result)
    if not result.get("success"):
        sys.exit(1)


if __name__ == "__main__":
    main()
