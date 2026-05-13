#!/usr/bin/env python3
"""
voice_asr.py - 语音转文字服务

功能：
1. 实时监听麦克风
2. VAD 检测说话开始/结束
3. 音频流 → 讯飞 ASR → 文字
4. 文字 → 飞书消息（或直接输出）

依赖：
pip install pyaudio webrtcvad websocket-client

讯飞 API 配置：
https://www.xfyun.cn/doc/asr/voicedictation/API.html
"""

import pyaudio
import webrtcvad
import websocket
import json
import hmac
import hashlib
import base64
import datetime
from urllib.parse import urlencode
import threading
import time
import sys

# ============================================================
# 配置
# ============================================================

# 讯飞 API 配置（替换成你的）
XF_APP_ID = "YOUR_APP_ID"
XF_API_KEY = "YOUR_API_KEY"
XF_API_SECRET = "YOUR_API_SECRET"
XF_ASR_URL = "wss://iat-api.xfyun.cn/v2/iat"

# 音频配置
SAMPLE_RATE = 16000
CHANNELS = 1
CHUNK_SIZE = 320  # 20ms @ 16kHz
VAD_MODE = 3  # 0-3，越大越激进

# 输出配置
OUTPUT_TO_FEISHU = False  # 是否发送到飞书
FEISHU_WEBHOOK = ""  # 飞书 webhook URL（可选）

# ============================================================


class VoiceASR:
    def __init__(self):
        self.vad = webrtcvad.Vad(VAD_MODE)
        self.audio = pyaudio.PyAudio()
        self.is_speaking = False
        self.audio_buffer = []
        self.ws = None
        self.first_frame = True
        self.recognized_text = []
        
    def get_url(self):
        """生成讯飞 WebSocket 鉴权 URL"""
        now = datetime.datetime.now()
        date = now.strftime("%a, %d %b %Y %H:%M:%S GMT")
        
        signature_origin = f"host: iat-api.xfyun.cn\ndate: {date}\nGET /v2/iat HTTP/1.1"
        signature_sha = hmac.new(
            XF_API_SECRET.encode(),
            signature_origin.encode(),
            digestmod=hashlib.sha256
        ).digest()
        signature_sha_base64 = base64.b64encode(signature_sha).decode()
        
        authorization_origin = f'api_key="{XF_API_KEY}", algorithm="hmac-sha256", headers="host date request-line", signature="{signature_sha_base64}"'
        authorization = base64.b64encode(authorization_origin.encode()).decode()
        
        url = XF_ASR_URL + "?" + urlencode({
            "authorization": authorization,
            "date": date,
            "host": "iat-api.xfyun.cn"
        })
        
        return url
    
    def on_ws_open(self, ws):
        """WebSocket 连接建立"""
        print("[ASR] 已连接到讯飞 ASR 服务")
        self.first_frame = True
        self.recognized_text = []
    
    def on_ws_message(self, ws, message):
        """接收 ASR 识别结果"""
        try:
            data = json.loads(message)
            code = data.get("code", 0)
            
            if code != 0:
                print(f"[ASR] 错误：{data.get('message', '未知错误')}")
                return
            
            # 解析识别结果
            result = data.get("data", {}).get("result", {})
            sn = result.get("sn", "")
            rg = result.get("rg", [])
            ws_data = result.get("ws", [])
            
            # 提取文字
            text = ""
            for ws_item in ws_data:
                for cw in ws_item.get("cw", []):
                    text += cw.get("w", "")
            
            if text:
                self.recognized_text.append(text)
                print(f"[ASR] 识别中：{''.join(self.recognized_text)}")
            
            # 最后一条结果
            if "2" in sn:
                full_text = "".join(self.recognized_text)
                print(f"[ASR] ✅ 最终识别：{full_text}")
                self.on_speech_end(full_text)
                self.recognized_text = []
                
        except Exception as e:
            print(f"[ASR] 解析错误：{e}")
    
    def on_ws_error(self, ws, error):
        """WebSocket 错误"""
        print(f"[ASR] 错误：{error}")
    
    def on_ws_close(self, ws, close_status_code, close_msg):
        """WebSocket 关闭"""
        print(f"[ASR] 连接关闭：{close_status_code} {close_msg}")
    
    def connect_asr(self):
        """连接讯飞 ASR"""
        url = self.get_url()
        self.ws = websocket.WebSocketApp(
            url,
            on_open=self.on_ws_open,
            on_message=self.on_ws_message,
            on_error=self.on_ws_error,
            on_close=self.on_ws_close
        )
        
        # 在新线程中运行 WebSocket
        ws_thread = threading.Thread(target=self.ws.run_forever)
        ws_thread.daemon = True
        ws_thread.start()
        time.sleep(1)  # 等待连接建立
    
    def send_audio(self, audio_data):
        """发送音频到 ASR"""
        if not self.ws or not self.ws.sock or not self.ws.sock.connected:
            self.connect_asr()
        
        # 第一帧包含配置
        if self.first_frame:
            frame_data = {
                "common": {
                    "app_id": XF_APP_ID
                },
                "business": {
                    "language": "zh_cn",
                    "domain": "iat",
                    "accent": "mandarin"
                },
                "data": {
                    "status": 0,
                    "format": "audio/L16;rate=16000",
                    "encoding": "raw",
                    "data": base64.b64encode(audio_data).decode()
                }
            }
            self.first_frame = False
        else:
            frame_data = {
                "data": {
                    "status": 0,
                    "format": "audio/L16;rate=16000",
                    "encoding": "raw",
                    "data": base64.b64encode(audio_data).decode()
                }
            }
        
        self.ws.send(json.dumps(frame_data))
    
    def end_asr(self):
        """结束 ASR 识别"""
        if self.ws and self.ws.sock and self.ws.sock.connected:
            frame_data = {
                "data": {
                    "status": 2,
                    "format": "audio/L16;rate=16000",
                    "encoding": "raw",
                    "data": ""
                }
            }
            self.ws.send(json.dumps(frame_data))
    
    def on_speech_end(self, text):
        """说话结束回调"""
        if not text.strip():
            return
        
        print(f"\n[语音指令] {text}\n")
        
        # 输出到飞书（可选）
        if OUTPUT_TO_FEISHU and FEISHU_WEBHOOK:
            self.send_to_feishu(text)
    
    def send_to_feishu(self, text):
        """发送文字到飞书"""
        import urllib.request
        
        payload = {
            "msg_type": "text",
            "content": {"text": f"🎤 语音指令：{text}"}
        }
        
        data = json.dumps(payload).encode()
        req = urllib.request.Request(
            FEISHU_WEBHOOK,
            data=data,
            headers={"Content-Type": "application/json"}
        )
        
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                print(f"[飞书] 消息已发送")
        except Exception as e:
            print(f"[飞书] 发送失败：{e}")
    
    def listen(self):
        """开始监听麦克风"""
        print("[语音服务] 开始监听... (按 Ctrl+C 停止)")
        
        # 连接 ASR
        self.connect_asr()
        
        # 打开麦克风
        stream = self.audio.open(
            format=pyaudio.paInt16,
            channels=CHANNELS,
            rate=SAMPLE_RATE,
            input=True,
            frames_per_buffer=CHUNK_SIZE
        )
        
        try:
            while True:
                # 读取一帧音频（20ms）
                frame = stream.read(CHUNK_SIZE, exception_on_overflow=False)
                
                # VAD 检测是否有人声
                try:
                    is_speech = self.vad.is_speech(frame, SAMPLE_RATE)
                except Exception:
                    is_speech = False
                
                if is_speech:
                    if not self.is_speaking:
                        # 开始说话
                        self.is_speaking = True
                        self.audio_buffer = []
                        print("[语音服务] 🎤 检测到说话...")
                    
                    self.audio_buffer.append(frame)
                else:
                    if self.is_speaking:
                        self.audio_buffer.append(frame)
                        
                        # 说话结束（静音超过阈值）
                        if len(self.audio_buffer) > 50:  # 约 1 秒静音
                            # 发送音频到 ASR
                            audio_data = b''.join(self.audio_buffer)
                            self.send_audio(audio_data)
                            self.end_asr()
                            
                            self.is_speaking = False
                            self.audio_buffer = []
                            print("[语音服务] ⏸️ 说话结束")
                            
        except KeyboardInterrupt:
            print("\n[语音服务] 停止监听")
        finally:
            stream.stop_stream()
            stream.close()
            if self.ws:
                self.ws.close()
            self.audio.terminate()


def main():
    print("=" * 60)
    print("语音转文字服务 (ASR)")
    print("=" * 60)
    print(f"采样率：{SAMPLE_RATE} Hz")
    print(f"VAD 模式：{VAD_MODE} (0-3)")
    print(f"输出到飞书：{OUTPUT_TO_FEISHU}")
    print("-" * 60)
    
    # 检查配置
    if XF_APP_ID == "YOUR_APP_ID":
        print("⚠️  请先配置讯飞 API 密钥！")
        print("   编辑本文件，修改 XF_APP_ID, XF_API_KEY, XF_API_SECRET")
        print("   注册地址：https://www.xfyun.cn/")
        sys.exit(1)
    
    asr = VoiceASR()
    asr.listen()


if __name__ == "__main__":
    main()
