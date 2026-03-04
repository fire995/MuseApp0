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

# 核心缓存与目录
channel_buffers = {'0013': []}
ctrl_buffer = ""
DATA_DIR = "sleep_logs"
os.makedirs(DATA_DIR, exist_ok=True)

def log_to_csv(sig_q, drowsy):
    """【新增】数据自动落盘，第二天复盘核心依据"""
    today = datetime.now().strftime("%Y-%m-%d")
    path = os.path.join(DATA_DIR, f"sleep_{today}.csv")
    exists = os.path.exists(path)
    with open(path, "a", newline="") as f:
        writer = csv.writer(f)
        if not exists: writer.writerow(["Time", "Signal", "Drowsiness"])
        writer.writerow([datetime.now().strftime("%H:%M:%S"), sig_q, drowsy])

def calculate_metrics_refined(data):
    """【参考 amused-py 优化】科学计算信号与困意"""
    if len(data) < 256: return 0, 0
    
    # 1. 信号质量 (基于方差与饱和度检测)
    std = np.std(data)
    amp = np.max(data) - np.min(data)
    if std < 1 or std > 400 or amp < 2: sig_q = 5 # 极差/脱落
    elif std > 150: sig_q = 40 # 接触一般
    else: sig_q = 100
    
    # 2. 困意指数 (学术标准公式: (Theta + Alpha) / Beta)
    fft_vals = np.absolute(np.fft.rfft(data))
    fft_freqs = np.fft.rfftfreq(len(data), 1.0/256)
    
    def band_pwr(f1, f2):
        idx = np.where((fft_freqs >= f1) & (fft_freqs <= f2))[0]
        return np.sum(fft_vals[idx]) if len(idx) > 0 else 0.01

    t, a, b = band_pwr(4, 8), band_pwr(8, 13), band_pwr(13, 30)
    # 比值越高 = 大脑越放松/困倦
    ratio = (t + a) / b
    # 归一化映射：将 ratio 从 1.2-5.0 映射到 0-100%
    drowsy = int(max(0, min(100, ((ratio - 1.2) / 3.8) * 100)))
    
    return int(sig_q), drowsy

@app.websocket("/ws/eeg")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    global ctrl_buffer
    print("🟢 [后端] 睡眠监测引擎已启动，数据落盘守护中...")
    try:
        while True:
            try:
                msg = await websocket.receive_text()
                pkt = json.loads(msg)
                chan, b64 = pkt.get("channel"), pkt.get("data", "")
                
                # 电量正则解析 (防分包)
                if chan == "0001":
                    ctrl_buffer += base64.b64decode(b64).decode('utf-8','ignore')
                    m = re.search(r'"bp":\s*(\d+)', ctrl_buffer)
                    if m:
                        await websocket.send_json({"type": "battery", "value": int(m.group(1))})
                        ctrl_buffer = ""

                # 脑电解析与指标计算
                elif chan == "0013":
                    raw = base64.b64decode(b64)
                    if len(raw) >= 20:
                        samples = []
                        for i in range(2, 20-2, 3):
                            b1,b2,b3 = raw[i], raw[i+1], raw[i+2]
                            samples.append(round(((b1<<4)|(b2>>4) - 2048)*0.475, 2))
                            samples.append(round((((b2&0x0F)<<8)|b3 - 2048)*0.475, 2))
                        
                        channel_buffers['0013'].extend(samples)
                        if len(channel_buffers['0013']) >= 256:
                            q, d = calculate_metrics_refined(channel_buffers['0013'][:256])
                            log_to_csv(q, d) # 实时落盘
                            await websocket.send_json({"type": "metrics", "signal": q, "drowsiness": d})
                            channel_buffers['0013'] = channel_buffers['0013'][256:]
                        
                        await websocket.send_json({"type": "eeg_preview", "data": samples[::2]})
            except Exception: continue
    except WebSocketDisconnect: print("🔴 链路挂起")

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8001)
