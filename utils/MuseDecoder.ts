import { Buffer } from 'buffer';
// @ts-ignore
import FFT from 'fft.js';

/**
 * 解码 Muse EEG 数据包
 * Muse 使用 12-bit 压缩格式，每3字节编码2个12-bit样本
 */
export function decodeEEG(base64Data: string): number[] {
  try {
    const buffer = Buffer.from(base64Data, 'base64');
    const samples: number[] = [];

    // Muse BLE 数据协议规范：头 2 个字节为 Packet Sequence Number。
    // EEG 数据载荷强制从 index 2 开始进行 12-bit 拆解。
    for (let i = 2; i < buffer.length - 2; i += 3) {
      const byte1 = buffer[i];
      const byte2 = buffer[i + 1];
      const byte3 = buffer[i + 2];

      // 解码第一个 12-bit 样本
      const sample1 = ((byte1 << 4) | (byte2 >> 4)) & 0xFFF;
      // 解码第二个 12-bit 样本
      const sample2 = (((byte2 & 0x0F) << 8) | byte3) & 0xFFF;

      // 转换为有符号值并缩放到 μV
      const voltage1 = (sample1 > 2047 ? sample1 - 4096 : sample1) * 0.48828125;
      const voltage2 = (sample2 > 2047 ? sample2 - 4096 : sample2) * 0.48828125;

      samples.push(voltage1, voltage2);
    }

    return samples;
  } catch (e) {
    console.warn('EEG 解码失败:', e);
    return [];
  }
}

/**
 * 分析频域特征（Theta 和 Alpha 波段能量）
 */
export function analyzeFrequency(samples: number[]): { theta: number; alpha: number } {
  if (samples.length < 16) {
    return { theta: 0, alpha: 0 };
  }

  try {
    // 使用最近的 2^n 个样本进行 FFT
    const fftSize = Math.pow(2, Math.floor(Math.log2(samples.length)));
    const fft = new FFT(fftSize);
    const input = samples.slice(0, fftSize);

    // 归一化输入
    const mean = input.reduce((a, b) => a + b, 0) / input.length;
    const normalized = input.map(v => v - mean);

    const out = fft.createComplexArray();
    fft.realTransform(out, normalized);

    // 计算功率谱
    const power: number[] = [];
    for (let i = 0; i < out.length / 2; i += 2) {
      const real = out[i];
      const imag = out[i + 1];
      power.push(Math.sqrt(real * real + imag * imag));
    }

    // 假设采样率 256Hz，计算频段索引
    const samplingRate = 256;
    const freqResolution = samplingRate / fftSize;

    // Theta: 4-8 Hz
    const thetaStart = Math.floor(4 / freqResolution);
    const thetaEnd = Math.ceil(8 / freqResolution);
    const thetaEnergy = power.slice(thetaStart, thetaEnd).reduce((a, b) => a + b, 0);

    // Alpha: 8-13 Hz
    const alphaStart = Math.floor(8 / freqResolution);
    const alphaEnd = Math.ceil(13 / freqResolution);
    const alphaEnergy = power.slice(alphaStart, alphaEnd).reduce((a, b) => a + b, 0);

    return { theta: thetaEnergy, alpha: alphaEnergy };
  } catch (e) {
    console.warn('频域分析失败:', e);
    return { theta: 0, alpha: 0 };
  }
}

/**
 * 基于频段（波段）的信号质量评分
 * 
 * 核心原理：真正的 EEG 脑电信号集中在 1-30Hz 的频段中
 *   - Delta (1-4Hz): 深睡眠
 *   - Theta (4-8Hz): 浅睡眠、冥想
 *   - Alpha (8-13Hz): 放松闭眼
 *   - Beta  (13-30Hz): 清醒活动
 * 
 * 如果这些频段有明显的能量，而高频噪声 (>30Hz) 占比不高，
 * 就说明信号是好的。
 */
export function calculateSignalQuality(samples: number[]): number {
  if (samples.length < 128) {
    return 50; // 数据不足时给中间分
  }

  try {
    const fftSize = Math.min(256, Math.pow(2, Math.floor(Math.log2(samples.length))));
    const fft = new FFT(fftSize);
    const input = samples.slice(-fftSize);

    // 去除直流偏置
    const mean = input.reduce((a: number, b: number) => a + b, 0) / input.length;
    const normalized = input.map((v: number) => v - mean);

    // 死信号检测：RMS < 0.5µV → 悬空
    let sumSq = 0;
    for (const v of normalized) sumSq += v * v;
    if (Math.sqrt(sumSq / fftSize) < 0.5) return 0;

    // FFT
    const out = fft.createComplexArray();
    fft.realTransform(out, normalized);

    const samplingRate = 256;
    const freqRes = samplingRate / fftSize;

    let brainPower = 0;  // 1-30Hz 脑电频段
    let totalPower = 0;

    for (let bin = 0; bin < out.length / 2; bin += 2) {
      const freq = (bin / 2) * freqRes;
      if (freq < 1) continue;
      const p = out[bin] * out[bin] + out[bin + 1] * out[bin + 1];
      totalPower += p;
      if (freq >= 1 && freq <= 30) brainPower += p;
    }

    if (totalPower < 0.001) return 0;

    // 脑电波段能量占比
    const brainRatio = brainPower / totalPower;

    // brainRatio >= 0.6 → 100分, <= 0.15 → 0分
    let score: number;
    if (brainRatio >= 0.6) score = 100;
    else if (brainRatio <= 0.15) score = 0;
    else score = ((brainRatio - 0.15) / 0.45) * 100;

    return Math.max(0, Math.min(100, Math.round(score)));
  } catch (e) {
    return 50;
  }
}