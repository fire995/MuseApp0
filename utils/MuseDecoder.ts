import { Buffer } from 'buffer';
// @ts-ignore
import FFT from 'fft.js';

// ── 常量 ─────────────────────────────────────────────────────────
const EEG_SCALE = 0.48828125;      // 12-bit → μV  (= 1000/2048)
const PPG_SAMPLE_RATE = 64;        // Muse S PPG 采样率 64Hz
export const EEG_SAMPLE_RATE = 256;       // EEG 采样率 256Hz

// Muse S EEG 通道名称，按 0xDF 包内顺序排列
export const EEG_CHANNEL_NAMES = ['TP9', 'AF7', 'AF8', 'TP10', 'FPz', 'AUX_R', 'AUX_L'] as const;
export type EEGChannelName = typeof EEG_CHANNEL_NAMES[number];

// ── 解码结果类型 ─────────────────────────────────────────────────
export interface DecodedPacket {
  /** 包类型字节 */
  packetType: number;
  /** 人类可读的包类型标识 */
  packetTypeName: string;
  /** EEG 通道 → μV 样本数组（12 个/包）。仅在 EEG 包中有值 */
  eeg: Partial<Record<EEGChannelName, number[]>>;
  /** PPG 原始采样值（红/红外混合）。仅在 PPG 包中有值 */
  ppg: number[];
  /** 是否包含有效 EEG 数据 */
  hasEEG: boolean;
  /** 是否包含有效 PPG 数据 */
  hasPPG: boolean;
}

// ── PPG 心率计算器（滑动窗口峰值检测）────────────────────────────
export class HeartRateCalculator {
  private buffer: number[] = [];
  private readonly windowSize = PPG_SAMPLE_RATE * 8; // 8 秒窗口
  private readonly minPeakDistance = Math.round(PPG_SAMPLE_RATE * 0.4); // 0.4s = 最高 150bpm

  /** 推入 PPG 样本，如果能计算心率则返回 BPM，否则返回 null */
  push(samples: number[]): number | null {
    this.buffer.push(...samples);
    if (this.buffer.length > this.windowSize) {
      this.buffer.splice(0, this.buffer.length - this.windowSize);
    }
    // 至少需要 3 秒数据才开始计算
    if (this.buffer.length < PPG_SAMPLE_RATE * 3) return null;
    return this._calcHR();
  }

  reset() { this.buffer = []; }

  private _calcHR(): number | null {
    const sig = this.buffer;
    // 去均值
    const mean = sig.reduce((a, b) => a + b, 0) / sig.length;
    const centered = sig.map(v => v - mean);
    // 计算标准差
    const rms = Math.sqrt(centered.reduce((a, b) => a + b * b, 0) / centered.length);
    if (rms < 10) return null; // 信号太弱

    // 简单峰值检测（局部最大值，且要超过 0.25×RMS 的prominence）
    const threshold = rms * 0.25;
    const peaks: number[] = [];
    for (let i = this.minPeakDistance; i < centered.length - this.minPeakDistance; i++) {
      if (centered[i] <= threshold) continue;
      // 检查是否局部最大
      let isMax = true;
      for (let j = i - this.minPeakDistance; j <= i + this.minPeakDistance; j++) {
        if (j !== i && centered[j] >= centered[i]) { isMax = false; break; }
      }
      if (isMax) {
        peaks.push(i);
        i += this.minPeakDistance - 1; // 跳过最小间距
      }
    }

    if (peaks.length < 2) return null;

    // 平均 R-R 间期 → BPM
    let sumInterval = 0;
    for (let i = 1; i < peaks.length; i++) {
      sumInterval += peaks[i] - peaks[i - 1];
    }
    const avgInterval = sumInterval / (peaks.length - 1);
    const bpm = (PPG_SAMPLE_RATE * 60) / avgInterval;

    // 生理范围检查
    if (bpm < 35 || bpm > 200) return null;
    return Math.round(bpm);
  }
}

// ── 主解析函数：识别包类型并分发解码 ────────────────────────────

/**
 * 解析来自 Muse S BLE characteristic 的一个数据包
 *
 * 包类型（第 0 字节）：
 *   0xDF : EEG + PPG 混合包（p1035 高速模式主要包型）
 *   0xF4 : IMU 包（加速度计+陀螺仪）
 *   0xDB : 混合/控制包
 *   0xD9 : 混合包
 *   其他 : 传统单通道 20 字节 EEG 包（ch=0013~0016 每个独立）
 *
 * @param base64Data  BLE notify 回调中的 base64 字符串
 * @param channelId   订阅的 UUID 短 ID，如 '0013'
 */
export function parseMusePacket(base64Data: string, channelId: string): DecodedPacket {
  const buf = Buffer.from(base64Data, 'base64');
  const result: DecodedPacket = {
    packetType: buf.length > 0 ? buf[0] : 0xFF,
    packetTypeName: 'UNKNOWN',
    eeg: {},
    ppg: [],
    hasEEG: false,
    hasPPG: false,
  };

  if (buf.length === 0) return result;

  const typeByte = buf[0];

  // 关键修复：当 packet length <= 20 时，通常是因为手机 MTU 没调整好被截断，或者是头环发送的 Legacy 数据（旧模式）。
  // 如果大包 (length > 20)，无论是 0xDF、0xDB 还是其他变体（如 0xE5, 0xEC），都应当作混合包解析。
  if (buf.length > 20) {
    if (typeByte === 0xF4) {
      // ── 0xF4: IMU 包（本次暂不解码，留作后续）───────────────────
      result.packetTypeName = 'IMU';
      return result;
    }

    result.packetTypeName = typeByte === 0xDF ? 'EEG_PPG_DF' : `MIXED_${typeByte.toString(16).toUpperCase()}`;
    _decode_DF(buf, result);

    if (!result.hasEEG && !result.hasPPG && typeByte !== 0xDF) {
      _decode_generic(buf.slice(4), result);
    }
    return result;
  }

  // ── 传统独立通道包（ch=0013~0016，按 20 字节标准格式）─────
  result.packetTypeName = `LEGACY_CH${channelId}`;
  _decode_legacy(buf, channelId, result);

  return result;
}

/** 解码 0xDF 混合包：EEG 段 × N + PPG 段 × 1 */
function _decode_DF(buf: Buffer, result: DecodedPacket) {
  // 包头结构：[type:1][seq:2][flags:1] = 4 字节，之后交替出现 EEG/PPG 段
  let offset = 4;
  let channelIdx = 0;

  while (offset < buf.length && channelIdx < EEG_CHANNEL_NAMES.length) {
    const remaining = buf.length - offset;

    // 尝试解析 EEG 段（18 字节，12 个 12-bit 样本）
    if (remaining >= 18 && _looksLikeEEG(buf, offset)) {
      const samples = _unpackEEG18(buf, offset);
      const chName = EEG_CHANNEL_NAMES[channelIdx];
      result.eeg[chName] = samples;
      result.hasEEG = true;
      channelIdx++;
      offset += 18;
      continue;
    }

    // 尝试解析 PPG 段（20 字节）
    if (remaining >= 20 && !result.hasPPG) {
      const ppgSamples = _unpackPPG20(buf, offset);
      if (ppgSamples.length > 0) {
        result.ppg = ppgSamples;
        result.hasPPG = true;
        offset += 20;
        continue;
      }
    }

    // 无法识别，前进 1 字节
    offset++;
  }

  // 如果 EEG 解析一个也没成功，回退到传统解析（兼容老固件）
  if (!result.hasEEG && channelIdx === 0) {
    _decode_legacy(buf, '0013', result);
  }
}

/** 通用解析：扫描 EEG 段 */
function _decode_generic(buf: Buffer, result: DecodedPacket) {
  let offset = 0;
  let chIdx = 0;
  while (offset < buf.length - 17 && chIdx < EEG_CHANNEL_NAMES.length) {
    if (buf.length - offset >= 18 && _looksLikeEEG(buf, offset)) {
      const samples = _unpackEEG18(buf, offset);
      result.eeg[EEG_CHANNEL_NAMES[chIdx]] = samples;
      result.hasEEG = true;
      chIdx++;
      offset += 18;
    } else {
      offset++;
    }
  }
}

/**
 * 传统独立通道解码（旧固件 / p21 低功耗模式）
 */
function _decode_legacy(buf: Buffer, channelId: string, result: DecodedPacket) {
  if (buf.length < 4) return;

  // 区分 Legacy EEG 还是 Legacy PPG
  if (channelId === '0010' || channelId === '0011') {
    // 传统 PPG 格式：[seq:2] + [18 byte 数据 (6个24-bit/20-bit样本)]
    // 因为 _unpackPPG20 内部刚好就是跳过了 offset 后的头2字节，所以可以直接复用
    const ppgSamples = _unpackPPG20(buf, 0);
    if (ppgSamples.length > 0) {
      result.ppg = ppgSamples;
      result.hasPPG = true;
    }
    return;
  }

  // 传统 EEG 格式：跳过 2 字节序号，读 18 字节数据
  const offset = 2;
  if (buf.length - offset < 18) {
    // 短包：直接从 offset 2 拆，按 3 字节一组
    const samples: number[] = [];
    for (let i = offset; i + 2 < buf.length; i += 3) {
      const s1 = ((buf[i] << 4) | (buf[i + 1] >> 4)) & 0xFFF;
      const s2 = (((buf[i + 1] & 0x0F) << 8) | buf[i + 2]) & 0xFFF;
      samples.push(
        (s1 > 2047 ? s1 - 4096 : s1) * EEG_SCALE,
        (s2 > 2047 ? s2 - 4096 : s2) * EEG_SCALE,
      );
    }
    if (samples.length > 0) {
      const chName = _channelIdToName(channelId);
      result.eeg[chName] = samples;
      result.hasEEG = true;
    }
    return;
  }

  const samples = _unpackEEG18(buf, offset);
  if (samples.length > 0) {
    const chName = _channelIdToName(channelId);
    result.eeg[chName] = samples;
    result.hasEEG = true;
  }
}

/** 从 buf[offset] 开始解包 18 字节 EEG 段，返回 12 个 μV 样本 */
function _unpackEEG18(buf: Buffer, offset: number): number[] {
  const samples: number[] = [];
  for (let i = 0; i < 6; i++) {
    const b0 = buf[offset + i * 3];
    const b1 = buf[offset + i * 3 + 1];
    const b2 = buf[offset + i * 3 + 2];
    const s1 = ((b0 << 4) | (b1 >> 4)) & 0xFFF;
    const s2 = (((b1 & 0x0F) << 8) | b2) & 0xFFF;
    samples.push(
      (s1 > 2047 ? s1 - 4096 : s1) * EEG_SCALE,
      (s2 > 2047 ? s2 - 4096 : s2) * EEG_SCALE,
    );
  }
  return samples;
}

/**
 * 从 buf[offset] 开始解包 20 字节 PPG 段
 * PPG 数据：每 3 字节包含若干高精度采样
 * 返回原始 ADC 计数值数组（非 μV，PPG 是光强信号）
 */
function _unpackPPG20(buf: Buffer, offset: number): number[] {
  const samples: number[] = [];
  // PPG 段头 2 字节为序号，之后每 3 字节 = 1 个 20-bit 样本（取高 16 bit）
  for (let i = offset + 2; i + 2 < offset + 20 && i + 2 < buf.length; i += 3) {
    const val = (buf[i] << 16) | (buf[i + 1] << 8) | buf[i + 2];
    // PPG 正常范围大约在 10000~1000000，滤掉明显异常值
    if (val > 1000 && val < 16000000) {
      samples.push(val);
    }
  }
  return samples;
}

/**
 * 启发式判断 buf[offset..offset+18) 是否像 EEG 数据段
 * 核心判据：Muse EEG ADC 输出在 12-bit 满幅 (0-4095) 中心附近（约 1500-2500）
 */
/**
 * 启发式判断 buf[offset..offset+18) 是否像 EEG 数据段
 * 核心优化：大大放宽阈值。Muse 的基线(Baseline)漂移很大，特别是接触一般时，
 * 之前的 800-3200 限制太严死，会导致数据被静默丢弃，从而显示 20% 质量。
 */
function _looksLikeEEG(buf: Buffer, offset: number): boolean {
  if (offset + 18 > buf.length) return false;
  // 核心变更：只要不是全0或全是FFFF（即接近轨至轨饱和），就认为是有效数据尝试解析
  const s1 = ((buf[offset] << 4) | (buf[offset + 1] >> 4)) & 0xFFF;
  const s2 = (((buf[offset + 1] & 0x0F) << 8) | buf[offset + 2]) & 0xFFF;
  return s1 > 1 && s1 < 4094 && s2 > 1 && s2 < 4094;
}

/** UUID 短 ID 转 EEG 通道名 */
function _channelIdToName(id: string): EEGChannelName {
  const map: Record<string, EEGChannelName> = {
    '0013': 'TP9',
    '0014': 'AF7',
    '0015': 'AF8',
    '0016': 'TP10',
  };
  return map[id] ?? 'TP9';
}

// ── 向后兼容：保留旧的 decodeEEG 接口供外部直接调用时降级使用 ──
/** @deprecated 请改用 parseMusePacket */
export function decodeEEG(base64Data: string): number[] {
  const buf = Buffer.from(base64Data, 'base64');
  const samples: number[] = [];
  for (let i = 2; i < buf.length - 2; i += 3) {
    const s1 = ((buf[i] << 4) | (buf[i + 1] >> 4)) & 0xFFF;
    const s2 = (((buf[i + 1] & 0x0F) << 8) | buf[i + 2]) & 0xFFF;
    samples.push(
      (s1 > 2047 ? s1 - 4096 : s1) * EEG_SCALE,
      (s2 > 2047 ? s2 - 4096 : s2) * EEG_SCALE,
    );
  }
  return samples;
}

// ── 频域分析（保持不变，供信号质量评分使用）─────────────────────
export function analyzeFrequency(samples: number[]): { theta: number; alpha: number } {
  if (samples.length < 16) return { theta: 0, alpha: 0 };
  try {
    const fftSize = Math.pow(2, Math.floor(Math.log2(samples.length)));
    const fft = new FFT(fftSize);
    const mean = samples.slice(0, fftSize).reduce((a, b) => a + b, 0) / fftSize;
    const normalized = samples.slice(0, fftSize).map(v => v - mean);
    const out = fft.createComplexArray();
    fft.realTransform(out, normalized);
    const power: number[] = [];
    for (let i = 0; i < out.length / 2; i += 2) {
      power.push(Math.sqrt(out[i] * out[i] + out[i + 1] * out[i + 1]));
    }
    const freqRes = EEG_SAMPLE_RATE / fftSize;
    const thetaEnergy = power.slice(Math.floor(4 / freqRes), Math.ceil(8 / freqRes)).reduce((a, b) => a + b, 0);
    const alphaEnergy = power.slice(Math.floor(8 / freqRes), Math.ceil(13 / freqRes)).reduce((a, b) => a + b, 0);
    return { theta: thetaEnergy, alpha: alphaEnergy };
  } catch { return { theta: 0, alpha: 0 }; }
}

/**
 * 多维度信号质量评估算法
 *
 * 参考开源项目实现：
 *  - muse-lsl: 通过方差/标准差判断信号合理性
 *  - BrainFlow SDK: std + 饱和 + 平坦 + 幅度综合检测
 *  - Mind Monitor (HSI): 电极接触质量 1(好)/2(中)/4(差)
 *  - 学术论文 (NIH): variance per second 法
 *
 * 5 个检测维度及权重：
 *  1. 标准差检测 (40%) — 标准差在 3~80μV 范围为正常脑波
 *  2. 幅度范围检测 (20%) — 峰峰值在 5~200μV 范围为正常
 *  3. 饱和检测 (15%) — ADC 接近满量程说明电极不良
 *  4. 平坦检测 (15%) — 连续相同值说明电极脱落
 *  5. 频谱合理性 (10%) — 脑波频段 1-40Hz 能量占比
 */
export function calculateSignalQuality(samples: number[]): number {
  if (!samples || samples.length < 32) return 0;

  try {
    const data = samples.slice(-256);
    const N = data.length;

    // ── 1. 标准差检测 (权重 50%) ──────────────────────────────
    // 正常 EEG 信号标准差在 2~60μV 为极佳，60~120μV 为一般，>150μV 判定为伪迹/噪声
    const mean = data.reduce((a, b) => a + b, 0) / N;
    let sumSq = 0;
    for (const v of data) { const d = v - mean; sumSq += d * d; }
    const std = Math.sqrt(sumSq / N);

    let stdScore: number;
    if (std < 0.3) stdScore = 0;         // 几乎为 0 -> 假数据/死线
    else if (std < 1.5) stdScore = 30;   // 信号过弱 -> 接触不良/屏蔽
    else if (std <= 60) stdScore = 100;  // 极佳范围 (2~60μV)
    else if (std <= 120) stdScore = 70;  // 较多噪声但有信号
    else if (std <= 200) stdScore = 30;  // 重度噪声
    else stdScore = 0;                   // 电极悬空 (picks up 50/60Hz noise > 200μV)

    // ── 2. 幅度峰峰值检测 (权重 20%) ────────────────────────────
    let vmin = data[0], vmax = data[0];
    for (const v of data) { if (v < vmin) vmin = v; if (v > vmax) vmax = v; }
    const p2p = vmax - vmin;

    let ampScore: number;
    if (p2p < 1) ampScore = 0;
    else if (p2p <= 300) ampScore = 100;
    else if (p2p <= 600) ampScore = 50;
    else ampScore = 20;

    // ── 3. 饱和/死线检测 (权重 20%) ──────────────────────────────
    // 超过 ±800μV 或 连续采样不变
    let badCount = 0;
    for (let i = 1; i < N; i++) {
      const absVal = Math.abs(data[i]);
      const diff = Math.abs(data[i] - data[i - 1]);
      if (absVal > 800 || diff < 0.001) badCount++;
    }
    const badRatio = badCount / N;
    let satScore = Math.max(0, 100 - badRatio * 200);

    // ── 4. 频谱合理性 (权重 10%) ───────────────────────────────
    let spectralScore = 50;
    const fftSize = Math.min(256, Math.pow(2, Math.floor(Math.log2(N))));
    if (fftSize >= 64) {
      try {
        const fft = new FFT(fftSize);
        const segment = data.slice(-fftSize);
        const segMean = segment.reduce((a, b) => a + b, 0) / fftSize;
        const normalized = segment.map(v => v - segMean);
        const out = fft.createComplexArray();
        fft.realTransform(out, normalized);

        const freqRes = EEG_SAMPLE_RATE / fftSize;
        let brainPower = 0, mainsPower = 0, totalPower = 0;

        for (let bin = 1; bin < out.length / 4; bin++) {
          const freq = bin * freqRes;
          const p = out[bin * 2] ** 2 + out[bin * 2 + 1] ** 2;
          totalPower += p;
          if (freq >= 2 && freq <= 40) brainPower += p;
          if (freq >= 45 && freq <= 65) mainsPower += p; // 50/60Hz 工频噪声
        }

        if (totalPower > 0) {
          const ratio = brainPower / totalPower;
          const mainsRatio = mainsPower / totalPower;
          if (mainsRatio > 0.4) spectralScore = 20; // 受到严重工频干扰
          else spectralScore = ratio > 0.4 ? 100 : ratio * 250;
        }
      } catch { }
    }

    const finalScore = (stdScore * 0.5) + (ampScore * 0.2) + (satScore * 0.2) + (spectralScore * 0.1);
    return Math.round(Math.max(0, Math.min(100, finalScore)));
  } catch { return 0; }
}