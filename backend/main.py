import json
import base64
import re
import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
import uvicorn

app = FastAPI()

# --- 协议常量 (Athena 规范) ---
EEG_SCALE = 1000.0 / 2048.0
CH_NAMES = ['TP9', 'AF7', 'AF8', 'TP10', 'FPz', 'AUX_R', 'AUX_L']
# 脑电采样率通常为 256Hz
FS = 256 

# 每个通道独立的 1 秒缓冲区 (用于 FFT 频率分析)
channel_buffers = {name: [] for name in CH_NAMES}
ctrl_buffer = ""

def decode_athena_eeg_backup(base64_data):
    """【恢复备份内核】最稳定的 12-bit 暴力解包逻辑"""
    try:
        raw_bytes = base64.b64decode(base64_data)
        if len(raw_bytes) < 5: return []
        samples = []
        # 每 3 字节解析 2 个采样点
        for i in range(2, len(raw_bytes) - 2, 3):
            if i + 2 >= len(raw_bytes): break
            b1, b2, b3 = raw_bytes[i], raw_bytes[i+1], raw_bytes[i+2]
            val1 = (b1 << 4) | (b2 >> 4)
            val2 = ((b2 & 0x0F) << 8) | b3
            samples.append(round((val1 - 2048) * 0.475, 2))
            samples.append(round((val2 - 2048) * 0.475, 2))
        return samples
    except: return []

def calculate_sleep_metrics(buffers):
    """
    计算困意指数与信号质量
    逻辑：Theta+Delta (慢波) 占比上升 = 困意增加
    """
    # 选取 AF7/AF8 前额通道计算
    data = np.array(buffers['AF7'][-256:])
    if len(data) < 256: return 0, 0
    
    # 1. 信号质量 (Horseshoe): 提取 50Hz 工频电磁干扰
    fft_vals = np.absolute(np.fft.rfft(data))
    fft_freqs = np.fft.rfftfreq(len(data), 1.0/FS)
    
    # 抓取 45Hz - 55Hz 频段的能量
    noise_idx = np.where((fft_freqs >= 45) & (fft_freqs <= 55))[0]
    line_noise_power = np.sum(fft_vals[noise_idx]) if len(noise_idx) > 0 else 0
    
    # 阻抗/天线效应映射: 干扰能量越高，信号越差
    if line_noise_power > 1500:
        sig_q = 5    # 极差 (未佩戴)
    elif line_noise_power > 300:
        sig_q = 40   # 一般 (接触不良)
    else:
        sig_q = 100  # 完美 (完全贴合，屏蔽了环境电磁波)
    
    # 2. 计算困意指数 (FFT 频域分析)
    fft_vals = np.absolute(np.fft.rfft(data))
    fft_freqs = np.fft.rfftfreq(len(data), 1.0/FS)
    
    def get_power(f_low, f_high):
        idx = np.where((fft_freqs >= f_low) & (fft_freqs <= f_high))[0]
        return np.sum(fft_vals[idx]) if len(idx) > 0 else 0.001

    slow = get_power(0.5, 8)  # Delta + Theta
    fast = get_power(8, 30)   # Alpha + Beta
    
    ratio = slow / (slow + fast)
    drowsiness = (ratio - 0.3) / 0.5 * 100 # 归一化映射
    return int(sig_q), int(max(0, min(100, drowsiness)))

@app.websocket("/ws/eeg")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    global ctrl_buffer
    print("🟢 [后端] 数据链路已激活，实时分析中...")

    try:
        while True:
            raw_payload = await websocket.receive_text()
            packet = json.loads(raw_payload)
            channel = packet.get("channel", "unknown")
            data_b64 = packet.get("data", "")

            # 1. 电量解析：废弃 JSON 解析，采用 Regex 正则强制提取
            if channel == "0001":
                chunk = base64.b64decode(data_b64).decode('utf-8', errors='ignore')
                ctrl_buffer += chunk
                
                # 直接通过正则匹配 "bp": 数字，无视任何断包或括号丢失
                match = re.search(r'"bp":\s*(\d+)', ctrl_buffer)
                if match:
                    bp_val = int(match.group(1))
                    await websocket.send_json({"type": "battery", "value": bp_val})
                    # 提取成功后清空缓冲，避免重复发送
                    ctrl_buffer = ""
                
                # 防止游标缓冲无限膨胀导致内存溢出
                if len(ctrl_buffer) > 1000:
                    ctrl_buffer = ctrl_buffer[-500:]

            # 2. 脑电数据处理与多指标计算
            elif channel == "0013":
                flat_samples = decode_athena_eeg_backup(data_b64)
                if len(flat_samples) >= 84:
                    # 通道物理分流
                    for i, name in enumerate(CH_NAMES):
                        channel_buffers[name].extend(flat_samples[i*12 : (i+1)*12])
                    
                    # 每秒计算一次核心指标
                    if len(channel_buffers['AF7']) >= 256:
                        sig_q, drowsy = calculate_sleep_metrics(channel_buffers)
                        await websocket.send_json({"type": "metrics", "signal": sig_q, "drowsiness": drowsy})
                        # 清理缓存
                        for name in CH_NAMES: channel_buffers[name] = channel_buffers[name][256:]

                    # 仅推送 AF7 用于前端波形预览 (降采样)
                    af7_data = flat_samples[12:24]
                    mean = sum(af7_data) / 12
                    await websocket.send_json({"type": "eeg_preview", "data": [round(v-mean,2) for v in af7_data[::2]]})

    except WebSocketDisconnect: pass

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8001)
