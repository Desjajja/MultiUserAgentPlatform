#!/usr/bin/env python3
"""
MQTT Experiment Mode Daemon

- Long-running daemon process
- Local mode control via POSIX signals:
  - SIGUSR1: enable experiment mode
  - SIGUSR2: disable experiment mode
  - SIGTERM/SIGINT: stop daemon
- Subscribes to commands topic only when experiment_mode=true
- Uses worker thread + queue to avoid blocking MQTT callback thread
"""

import json
import os
import queue
import signal
import subprocess
import sys
import threading
import time
from collections import OrderedDict
from datetime import datetime
from pathlib import Path

import paho.mqtt.client as mqtt

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import config


class DeduplicationCache:
    def __init__(self, max_size=1000, ttl_seconds=60):
        self.cache = OrderedDict()  # key -> timestamp (float)
        self.max_size = max_size
        self.ttl_seconds = ttl_seconds
        self.lock = threading.Lock()

    def is_duplicate(self, key: str) -> bool:
        now = time.time()
        with self.lock:
            # 清理过期条目
            expired = [k for k, ts in self.cache.items() if now - ts > self.ttl_seconds]
            for k in expired:
                del self.cache[k]

            if key in self.cache:
                return True
            self.cache[key] = now
            if len(self.cache) > self.max_size:
                self.cache.popitem(last=False)
            return False


class MQTTDaemon:
    def __init__(self):
        self.client = None
        self.experiment_mode = False
        self.connected = False
        self.reconnect_delay = config.INITIAL_RECONNECT_DELAY
        self.dedup_cache = DeduplicationCache(config.DEDUP_CACHE_SIZE, config.DEDUP_TTL_SECONDS)
        self.running = False
        self.lock = threading.Lock()

        self.command_queue: queue.Queue[str] = queue.Queue()
        self.worker_thread = threading.Thread(target=self._worker_loop, daemon=True)

        self._load_state()

    def _load_state(self):
        try:
            if os.path.exists(config.STATE_FILE):
                with open(config.STATE_FILE, "r", encoding="utf-8") as f:
                    data = json.load(f)
                self.experiment_mode = bool(data.get("experiment_mode", False))
                print(f"[State] Loaded experiment_mode={self.experiment_mode}")
        except Exception as e:
            print(f"[State] Failed to load state: {e}")

    def _save_state(self):
        payload = {
            "running": self.running,
            "connected": self.connected,
            "experiment_mode": self.experiment_mode,
            "broker": f"{config.BROKER}:{config.PORT}",
            "pid": os.getpid(),
            "updated_at": datetime.now().isoformat(),
        }
        try:
            with open(config.STATE_FILE, "w", encoding="utf-8") as f:
                json.dump(payload, f)
        except Exception as e:
            print(f"[State] Failed to save state: {e}")

    def _write_pid(self):
        try:
            with open(config.PID_FILE, "w", encoding="utf-8") as f:
                f.write(str(os.getpid()))
        except Exception as e:
            print(f"[Daemon] Failed to write pid file: {e}")

    def _remove_pid(self):
        try:
            if os.path.exists(config.PID_FILE):
                os.remove(config.PID_FILE)
        except Exception as e:
            print(f"[Daemon] Failed to remove pid file: {e}")

    def _publish_status(self, status: str, experiment_mode: bool, raw_text: str = "", error: str = ""):
        if not self.client or not self.connected:
            return
        msg = {
            "status": status,
            "experiment_mode": experiment_mode,
            "timestamp": int(time.time()),
        }
        if raw_text:
            msg["raw_text"] = raw_text
        if error:
            msg["error"] = error
        try:
            self.client.publish(config.STATUS_TOPIC, json.dumps(msg, ensure_ascii=False), qos=1)
        except Exception as e:
            print(f"[MQTT] publish status failed: {e}")

    def _get_client(self):
        client = mqtt.Client(client_id=config.CLIENT_ID, protocol=mqtt.MQTTv5)
        if config.TLS_ENABLED:
            client.tls_set()
            if config.TLS_INSECURE:
                client.tls_insecure_set(True)

        if config.USERNAME:
            client.username_pw_set(config.USERNAME, config.PASSWORD)

        client.on_connect = self._on_connect
        client.on_disconnect = self._on_disconnect
        client.on_message = self._on_message
        client.on_log = self._on_log
        return client

    def _on_connect(self, client, userdata, flags, rc, properties=None):
        if rc == 0:
            self.connected = True
            self.reconnect_delay = config.INITIAL_RECONNECT_DELAY
            print(f"[MQTT] Connected to {config.BROKER}:{config.PORT}")
            with self.lock:
                if self.experiment_mode:
                    client.subscribe(config.COMMANDS_TOPIC, qos=1)
                    print(f"[MQTT] Subscribed to {config.COMMANDS_TOPIC}")
            self._save_state()
        else:
            print(f"[MQTT] Connection failed rc={rc}")

    def _on_disconnect(self, client, userdata, rc):
        self.connected = False
        self._save_state()
        if self.running and rc != 0:
            print(f"[MQTT] Unexpected disconnect rc={rc}, reconnecting...")
            self._schedule_reconnect()

    def _on_message(self, client, userdata, msg):
        try:
            payload = msg.payload.decode("utf-8")
            data = json.loads(payload)
        except Exception as e:
            print(f"[MQTT] Bad payload: {e}")
            return

        if data.get("action") != "voice_command":
            return

        with self.lock:
            if not self.experiment_mode:
                print("[MQTT] Ignore command (experiment_mode=false)")
                return

        raw_text = (data.get("raw_text") or "").strip()
        ts = data.get("timestamp")
        if not raw_text:
            print("[MQTT] Missing raw_text")
            return

        dedup_key = f"{ts}_{raw_text}" if ts is not None else raw_text
        if self.dedup_cache.is_duplicate(dedup_key):
            print(f"[MQTT] Duplicate ignored: {dedup_key}")
            return

        self.command_queue.put(raw_text)
        print(f"[MQTT] Enqueued command: {raw_text}")

    def _worker_loop(self):
        while self.running:
            try:
                raw_text = self.command_queue.get(timeout=1)
            except queue.Empty:
                continue

            self._publish_status("executing", self.experiment_mode, raw_text=raw_text)
            cmd = ["openclaw", "agent", "--message", raw_text, "--json"]
            if config.OPENCLAW_AGENT_ID:
                cmd.extend(["--agent", config.OPENCLAW_AGENT_ID])
            elif config.OPENCLAW_SESSION_ID:
                cmd.extend(["--session-id", config.OPENCLAW_SESSION_ID])
            elif config.OPENCLAW_TO:
                cmd.extend(["--to", config.OPENCLAW_TO])
            if config.OPENCLAW_DEFAULT_CHANNEL:
                cmd.extend(["--channel", config.OPENCLAW_DEFAULT_CHANNEL])
            if config.OPENCLAW_DELIVER:
                cmd.append("--deliver")
            if config.OPENCLAW_REPLY_CHANNEL:
                cmd.extend(["--reply-channel", config.OPENCLAW_REPLY_CHANNEL])
            if config.OPENCLAW_REPLY_TO:
                cmd.extend(["--reply-to", config.OPENCLAW_REPLY_TO])
            try:
                result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
                if result.returncode == 0:
                    self._publish_status("done", self.experiment_mode, raw_text=raw_text)
                    print(f"[Exec] done: {raw_text}")
                else:
                    err = (result.stderr or "command failed")[:300]
                    self._publish_status("error", self.experiment_mode, raw_text=raw_text, error=err)
                    print(f"[Exec] failed: {err}")
            except subprocess.TimeoutExpired:
                self._publish_status("error", self.experiment_mode, raw_text=raw_text, error="timeout")
                print("[Exec] timeout")
            except Exception as e:
                self._publish_status("error", self.experiment_mode, raw_text=raw_text, error=str(e)[:300])
                print(f"[Exec] error: {e}")

    def _on_log(self, client, userdata, level, buf):
        if level >= mqtt.MQTT_LOG_WARNING:
            print(f"[MQTT] {buf}")

    def _schedule_reconnect(self):
        def do_reconnect():
            if not self.running:
                return
            try:
                self.client.reconnect()
            except Exception as e:
                print(f"[MQTT] reconnect failed: {e}, next in {self.reconnect_delay}s")
                self.reconnect_delay = min(self.reconnect_delay * 2, config.MAX_RECONNECT_DELAY)
                threading.Timer(self.reconnect_delay, do_reconnect).start()

        threading.Timer(self.reconnect_delay, do_reconnect).start()

    def enable(self):
        with self.lock:
            if self.experiment_mode:
                return
            self.experiment_mode = True
            if self.connected and self.client:
                self.client.subscribe(config.COMMANDS_TOPIC, qos=1)
            self._save_state()
            self._publish_status("mode_changed", True)
            print("[Mode] enabled")

    def disable(self):
        with self.lock:
            if not self.experiment_mode:
                return
            self.experiment_mode = False
            if self.connected and self.client:
                self.client.unsubscribe(config.COMMANDS_TOPIC)
            self._save_state()
            self._publish_status("mode_changed", False)
            print("[Mode] disabled")

    def stop(self):
        if not self.running:
            return
        print("[Daemon] stopping...")
        self.running = False
        self._save_state()
        if self.client:
            self.client.loop_stop()
            self.client.disconnect()
        self._remove_pid()

    def start_forever(self):
        self.running = True

        def _sig_enable(signum, frame):
            self.enable()

        def _sig_disable(signum, frame):
            self.disable()

        def _sig_stop(signum, frame):
            self.stop()

        signal.signal(signal.SIGUSR1, _sig_enable)
        signal.signal(signal.SIGUSR2, _sig_disable)
        signal.signal(signal.SIGTERM, _sig_stop)
        signal.signal(signal.SIGINT, _sig_stop)

        self._write_pid()
        self._save_state()

        self.client = self._get_client()
        self.client.connect(config.BROKER, config.PORT, keepalive=60)
        self.client.loop_start()

        self.worker_thread.start()

        print(f"[Daemon] started pid={os.getpid()}")
        try:
            while self.running:
                time.sleep(1)
        finally:
            self.stop()


def _read_pid() -> int:
    if not os.path.exists(config.PID_FILE):
        return 0
    try:
        return int(Path(config.PID_FILE).read_text(encoding="utf-8").strip())
    except Exception:
        return 0


def _is_pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _status_payload() -> dict:
    payload = {
        "running": False,
        "connected": False,
        "experiment_mode": False,
        "broker": f"{config.BROKER}:{config.PORT}",
        "pid": 0,
    }
    if os.path.exists(config.STATE_FILE):
        try:
            with open(config.STATE_FILE, "r", encoding="utf-8") as f:
                payload.update(json.load(f))
        except Exception:
            pass

    pid = _read_pid()
    payload["pid"] = pid
    payload["running"] = _is_pid_alive(pid)
    return payload


def _send_signal(sig: int) -> int:
    pid = _read_pid()
    if not _is_pid_alive(pid):
        print("[Daemon] not running")
        return 1
    os.kill(pid, sig)
    return 0


def main():
    if len(sys.argv) < 2:
        print("Usage: mqtt_daemon.py <start|enable|disable|stop|status>")
        sys.exit(1)

    cmd = sys.argv[1].lower()

    if cmd == "start":
        pid = _read_pid()
        if _is_pid_alive(pid):
            print(f"[Daemon] already running pid={pid}")
            return
        daemon = MQTTDaemon()
        daemon.start_forever()
        return

    if cmd == "enable":
        sys.exit(_send_signal(signal.SIGUSR1))

    if cmd == "disable":
        sys.exit(_send_signal(signal.SIGUSR2))

    if cmd == "stop":
        sys.exit(_send_signal(signal.SIGTERM))

    if cmd == "status":
        print(json.dumps(_status_payload(), ensure_ascii=False, indent=2))
        return

    print(f"Unknown command: {cmd}")
    sys.exit(1)


if __name__ == "__main__":
    main()
