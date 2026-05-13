#!/usr/bin/env python3
"""Control wrapper for mqtt_daemon.py."""

import json
import os
import subprocess
import sys
import time

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DAEMON = f"{SCRIPT_DIR}/mqtt_daemon.py"


def run(cmd: str) -> subprocess.CompletedProcess:
    return subprocess.run(["python3", DAEMON, cmd], text=True, capture_output=True)


def get_status() -> dict:
    p = run("status")
    if p.returncode != 0:
        return {"running": False}
    try:
        return json.loads(p.stdout)
    except Exception:
        return {"running": False}


def is_running() -> bool:
    return bool(get_status().get("running", False))


def start_background() -> bool:
    if is_running():
        print("[Control] daemon already running")
        return True

    log_path = os.getenv("MQTT_LOG_FILE", "/tmp/mqtt_experiment_mode.log")
    print(f"[Control] starting daemon in background (log: {log_path})...")
    log_file = open(log_path, "a")
    subprocess.Popen(
        ["python3", "-u", DAEMON, "start"],
        stdout=log_file,
        stderr=log_file,
        start_new_session=True,
        env={**os.environ, "PYTHONUNBUFFERED": "1"},
    )
    # 不关闭 log_file，让子进程继承并写入

    for _ in range(20):
        time.sleep(0.25)
        if is_running():
            print(f"[Control] daemon started, logs → {log_path}")
            return True

    print("[Control] daemon failed to start")
    return False


def print_status() -> int:
    p = run("status")
    if p.stdout:
        print(p.stdout.strip())
    if p.stderr:
        print(p.stderr.strip(), file=sys.stderr)
    return p.returncode


def main():
    if len(sys.argv) < 2:
        print("Usage: control.py <start|enable|disable|stop|status>")
        sys.exit(1)

    cmd = sys.argv[1].lower()
    if cmd not in {"start", "enable", "disable", "stop", "status"}:
        print(f"Unknown command: {cmd}")
        sys.exit(1)

    if cmd == "start":
        sys.exit(0 if start_background() else 1)

    if cmd == "status":
        sys.exit(print_status())

    if cmd in {"enable", "disable"}:
        if not start_background():
            sys.exit(1)

    p = run(cmd)
    if p.stdout:
        print(p.stdout.strip())
    if p.stderr:
        print(p.stderr.strip(), file=sys.stderr)
    sys.exit(p.returncode)


if __name__ == "__main__":
    main()
