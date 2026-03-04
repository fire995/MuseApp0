import json
import base64
import re
import os
import csv
from datetime import datetime
import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
import uvicorn

app = FastAPI()

channel_buffers = {'0013': []}
ctrl_buffer = ""
DATA_DIR = "sleep_logs"
os.makedirs(DATA_DIR, exist_ok=True)

def log_to_csv(sig_q, drowsy):
    """自动落盘进程"""
    today = datetime.now().strftime("%Y-%m-%d")
    path = os.path.join(DATA_DIR, f"sleep_{today}.csv")
    exists = os.path.exists(path)
    try:
        with open(path, "a", newline="", encoding="utf-8") as f:
            writer = csv.writer(f)
            if not exists: writer.writerow(["Time", "Signal", "Drowsiness"])
            writer.writerow([datetime.now().strftime("%H:%M:%S"), sig_q, drowsy])
    except Exception:
        pass

# remove the decode_eeg_universal function as we'll integrate its logic directly

def calculate_metrics(data):
    if len(data) < 256: return 0, 0
    # 信号质量评估
    std = np.std(data)
    max_v = np.max(data)
    min_v = np.min(data)
    if std < 1 or std > 400 or (max_v - min_v) < 2: sig_q = 5
    elif std > 150: sig_q = 40
    else: sig_q = 100
    
    # 困倦度计算: (Theta + Alpha) / Beta 功率比
    fft = np.absolute(np.fft.rfft(data))
    freqs = np.fft.rfftfreq(len(data), 1.0/256)
    
    def pwr(f1, f2): 
        idx = np.where((freqs >= f1) & (freqs <= f2))[0]
        return np.sum(fft[idx]) if len(idx) > 0 else 0.001
    
    ratio = (pwr(4, 8) + pwr(8, 13)) / pwr(13, 30)
    drowsiness = int(max(0, min(100, (ratio - 1.2) / 3.8 * 100)))
    
    return sig_q, drowsiness

@app.websocket("/ws/eeg")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    global ctrl_buffer
    print("🟢 [后端] 链路激活，数据落盘守护进程已启动...")
    
    try:
        while True:
            try:
                raw_payload = await websocket.receive_text()
                try:
                    packet = json.loads(raw_payload)
                except json.JSONDecodeError:
                    continue
                    
                channel = packet.get("channel", "unknown")
                data_b64 = packet.get("data", "")

                if channel == "0001":
                    chunk = base64.b64decode(data_b64).decode('utf-8', errors='ignore')
                    ctrl_buffer += chunk
                    match = re.search(r'"bp":\s*(\d+)', ctrl_buffer)
                    if match:
                        await websocket.send_json({"type": "battery", "value": int(match.group(1))})
                        ctrl_buffer = ""
                    if len(ctrl_buffer) > 1000: ctrl_buffer = ctrl_buffer[-500:]

                elif channel == "0013":
                    raw = base64.b64decode(data_b64)
                    # 解析20字节数据块中的EEG样本
                    samples = []
                    # Process up to 20 bytes (one packet) with proper bounds checking
                    end_idx = min(20, len(raw) - 2)
                    for i in range(2, end_idx, 3):
                        if i + 2 >= len(raw): break
                        b1, b2, b3 = raw[i], raw[i+1], raw[i+2]
                        # 解包两个样本值
                        val1 = (b1 << 4) | (b2 >> 4)
                        val2 = ((b2 & 0x0F) << 8) | b3
                        samples.append(round((val1 - 2048) * 0.475, 2))
                        samples.append(round((val2 - 2048) * 0.475, 2))
                    
                    if samples: 
                        channel_buffers['0013'].extend(samples)
                        # 当收集到足够的数据时进行处理
                        if len(channel_buffers['0013']) >= 256:
                            window = channel_buffers['0013'][:256]
                            q, d = calculate_metrics(window)
                            log_to_csv(q, d)
                            
                            await websocket.send_json({
                                "type": "metrics", 
                                "signal": q, 
                                "drowsiness": d
                            })
                            channel_buffers['0013'] = channel_buffers['0013'][256:]

                        # 发送预览数据用于可视化
                        mean_v = sum(samples) / len(samples)
                        await websocket.send_json({
                            "type": "eeg_preview", 
                            "data": [round(v - mean_v, 2) for v in samples[::2]]
                        })
            except Exception as e:
                print(f"Error processing message: {e}")
                continue  # 静默处理异常，保持连接
    except WebSocketDisconnect:
        pass

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8001)