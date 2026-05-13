#!/usr/bin/env python3
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

DEFAULT_TIMEOUT = 5.0
DEFAULT_POLL_INTERVAL = 3.0
DEFAULT_POLL_TIMEOUT = 20.0


def make_base_url(host: str) -> str:
    return f"http://{host}:5002"


def http_json(method: str, url: str, body=None, timeout: float = DEFAULT_TIMEOUT):
    data = None
    headers = {"Accept": "application/json"}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method.upper())
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "ignore")
            payload = json.loads(raw) if raw else {}
            return {"ok": True, "status": resp.status, "json": payload}
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "ignore") if hasattr(e, "read") else ""
        try:
            payload = json.loads(raw) if raw else {}
        except Exception:
            payload = {"raw": raw}
        return {"ok": False, "status": e.code, "json": payload}
    except Exception as e:
        return {"ok": False, "status": None, "error": str(e), "json": {}}


def health(base_url: str, timeout: float):
    return http_json("GET", f"{base_url}/health", timeout=timeout)


def status(base_url: str, timeout: float):
    return http_json("GET", f"{base_url}/status", timeout=timeout)


def action(base_url: str, action_name: str, timeout: float):
    return http_json("POST", f"{base_url}/action", body={"action": action_name}, timeout=timeout)


def select(base_url: str, description: str, timeout: float):
    return http_json("POST", f"{base_url}/select", body={"description": description}, timeout=timeout)


def render_status(payload: dict) -> str:
    tracking = "开启" if payload.get("tracking") else "关闭"
    locked = "是" if payload.get("locked") else "否"
    persons = payload.get("persons", 0)
    ids = payload.get("ids") or []
    ids_text = "、".join(str(x) for x in ids) if ids else "无"
    gimbal = payload.get("gimbal", "unknown")
    selecting = "是" if payload.get("selecting") else "否"
    return (
        "📷 跟踪系统状态\n"
        f"• 自动跟踪：{tracking}\n"
        f"• 目标锁定：{locked}\n"
        f"• 识别中：{selecting}\n"
        f"• 画面人数：{persons} 人（编号 {ids_text}）\n"
        f"• 云台指令：{gimbal}"
    )


def require_health(base_url: str, host: str, timeout: float):
    h = health(base_url, timeout)
    if not h.get("ok"):
        return {
            "ok": False,
            "message": f"❌ 无法连接跟踪系统，请确认设备在线（{host}:5002）",
            "health": h,
        }
    return {"ok": True, "health": h}


def main() -> int:
    ap = argparse.ArgumentParser(description="Control Orbbec tracking backend over HTTP.")
    ap.add_argument("command", choices=["health", "status", "start", "stop", "unlock", "center", "reset", "select"])
    ap.add_argument("description", nargs="?", default="")
    ap.add_argument("--host", default=os.environ.get("TRACKING_HOST", ""))
    ap.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT)
    ap.add_argument("--poll-interval", type=float, default=DEFAULT_POLL_INTERVAL)
    ap.add_argument("--poll-timeout", type=float, default=DEFAULT_POLL_TIMEOUT)
    args = ap.parse_args()

    if not args.host:
        print(json.dumps({
            "ok": False,
            "error": "TRACKING_HOST not set",
            "message": "Missing TRACKING_HOST. Export TRACKING_HOST=<LAN IP> before using this skill."
        }, ensure_ascii=False))
        return 2

    base_url = make_base_url(args.host)

    if args.command == "health":
        out = health(base_url, args.timeout)
        print(json.dumps(out, ensure_ascii=False))
        return 0 if out.get("ok") else 1

    gate = require_health(base_url, args.host, args.timeout)
    if not gate["ok"]:
        print(json.dumps(gate, ensure_ascii=False))
        return 3

    if args.command == "status":
        st = status(base_url, args.timeout)
        result = {"ok": st.get("ok", False), "status": st, "message": render_status(st.get("json", {})) if st.get("ok") else gate["message"]}
        print(json.dumps(result, ensure_ascii=False))
        return 0 if result["ok"] else 1

    if args.command in {"start", "stop"}:
        st = status(base_url, args.timeout)
        if not st.get("ok"):
            print(json.dumps({"ok": False, "status": st, "message": f"❌ 无法连接跟踪系统，请确认设备在线（{args.host}:5002）"}, ensure_ascii=False))
            return 4
        tracking = bool(st.get("json", {}).get("tracking"))
        if args.command == "start" and tracking:
            msg = "✅ 自动跟踪已经处于开启状态"
            print(json.dumps({"ok": True, "changed": False, "message": msg, "status": st}, ensure_ascii=False))
            return 0
        if args.command == "stop" and not tracking:
            msg = "✅ 自动跟踪已经处于关闭状态"
            print(json.dumps({"ok": True, "changed": False, "message": msg, "status": st}, ensure_ascii=False))
            return 0
        act = action(base_url, "toggle", args.timeout)
        verb = "开启" if args.command == "start" else "关闭"
        msg = f"✅ 已发送{verb}跟踪指令" if act.get("ok") else f"❌ {verb}跟踪失败"
        print(json.dumps({"ok": act.get("ok", False), "changed": True, "action": act, "message": msg}, ensure_ascii=False))
        return 0 if act.get("ok") else 1

    if args.command in {"unlock", "center", "reset"}:
        cmd = args.command
        act = action(base_url, cmd, args.timeout)
        ok = act.get("ok", False)
        text = {
            "unlock": "✅ 已发送解锁指令",
            "center": "✅ 已发送回中指令",
            "reset": "✅ 已发送重置指令",
        }[cmd] if ok else "❌ 指令发送失败"
        print(json.dumps({"ok": ok, "action": act, "message": text}, ensure_ascii=False))
        return 0 if ok else 1

    if args.command == "select":
        desc = args.description.strip()
        if not desc:
            print(json.dumps({"ok": False, "message": "Missing description for select."}, ensure_ascii=False))
            return 5
        sel = select(base_url, desc, args.timeout)
        if not sel.get("ok"):
            status_code = sel.get("status")
            payload = sel.get("json", {})
            if status_code == 400 and "no persons" in json.dumps(payload, ensure_ascii=False).lower():
                msg = "⚠️ 当前画面中未检测到人员"
            else:
                msg = f"❌ 无法连接跟踪系统，请确认设备在线（{args.host}:5002）" if status_code is None else "❌ 锁定请求失败"
            print(json.dumps({"ok": False, "select": sel, "message": msg}, ensure_ascii=False))
            return 1

        started = time.time()
        last_status = None
        while time.time() - started < args.poll_timeout:
            time.sleep(args.poll_interval)
            st = status(base_url, args.timeout)
            last_status = st
            if st.get("ok") and st.get("json", {}).get("locked") is True:
                print(json.dumps({
                    "ok": True,
                    "select": sel,
                    "status": st,
                    "message": "✅ 已锁定目标，云台开始跟踪"
                }, ensure_ascii=False))
                return 0

        print(json.dumps({
            "ok": False,
            "select": sel,
            "status": last_status,
            "message": "⚠️ 未找到匹配目标，请换个描述重试"
        }, ensure_ascii=False))
        return 6

    print(json.dumps({"ok": False, "message": "unknown command"}, ensure_ascii=False))
    return 9


if __name__ == "__main__":
    raise SystemExit(main())
