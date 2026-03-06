import json
import base64
import re
import os
import csv
from datetime import datetime
import numpy as np
from scipy.signal import find_peaks
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
import uvicorn

app = FastAPI()

DATA_DIR = "sleep_logs"
os.makedirs(DATA_DIR, exist_ok=True)

SAMPLE_RATE   = 256
EEG_PRIMARY   = '0013'
EEG_CHANNELS  = ['0013', '0014', '0015', '0016']
PPG_IR       = '0010'
PPG_RED      = '0011'
PPG_CHANNELS = [PPG_IR, PPG_RED]


class SessionState:
    def __init__(self):
        self.save_raw     = False
        self.packet_total = 0
        self.ch_counts    = {ch: 0 for ch in EEG_CHANNELS}
        self._raw_file    = None
        self._raw_writer  = None
        self._raw_path    = None

    def open_raw(self) -> str:
        ts = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
        self._raw_path = os.path.join(DATA_DIR, f"raw_eeg_{ts}.csv")
        self._raw_file = open(self._raw_path, "w", newline="", encoding="utf-8")
        self._raw_writer = csv.writer(self._raw_file)
        self._raw_writer.writerow(["timestamp", "channel", "sample_idx", "value_uv"])
        return self._raw_path

    def write_raw(self, channel: str, samples: list):
        if not self._raw_writer:
            return
        ts = datetime.now().strftime("%H:%M:%S.%f")[:-3]
        for idx, v in enumerate(samples):
            self._raw_writer.writerow([ts, channel, idx, v])

    def close_raw(self):
        if self._raw_file:
            self._raw_file.flush()
            self._raw_file.close()
        self._raw_file = self._raw_writer = None


def log_metrics(sig_q: int, drowsy: int, bands: dict):
    today = datetime.now().strftime("%Y-%m-%d")
    path  = os.path.join(DATA_DIR, f"metrics_{today}.csv")
    exists = os.path.exists(path)
    try:
        with open(path, "a", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            if not exists:
                w.writerow(["time", "signal", "drowsiness",
                             "delta", "theta", "alpha", "beta"])
            w.writerow([
                datetime.now().strftime("%H:%M:%S"),
                sig_q, drowsy,
                bands["delta"], bands["theta"], bands["alpha"], bands["beta"],
            ])
    except Exception:
        pass


def parse_eeg_packet(raw: bytes) -> list:
    """
    Muse S 12-bit EEG BLE 格式:
      前 2 字节 = 包序列号（大端 uint16）
      之后每 3 字节解出 2 个 12-bit 样本
    转换: (ADC - 2048) * 0.475 µV
    """
    samples = []
    if len(raw) < 5:
        return samples
    i = 2
    while i + 2 < len(raw):
        b1, b2, b3 = raw[i], raw[i+1], raw[i+2]
        v1 = ((b1 << 4) | (b2 >> 4)) & 0xFFF
        v2 = ((b2 & 0x0F) << 8 | b3) & 0xFFF
        samples.append(round((v1 - 2048) * 0.475, 3))
        samples.append(round((v2 - 2048) * 0.475, 3))
        i += 3
    return samples

# ── PPG 解包器 (Muse 24-bit 特征值结构) ──
def parse_ppg_packet(raw: bytes) -> list:
    samples = []
    if len(raw) < 20: return samples
    for i in range(2, 20, 3):
        samples.append((raw[i] << 16) | (raw[i+1] << 8) | raw[i+2])
    return samples


def band_power(fft_mag: np.ndarray, freqs: np.ndarray,
               f_lo: float, f_hi: float) -> float:
    idx = np.where((freqs >= f_lo) & (freqs <= f_hi))[0]
    return float(np.sum(fft_mag[idx] ** 2)) if len(idx) else 1e-6


def calculate_metrics(data: list) -> tuple:
    DEFAULT_BANDS = {"delta": 25, "theta": 25, "alpha": 25, "beta": 25, "gamma": 25}
    if len(data) < SAMPLE_RATE:
        return 0, 0, DEFAULT_BANDS

    arr = np.array(data[:SAMPLE_RATE], dtype=np.float32)

    # ── 信号质量 (红队逻辑：工频干扰劫持过滤) ──────────────────
    std = float(np.std(arr))
    p2p = float(np.ptp(arr))
    rms = float(np.sqrt(np.mean(arr ** 2)))
    
    win   = np.hanning(len(arr))
    fft   = np.abs(np.fft.rfft(arr * win))
    freqs = np.fft.rfftfreq(len(arr), 1.0 / SAMPLE_RATE)
    
    pli_idx = np.where(((freqs >= 48) & (freqs <= 52)) | ((freqs >= 58) & (freqs <= 62)))[0]
    pli_power = np.sum(fft[pli_idx] ** 2) if len(pli_idx) else 0
    total_power = np.sum(fft ** 2) + 1e-9

    if std < 0.5 or p2p < 1:
        sig_q = 0          # 物理脱落 / 平坦
    elif (pli_power / total_power) > 0.4:
        sig_q = 10         # 极高频干扰 (接触不良导致人体成为天线)
    elif p2p > 600 or std > 400:
        sig_q = 15         # 动作/眼动剧烈伪迹
    else:
        deviation = max(0, abs(rms - 30) - 20)
        sig_q = max(60, min(100, int(100 - deviation * 1.2)))

    # ── 频谱（Hanning 窗）────────────────────────────────────
    # win 已在信号质量评估中计算
    freqs = np.fft.rfftfreq(len(arr), 1.0 / SAMPLE_RATE)

    delta_p = band_power(fft, freqs, 0.5,  4.0)
    theta_p = band_power(fft, freqs, 4.0,  8.0)
    alpha_p = band_power(fft, freqs, 8.0, 13.0)
    beta_p  = band_power(fft, freqs, 13.0, 30.0)
    gamma_p = band_power(fft, freqs, 30.0, 50.0)

    total = max(delta_p + theta_p + alpha_p + beta_p + gamma_p, 1e-9)

    bands = {
        "delta": int(round(delta_p / total * 100)),
        "theta": int(round(theta_p / total * 100)),
        "alpha": int(round(alpha_p / total * 100)),
        "beta":  int(round(beta_p  / total * 100)),
        "gamma": int(round(gamma_p / total * 100)),
    }
    bands["alpha"] += 100 - sum(bands.values())   # 消除舍入误差

    # ── 困意指数 ──────────────────────────────────────────────
    # 神经科学标准：慢波 / 快波功率比
    # ratio 高 → 困倦；ratio 低 → 清醒
    slow  = theta_p + alpha_p * 0.5
    fast  = alpha_p * 0.5 + beta_p
    ratio = slow / max(fast, 1e-6)

    # 线性映射: ratio [0.25, 2.5] → drowsiness [0, 100]
    drowsiness = int(max(0, min(100, (ratio - 0.25) / 2.25 * 100)))

    return sig_q, drowsiness, bands


# ── HRV & SpO2 计算 ──
def calculate_ppg_metrics(ir_data: list, red_data: list) -> tuple:
    if len(ir_data) < 64 or len(red_data) < 64: return None, None
    arr_ir = np.array(ir_data[-256:], dtype=np.float32)
    arr_red = np.array(red_data[-256:], dtype=np.float32)

    # SpO2: Ratio of Ratios (AC/DC)
    ir_ac, ir_dc = np.std(arr_ir), np.mean(arr_ir)
    red_ac, red_dc = np.std(arr_red), np.mean(arr_red)
    spo2 = 0
    if ir_dc > 0 and red_dc > 0 and ir_ac > 0:
        r = (red_ac / red_dc) / (ir_ac / ir_dc)
        spo2 = int(max(80, min(100, 110 - 25 * r)))

    # HRV: RMSSD 基准
    peaks, _ = find_peaks(-arr_ir, distance=20) # 取光吸收波谷等效于收缩波峰
    hrv = 0
    if len(peaks) >= 2:
        rr_intervals = np.diff(peaks) * (1000.0 / 64.0) # PPG 采样率约 64Hz
        if len(rr_intervals) > 1:
            hrv = int(np.sqrt(np.mean(np.diff(rr_intervals)**2)))
            hrv = min(200, max(10, hrv)) # 临床封顶钳制

    return hrv, spo2

@app.websocket("/ws/eeg")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    ctrl_buf = ""
    session  = SessionState()
    bufs     = {ch: [] for ch in EEG_CHANNELS + PPG_CHANNELS}
    sys_hrv  = 0
    sys_spo2 = 0
    print("🟢 [后端] 客户端已连接")

    try:
        while True:
            try:
                raw_payload = await websocket.receive_text()
            except Exception:
                break

            try:
                packet = json.loads(raw_payload)
            except json.JSONDecodeError:
                continue

            ptype    = packet.get("type", "")
            channel  = packet.get("channel", "")
            data_b64 = packet.get("data", "")

            # ── 前端设置（开/关原始数据保存）───────────────────
            if ptype == "settings":
                session.save_raw = bool(packet.get("save_raw", False))
                if session.save_raw and not session._raw_file:
                    path = session.open_raw()
                    await websocket.send_json({
                        "type": "save_status", "saving": True, "path": path
                    })
                    print(f"📁 开始保存原始 EEG → {path}")
                elif not session.save_raw and session._raw_file:
                    session.close_raw()
                    await websocket.send_json({"type": "save_status", "saving": False})
                    print("📁 停止保存")
                continue

            # ── 解码 base64 ────────────────────────────────────
            try:
                raw_bytes = base64.b64decode(data_b64)
            except Exception:
                continue

            # ── 控制通道：电池电量解析 ──────────────────────────
            if channel == "0001":
                try:
                    chunk = raw_bytes.decode("utf-8", errors="ignore")
                    ctrl_buf += chunk
                    m = re.search(r'"bp":\s*(\d+)', ctrl_buf)
                    if m:
                        await websocket.send_json({
                            "type": "battery", "value": int(m.group(1))
                        })
                        ctrl_buf = ""
                    if len(ctrl_buf) > 1000:
                        ctrl_buf = ctrl_buf[-500:]
                except Exception:
                    pass
                continue

            if channel not in EEG_CHANNELS:
                continue

            # ── EEG 解包 ───────────────────────────────────────
            samples = parse_eeg_packet(raw_bytes)
            if not samples:
                continue

            session.packet_total += 1
            session.ch_counts[channel] = session.ch_counts.get(channel, 0) + 1

            # 保存原始波形
            if session.save_raw:
                session.write_raw(channel, samples)

            bufs[channel].extend(samples)

            # ── 主通道：满 256 点计算一次指标 ──────────────────
            if channel == EEG_PRIMARY and len(bufs[EEG_PRIMARY]) >= SAMPLE_RATE:
                window = bufs[EEG_PRIMARY][:SAMPLE_RATE]
                sig_q, drowsy, bands = calculate_metrics(window)
                log_metrics(sig_q, drowsy, bands)

                # 预定义多模态合约字段，保障未来 muse_ppg_heart_rate.py 等算法模块无缝挂载
                await websocket.send_json({
                    "type":       "metrics",
                    "signal":     sig_q,
                    "drowsiness": drowsy,
                    "bands":      bands,
                    "hrv":        sys_hrv if sys_hrv > 0 else '--',
                    "spo2":       sys_spo2 if sys_spo2 > 0 else '--',
                    "packets_rx": session.packet_total,
                })
                # 50% 重叠滑动窗口 → 约 0.5 秒更新一次
                bufs[EEG_PRIMARY] = bufs[EEG_PRIMARY][SAMPLE_RATE // 2:]

            # ── 波形预览（主通道降采样 2:1）────────────────────
            if channel == EEG_PRIMARY and len(samples) >= 2:
                mean_v = sum(samples) / len(samples)
                await websocket.send_json({
                    "type": "eeg_preview",
                    "data": [round(v - mean_v, 2) for v in samples[::2]],
                })

            # ── 数据流状态（每 30 包广播一次）─────────────────
            if session.packet_total % 30 == 1:
                await websocket.send_json({
                    "type":     "data_status",
                    "packets":  session.packet_total,
                    "channels": session.ch_counts,
                    "saving":   session.save_raw,
                })

    except WebSocketDisconnect:
        print("🔴 [后端] 客户端断开")
    finally:
        session.close_raw()


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8001)
