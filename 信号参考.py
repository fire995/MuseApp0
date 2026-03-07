         for i in range(0, len(payload) - 2, 3)]


def parse_battery(data: bytes) -> int | None:
def parse_status(data: bytes) -> dict:
    """解析 Muse 状态包，包含电池(bp)和硬件阻抗(hn)"""
    try:
        m = re.search(r'"bp"\s*:\s*(\d+)', data.decode('utf-8', errors='ignore'))
        return int(m.group(1)) if m else None
        text = data.decode('utf-8', errors='ignore')
        res = {}
        # 电池
        m_bp = re.search(r'"bp"\s*:\s*(\d+)', text)
        if m_bp: res['battery'] = int(m_bp.group(1))
        # 硬件阻抗 (Horseshoe): "hn":[1,1,2,4]
        m_hn = re.search(r'"hn"\s*:\s*\[(\d+),(\d+),(\d+),(\d+)\]', text)
        if m_hn:
            # 1=好, 2=一般, 4=差。转换为 0-100 分数：1->100, 2->50, 4->0
            raw_hn = [int(x) for x in m_hn.groups()]
            res['horseshoe'] = raw_hn
            res['hn_scores'] = {
                'TP9':  100 if raw_hn[0]==1 else (50 if raw_hn[0]==2 else 0),
                'AF7':  100 if raw_hn[1]==1 else (50 if raw_hn[1]==2 else 0),
                'AF8':  100 if raw_hn[2]==1 else (50 if raw_hn[2]==2 else 0),
                'TP10': 100 if raw_hn[3]==1 else (50 if raw_hn[3]==2 else 0),
            }
        return res
    except Exception:
        return None
        return {}


# ══════════════════════════════════════════════════════
@@ -89,6 +106,10 @@ def __init__(self, fs: int = EEG_FS):
        self.fs      = fs
        self.buf     = {ch: deque(maxlen=fs * 5) for ch in EEG_CHANNELS}
        self._q_hist = deque(maxlen=10)   # 质量平滑窗口
        self.hn_scores = {ch: 50 for ch in EEG_CHANNELS} # 默认中等阻抗

    def set_horseshoe(self, scores: dict[str, int]):
        self.hn_scores.update(scores)

    def add(self, ch: str, samples: list[float]):
        if ch in self.buf:
@@ -164,14 +185,20 @@ def process(self) -> dict | None:
                    indices = np.linspace(0, len(theta_td) - 1, 20, dtype=int)
                    theta_pts = [round(float(theta_td[i]), 3) for i in indices]

            # 质量评估
            q = self._raw_quality(d)
            electrode_quality[ch] = q  # 记录该电极质量
            # 质量评估：融合硬件阻抗(hn)与软件计算(raw_q)
            # 权重：硬件 40%，软件 60%
            raw_q = self._raw_quality(d)
            hn_q  = self.hn_scores.get(ch, 50)
            
            # 如果硬件报告完全脱落(0)，则强制为 0
            combined_q = int(hn_q * 0.4 + raw_q * 0.6) if hn_q > 0 else 0

            if q == 0:
            electrode_quality[ch] = combined_q  # 记录该电极融合质量
            
            if combined_q == 0:
                continue

            valid_q.append(q)
            valid_q.append(combined_q)

            freqs, psd = welch(d, fs=self.fs, nperseg=min(len(d), self.fs * 2))

@@ -227,6 +254,7 @@ def __init__(self):
        self._start_t     = 0.0
        self._dense_secs  = 30 * 60
        self._last_sparse: dict[str, float] = {}
        self._last_flush  = 0.0

    @property
    def mode(self) -> str:
@@ -265,6 +293,20 @@ def write(self, channel: str, samples: list[float]):
                self.writer.writerow([round(now, 3), 'sparse', channel, 0, avg])
                self._last_sparse[channel] = now

        # 每 3 分钟强制刷盘一次，防止异常退出导致数据丢失
        if now - self._last_flush > 180.0:
            self.flush()

    def flush(self):
        if self.file:
            try:
                self.file.flush()
                os.fsync(self.file.fileno())
                self._last_flush = time.time()
                log.info(f"Data auto-saved (flushed) to {self.path}")
            except Exception as e:
                log.error(f"Flush error: {e}")

    def stop(self):
        self.is_saving = False
        if self.file:
@@ -368,9 +410,12 @@ async def push_loop():
            ch = CHANNEL_MAP.get(channel)

            if ch == 'CONTROL':
                batt = parse_battery(raw_bytes)
                if batt is not None:
                    await send({'type': 'battery', 'value': batt})
                status = parse_status(raw_bytes)
                if 'battery' in status:
                    await send({'type': 'battery', 'value': status['battery']})
                if 'hn_scores' in status:
                    eeg.set_horseshoe(status['hn_scores'])
                    await send({'type': 'horseshoe', 'value': status['horseshoe']})

            elif ch in EEG_CHANNELS:
                samples = parse_eeg(raw_bytes)