import base64
import io
import json
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import pyautogui

pyautogui.PAUSE = 0.05

HOST = "0.0.0.0"
PORT = 8000


class RemoteAgentHandler(BaseHTTPRequestHandler):
    def _send_json(self, status_code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _ok(self, **data):
        payload = {"success": True}
        payload.update(data)
        self._send_json(200, payload)

    def _bad_request(self, message):
        self._send_json(400, {"success": False, "error": message})

    def _server_error(self, error):
        self._send_json(500, {"success": False, "error": str(error)})

    def _get_required_param(self, params, name):
        value = params.get(name, [None])[0]
        if value is None or value == "":
            raise ValueError(f"Missing required parameter: {name}")
        return value

    def _get_int_param(self, params, name):
        value = self._get_required_param(params, name)
        try:
            return int(value)
        except ValueError:
            raise ValueError(f"Invalid integer parameter: {name}")

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        params = parse_qs(parsed.query)

        try:
            if path == "/run_exe":
                exe_path = self._get_required_param(params, "path")
                subprocess.Popen([exe_path], shell=False)
                self._ok(action="run_exe", path=exe_path)

            elif path == "/click":
                x = self._get_int_param(params, "x")
                y = self._get_int_param(params, "y")
                pyautogui.moveTo(x, y, duration=0.1)
                pyautogui.click(x, y)
                self._ok(action="click", x=x, y=y)

            elif path == "/double_click":
                x = self._get_int_param(params, "x")
                y = self._get_int_param(params, "y")
                pyautogui.moveTo(x, y, duration=0.1)
                pyautogui.doubleClick(x, y)
                self._ok(action="double_click", x=x, y=y)

            elif path == "/right_click":
                x = self._get_int_param(params, "x")
                y = self._get_int_param(params, "y")
                pyautogui.moveTo(x, y, duration=0.1)
                pyautogui.rightClick(x, y)
                self._ok(action="right_click", x=x, y=y)

            elif path == "/move":
                x = self._get_int_param(params, "x")
                y = self._get_int_param(params, "y")
                pyautogui.moveTo(x, y)
                self._ok(action="move", x=x, y=y)

            elif path == "/scroll":
                x = self._get_int_param(params, "x")
                y = self._get_int_param(params, "y")
                clicks = self._get_int_param(params, "clicks")
                pyautogui.scroll(clicks, x=x, y=y)
                self._ok(action="scroll", x=x, y=y, clicks=clicks)

            elif path == "/key":
                key = self._get_required_param(params, "key")
                pyautogui.press(key)
                self._ok(action="key", key=key)

            elif path == "/hotkey":
                keys_raw = self._get_required_param(params, "keys")
                keys = [key.strip() for key in keys_raw.split(",") if key.strip()]
                if not keys:
                    raise ValueError("Invalid parameter: keys")
                pyautogui.hotkey(*keys)
                self._ok(action="hotkey", keys=keys)

            elif path == "/type":
                text = self._get_required_param(params, "text")
                pyautogui.write(text)
                self._ok(action="type", text=text)

            elif path == "/screen_size":
                width, height = pyautogui.size()
                self._ok(width=width, height=height)

            elif path == "/screenshot":
                image = pyautogui.screenshot()
                image_width, image_height = image.size
                screen_width, screen_height = pyautogui.size()

                buffer = io.BytesIO()
                image.save(buffer, format="PNG")
                image_base64 = base64.b64encode(buffer.getvalue()).decode("utf-8")

                self._ok(
                    image_base64=image_base64,
                    image_width=image_width,
                    image_height=image_height,
                    screen_width=screen_width,
                    screen_height=screen_height,
                )

            elif path == "/health":
                self._ok(status="ok", message="Remote agent is running")

            else:
                self._send_json(404, {"success": False, "error": "Not found"})

        except ValueError as error:
            self._bad_request(str(error))
        except Exception as error:
            self._server_error(error)

    def log_message(self, format, *args):
        return


if __name__ == "__main__":
    server = ThreadingHTTPServer((HOST, PORT), RemoteAgentHandler)
    print(f"Remote agent listening on http://{HOST}:{PORT}")
    server.serve_forever()
