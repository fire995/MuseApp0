"""
MuseApp0 后端 v3.1 — FastAPI
=============================
修复：
  - theta_wave 无数据：process() 每次返回当前 TP9 最新波形点（不再累积deque）
  - 自适应采样：后端只记录当前模式（dense/sparse），
    实际降频由前端发 BLE preset 命令给头环实现

启动：  python backend_server.py
热重载：uvicorn backend_server:app --host 0.0.0.0 --port 8001 --reload
健康：  http://IP:8001/
"""

import asyncio
import json
import base64
import csv
import os
import re
import time
import logging
from collections import deque
from datetime import datetime
from statistics import median

import numpy as np
from scipy.signal import butter, filtfilt, welch
import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

logging.basicConfig(level=logging.INFO, format='%(asctime)s  %(levelname)-8s  %(message)s')
log = logging.getLogger(__name__)

app = FastAPI(title='MuseApp Backend', version='3.1')
app.add_middleware(CORSMiddleware, allow_origins=['*'], allow_methods=['*'], allow_headers=['*'])

EEG_FS       = 256
PPG_FS       = 64
EEG_CHANNELS = ['TP9', 'AF7', 'AF8', 'TP10']

CHANNEL_MAP = {
    '0013': 'TP9',   '0014': 'AF7',    '0015': 'AF8',    '0016': 'TP10',
    '0017': 'AUX',   '0010': 'PPG_IR', '0011': 'PPG_RED','0001': 'CONTROL',
}

# ══════════════════════════════════════════════════════
#  BLE 包解析
# ══════════════════════════════════════════════════════

def parse_eeg(data: bytes) -> list[float]:
    """Muse S 12-bit EEG → µV"""
    if len(data) < 4:
        return []
    out, payload = [], data[2:]
    i = 0
    while i + 2 < len(payload):
        b0, b1, b2 = payload[i], payload[i+1], payload[i+2]
        for raw in ((b0 << 4) | (b1 >> 4), ((b1 & 0x0F) << 8) | b2):
            if raw >= 2048: raw -= 4096
            out.append(raw * 0.09140625)
        i += 3
    return out


def parse_ppg(data: bytes) -> list[float]:
    """Muse S PPG uint24 big-endian"""
    if len(data) < 4:
        return []
    payload = data[2:]
    return [float((payload[i] << 16) | (payload[i+1] << 8) | payload[i+2])
            for i in range(0, len(payload) - 2, 3)]


def parse_battery(data: bytes) -> int | None:
    try:
        m = re.search(r'"bp"\s*:\s*(\d+)', data.decode('utf-8', errors='ignore'))
        return int(m.group(1)) if m else None
    except Exception:
        return None


# ══════════════════════════════════════════════════════
#  EEG 处理器
# ══════════════════════════════════════════════════════

class EEGProcessor:
    def __init__(self, fs: int = EEG_FS):
        self.fs      = fs
        self.buf     = {ch: deque(maxlen=fs * 5) for ch in EEG_CHANNELS}
        self._q_hist = deque(maxlen=10)   # 质量平滑窗口

    def add(self, ch: str, samples: list[float]):
        if ch in self.buf:
            self.buf[ch].extend(samples)

    # ── 滤波器 ────────────────────────────────────────

    def _hp(self, d: np.ndarray) -> np.ndarray:
        b, a = butter(4, 0.5 / (self.fs / 2), btype='high')
        return filtfilt(b, a, d)

    def _notch(self, d: np.ndarray) -> np.ndarray:
        nyq = self.fs / 2
        b, a = butter(2, [49 / nyq, 51 / nyq], btype='bandstop')
        return filtfilt(b, a, d)

    def _theta_bp(self, d: np.ndarray) -> np.ndarray:
        nyq = self.fs / 2
        b, a = butter(4, [4 / nyq, 8 / nyq], btype='band')
        return filtfilt(b, a, d)

    def _raw_quality(self, d: np.ndarray) -> int:
        """更宽容的质量评估：只看最近 1 秒，用超阈值样本比例判断"""
        recent = d[-self.fs:] if len(d) > self.fs else d
        if len(recent) < 64:
            return 50  # 数据太少
        
        # 超过 200µV 的样本比例
        outlier_ratio = np.sum(np.abs(recent) >= 200.0) / len(recent)
        if outlier_ratio > 0.3:  # 30% 以上样本异常才判定为运动伪迹
            return 0
        
        # 方差太小 = 接触不良
        if np.var(recent) < 5.0:
            return 50
        
        # 根据异常样本比例给出质量分数
        return int(100 - outlier_ratio * 200)

    # ── 主处理 ────────────────────────────────────────

    def process(self) -> dict | None:
        """
        每次调用都从当前缓冲区实时计算，返回新鲜数据。
        theta_pts: 取 TP9 最新 1 秒的 Theta 带通时域数据（下采样到 20 点）。
                   每次调用都是最新的，不会重复推送旧数据。
        """
        valid_q:    list[int]   = []
        theta_vals: list[float] = []
        alpha_vals: list[float] = []
        beta_vals:  list[float] = []
        theta_pts:  list[float] = []
        electrode_quality: dict[str, int] = {}  # 各电极独立质量

        for ch in EEG_CHANNELS:
            b = self.buf[ch]
            # 至少需要 2 秒数据才能滤波
            if len(b) < self.fs * 2:
                electrode_quality[ch] = 0  # 无数据
                continue

            d = self._hp(np.array(b))
            d = self._notch(d)
            
            # ── Theta 时域波形（TP9 通道，最新 1 秒）────────────
            # 修复关键：移到 quality check 之前，让波形独立于质量评分
            # 只要 TP9 有数据就计算并推送，不受信号质量影响
            if ch == 'TP9' and len(b) >= 64:
                window = np.array(b)[-self.fs:]   # 最新 1 秒
                if len(window) >= 64:             # 至少 0.25 秒才够滤波
                    theta_td = self._theta_bp(window)
                    # 下采样到 20 点（显示用）
                    indices = np.linspace(0, len(theta_td) - 1, 20, dtype=int)
                    theta_pts = [round(float(theta_td[i]), 3) for i in indices]
            
            # 质量评估
            q = self._raw_quality(d)
            electrode_quality[ch] = q  # 记录该电极质量
            
            if q == 0:
                continue

            valid_q.append(q)

            freqs, psd = welch(d, fs=self.fs, nperseg=min(len(d), self.fs * 2))

            def bp_power(lo: float, hi: float) -> float:
                idx = (freqs >= lo) & (freqs <= hi)
                return float(np.trapezoid(psd[idx], freqs[idx])) if np.any(idx) else 0.0

            theta_vals.append(bp_power(4,  8))
            alpha_vals.append(bp_power(8,  13))
            beta_vals .append(bp_power(13, 30))

        # 即使所有通道质量都为 0，只要有 theta_pts 也返回数据
        if not valid_q and not theta_pts:
            return None

        # 中位数平滑信号质量
        raw_q = int(median(valid_q))
        self._q_hist.append(raw_q)
        smooth_q = int(median(self._q_hist))

        # 困意指数
        t  = float(np.mean(theta_vals)) if theta_vals else 0.0
        a  = float(np.mean(alpha_vals)) if alpha_vals else 0.0
        b_ = float(np.mean(beta_vals))  if beta_vals  else 0.0
        drowsiness = int(np.clip(t / (a + b_ + 1e-9) * 100, 0, 100))

        return {
            'signal':            smooth_q,
            'drowsiness':        drowsiness,
            'theta_pts':         theta_pts,   # 每次都是最新 20 个点
            'electrode_quality': electrode_quality,  # 各电极质量
        }


# ══════════════════════════════════════════════════════
#  自适应保存器
#
#  注意：降低采样频率（省电）的工作由 App.tsx 发 BLE preset
#  命令给头环完成（p1035 → p21），后端只是跟踪当前模式
#  并在 sparse 阶段降低写入频率（避免文件太大）。
#
#  CSV 字段：timestamp, mode, channel, sample_idx, value
#    dense  = 高密度阶段，每帧全量写入
#    sparse = 低功耗阶段，每秒写 1 次均值
# ══════════════════════════════════════════════════════

class AdaptiveSaver:
    def __init__(self):
        self.file         = None
        self.writer       = None
        self.path         = ''
        self.is_saving    = False
        self._start_t     = 0.0
        self._dense_secs  = 30 * 60
        self._last_sparse: dict[str, float] = {}

    @property
    def mode(self) -> str:
        if not self.is_saving:
            return 'off'
        return 'dense' if time.time() - self._start_t < self._dense_secs else 'sparse'

    def start(self, dense_minutes: int = 30) -> str:
        os.makedirs('sleep_logs', exist_ok=True)
        fname = datetime.now().strftime('sleep_logs/muse_%Y%m%d_%H%M%S.csv')
        self.file         = open(fname, 'w', newline='', encoding='utf-8')
        self.writer       = csv.writer(self.file)
        self.writer.writerow(['timestamp', 'mode', 'channel', 'sample_idx', 'value'])
        self.path         = fname
        self.is_saving    = True
        self._start_t     = time.time()
        self._dense_secs  = dense_minutes * 60
        self._last_sparse = {}
        log.info(f'Saving → {fname}  dense={dense_minutes}min')
        return fname

    def write(self, channel: str, samples: list[float]):
        if not self.is_saving or not self.writer or not samples:
            return
        now = time.time()
        m   = self.mode

        if m == 'dense':
            for i, v in enumerate(samples):
                self.writer.writerow([round(now, 3), 'dense', channel, i, round(v, 4)])
        else:
            # sparse：每个通道每秒写 1 次均值
            last = self._last_sparse.get(channel, 0.0)
            if now - last >= 1.0:
                avg = round(float(np.mean(samples)), 4)
                self.writer.writerow([round(now, 3), 'sparse', channel, 0, avg])
                self._last_sparse[channel] = now

    def stop(self):
        self.is_saving = False
        if self.file:
            self.file.flush()
            self.file.close()
            self.file = self.writer = None
        log.info('Saving stopped')


# ══════════════════════════════════════════════════════
#  FastAPI 路由
# ══════════════════════════════════════════════════════

@app.get('/')
async def health():
    return {'status': 'ok', 'service': 'MuseApp Backend', 'version': '3.1'}


@app.websocket('/ws/eeg')
async def ws_eeg(websocket: WebSocket):
    await websocket.accept()
    log.info(f'Connected: {websocket.client}')

    eeg        = EEGProcessor()
    saver      = AdaptiveSaver()
    packets_rx = 0

    async def send(msg: dict):
        try:
            await websocket.send_text(json.dumps(msg))
        except Exception:
            pass

    async def push_loop():
        """每 500ms 推送 metrics + theta_wave"""
        while True:
            await asyncio.sleep(0.5)
            try:
                r = eeg.process()

                # 始终推送 metrics（即使没有 EEG 数据也推 signal=0）
                await send({
                    'type':              'metrics',
                    'signal':            r['signal']     if r else 0,
                    'drowsiness':        r['drowsiness'] if r else 0,
                    'packets_rx':        packets_rx,
                    'save_mode':         saver.mode,
                    'electrode_quality': r['electrode_quality'] if r else {'TP9': 0, 'AF7': 0, 'AF8': 0, 'TP10': 0},
                })

                # 只有有新 theta 点时才推（避免推空数组）
                if r and r['theta_pts']:
                    await send({
                        'type': 'theta_wave',
                        'data': r['theta_pts'],   # 每次都是最新 20 个点
                    })

            except Exception as e:
                log.error(f'push_loop error: {e}')

    task = asyncio.create_task(push_loop())

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
            except Exception:
                continue

            # ── 保存控制 ──────────────────────────────────────────
            if msg.get('type') == 'settings':
                want  = msg.get('save_raw')
                dmins = int(msg.get('dense_minutes', 30))
                if want and not saver.is_saving:
                    path = saver.start(dmins)
                    await send({'type': 'save_status', 'saving': True, 'path': path})
                elif want is False and saver.is_saving:
                    saver.stop()
                    await send({'type': 'save_status', 'saving': False, 'path': ''})
                continue

            # ── 采样模式通知（App.tsx 切换 preset 后告知后端）──────
            # App.tsx 发：{ type: 'sampling_mode', mode: 'dense'|'sparse' }
            # 后端仅记录日志，不做额外处理（saver.mode 由时间自动判断）
            if msg.get('type') == 'sampling_mode':
                log.info(f"Sampling mode: {msg.get('mode')}")
                continue

            # ── BLE 数据包 ────────────────────────────────────────
            channel  = msg.get('channel', '')
            data_b64 = msg.get('data', '')
            if not channel or not data_b64:
                continue
            try:
                raw_bytes = base64.b64decode(data_b64)
            except Exception:
                continue

            packets_rx += 1
            ch = CHANNEL_MAP.get(channel)

            if ch == 'CONTROL':
                batt = parse_battery(raw_bytes)
                if batt is not None:
                    await send({'type': 'battery', 'value': batt})

            elif ch in EEG_CHANNELS:
                samples = parse_eeg(raw_bytes)
                if samples:
                    eeg.add(ch, samples)
                    saver.write(ch, samples)

            elif ch == 'PPG_IR':
                samples = parse_ppg(raw_bytes)
                if samples:
                    saver.write('PPG_IR', samples)

            elif ch == 'PPG_RED':
                samples = parse_ppg(raw_bytes)
                if samples:
                    saver.write('PPG_RED', samples)

    except WebSocketDisconnect:
        pass
    except Exception as e:
        log.warning(f'ws error: {e}')
    finally:
        task.cancel()
        saver.stop()
        log.info(f'Disconnected: {websocket.client}')


if __name__ == '__main__':
    uvicorn.run('backend_server:app', host='0.0.0.0', port=8001, log_level='info')
